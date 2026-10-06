import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { MessageDirect, Text, format } from "alemonjs";
import redisClient from "@src/config";
import { getAiChatConfigValue } from "@src/config/app";
import { getOpenAIProxyFetch } from "./openaiProxy";
import { PROCESS_INSTANCE_ID } from "./runtime-instance";
import { buildUserPermissionPrompt } from "./user-permission";
import { requestRapiCompletion } from "@src/response/zreply/rapi";

/**
 * 后台子agent：主 AI 通过 SubAgent 工具把耗时任务派给独立的后台会话执行，
 * 不占用主对话的上下文和工具调用轮次。子agent 使用当前会话的 AI 配置和
 * 同一套工具（去掉需要活动事件绑定或只能向主对话输出内容的工具），
 * 权限与主会话一致。
 */

export type SubAgentStatus = "running" | "completed" | "failed" | "cancelled";

export type SubAgentRecord = {
  id: string;
  guid: string;
  userID: string;
  platform?: string;
  spaceId?: string;
  isPrivate: boolean;
  isMaster: boolean;
  task: string;
  context?: string;
  notify: boolean;
  status: SubAgentStatus;
  createdAt: number;
  startedAt: number;
  finishedAt?: number;
  rounds: number;
  result?: string;
  error?: string;
  activity: string[];
  ownerInstance: string;
};

export type SubAgentContext = {
  guid: string;
  userID: string;
  platform?: string;
  spaceId?: string;
  isPrivate: boolean;
  isMaster: boolean;
};

const SUB_AGENT_MAX_ROUNDS = 40;
const SUB_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const SUB_AGENT_TASK_MAX_LENGTH = 8000;
const SUB_AGENT_CONTEXT_MAX_LENGTH = 4000;
const SUB_AGENT_TOOL_CONTENT_MAX = 16000;
const SUB_AGENT_RESULT_MAX = 16000;
const SUB_AGENT_HISTORY_NOTE_MAX = 4000;
const SUB_AGENT_NOTIFY_MAX = 1200;
const SUB_AGENT_ACTIVITY_MAX = 24;
const SUB_AGENT_MAX_PER_GUID = 3;
const SUB_AGENT_MAX_GLOBAL = 8;
const SUB_AGENT_MAX_LIST = 20;
const SUB_AGENT_RECORD_TTL_SECONDS = 48 * 60 * 60;

/** 需要真实活动事件绑定，或只能向主对话输出多媒体的工具，不进入子agent工具集 */
const SUB_AGENT_EXCLUDED_TOOLS = new Set([
  "SubAgent",
  "ExecuteAlemonCommand",
  "XianyuGame",
  "SubscribeNextUserMessage",
  "GenerateSpeech",
  "MiniMaxVoice",
  "ConvertToImageUrl",
  "StableDiffusionGenerateImage",
  "GrokGenerateImage",
  "GPTGenerateImage",
  "AIVideos",
]);

type LiveRun = { controller: AbortController };
const liveRuns = new Map<string, LiveRun>();

/** aitools 与本模块互相引用，运行时动态加载避免初始化顺序问题 */
let aitoolsModule: Promise<typeof import("./aitools")> | null = null;
const loadAitools = () => (aitoolsModule ??= import("./aitools"));

const taskKey = (id: string) => `ai:subagent:task:${id}`;
const indexKey = (guid: string) => `ai:subagent:index:${guid}`;

const cloneRecord = (record: SubAgentRecord): SubAgentRecord =>
  JSON.parse(JSON.stringify(record));

const saveRecord = async (record: SubAgentRecord) => {
  await redisClient.redis.set(
    taskKey(record.id),
    JSON.stringify(cloneRecord(record)),
    "EX",
    SUB_AGENT_RECORD_TTL_SECONDS,
  );
  await redisClient.redis.zadd(indexKey(record.guid), record.createdAt, record.id);
  await redisClient.redis.expire(
    indexKey(record.guid),
    SUB_AGENT_RECORD_TTL_SECONDS,
  );
  // 每个会话最多保留 50 条历史记录
  await redisClient.redis.zremrangebyrank(indexKey(record.guid), 0, -51);
};

/** running 但已不在本进程运行，说明进程重启过，标记为中断 */
const reconcileRecord = (record: SubAgentRecord) => {
  if (record.status === "running" && !liveRuns.has(record.id)) {
    record.status = "failed";
    record.finishedAt = record.finishedAt || Date.now();
    record.error = "进程重启，任务已中断";
    void saveRecord(record).catch(() => undefined);
  }
  return record;
};

const parseRecord = (raw: string, guid?: string) => {
  try {
    const record = JSON.parse(raw) as SubAgentRecord;
    if (guid && record.guid !== guid) return null;
    return record;
  } catch {
    return null;
  }
};

const loadRecord = async (
  guid: string,
  id: string,
): Promise<SubAgentRecord | null> => {
  const raw = await redisClient.redis.get(taskKey(id));
  if (!raw) return null;
  const record = parseRecord(raw, guid);
  return record ? reconcileRecord(record) : null;
};

const listRecords = async (guid: string): Promise<SubAgentRecord[]> => {
  const ids = await redisClient.redis.zrevrange(
    indexKey(guid),
    0,
    SUB_AGENT_MAX_LIST - 1,
  );
  if (!ids.length) return [];
  const rawList = await redisClient.redis.mget(...ids.map(taskKey));
  const records: SubAgentRecord[] = [];
  for (const raw of rawList) {
    if (!raw) continue;
    const record = parseRecord(raw, guid);
    if (record) records.push(reconcileRecord(record));
  }
  return records.sort((left, right) => right.createdAt - left.createdAt);
};

const countRunning = async (guid?: string) => {
  let total = 0;
  let inGuid = 0;
  for (const id of liveRuns.keys()) {
    const raw = await redisClient.redis.get(taskKey(id));
    if (!raw) continue;
    const record = parseRecord(raw);
    if (!record || record.status !== "running") continue;
    total += 1;
    if (!guid || record.guid === guid) inGuid += 1;
  }
  return { total, inGuid };
};

const pushActivity = (record: SubAgentRecord, line: string) => {
  record.activity = [...record.activity, line].slice(-SUB_AGENT_ACTIVITY_MAX);
};

const truncateText = (text: string, maxLength: number) => {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[内容过长已截断]`;
};

const buildSubAgentSystemPrompt = async (ctx: SubAgentContext) => {
  const agentEnabled = (await redisClient.getAgentSwitch(ctx.guid)) === "1";
  const opencodePermission = String(
    (await redisClient.redis.get(
      `ai:third_party_tool:permission:${ctx.guid}`,
    )) || "",
  );
  const permissionPrompt = buildUserPermissionPrompt({
    isMaster: ctx.isMaster,
    isAdmin: false,
    isPrivate: ctx.isPrivate,
    agentEnabled,
    opencodeActive: false,
    opencodePermission:
      opencodePermission === "full"
        ? "full"
        : opencodePermission === "auto"
          ? "auto"
          : opencodePermission === "manual"
            ? "manual"
            : "readonly",
  });
  return `你是主AI派出的后台子agent，负责独立完成主AI交办的任务。你的执行过程不会展示给用户，最终报告会回传给主AI，并可能转告用户。

执行要求：
- 直接开始执行任务，不要问候、确认或闲聊
- 优先使用工具完成实际操作（检索、读写文件、执行命令、访问网页等）；工具权限与主会话一致
- 工具失败时可以调整方式重试，但同一失败不要重复超过2次；被权限或审核拒绝是最终拒绝，不要改写命令、换工具或拆步骤再试
- 无法继续时，仍然输出报告：说明原因和已获得的部分结果
- 完成任务后直接输出最终报告（不要再调用工具）：第一行给结论，然后列出关键细节（做了什么、改了哪些文件、发现了什么、还剩什么没做）
- 报告必须自包含、简洁、准确，包含必要的文件路径、命令和数据；禁止包含服务器凭据、密钥等敏感信息

${permissionPrompt}`;
};

/** 子agent内部的工具调用：复刻主对话派发的关键绑定和权限检查 */
const dispatchSubAgentToolCall = async (
  toolCall: any,
  ctx: SubAgentContext,
): Promise<any> => {
  const {
    availableTools,
    assertAgentToolAccess,
    assertGroupFullToolAccess,
    removePublicIpFromToolArguments,
  } = await loadAitools();
  const functionName = String(toolCall?.function?.name || "").trim();
  let functionArgs: any = {};
  try {
    functionArgs = toolCall?.function?.arguments
      ? JSON.parse(toolCall.function.arguments)
      : {};
  } catch (err) {
    console.error(`子agent工具参数解析失败：${functionName}`, err);
    functionArgs = {};
  }

  try {
    if ((await redisClient.getToolStatus(ctx.guid, functionName)) === "1") {
      return { ok: false, error: `工具被禁用：${functionName}` };
    }
    // 与主对话相同：完全访问群的非主人身份保留“仅主人”边界
    const event = { guid: ctx.guid, IsMaster: ctx.isMaster };
    const groupFullAccess = await assertGroupFullToolAccess(
      event,
      functionName,
      functionArgs,
    );
    const toolGuid = await assertAgentToolAccess(
      functionName,
      ctx.guid,
      functionArgs?.scope,
      ctx.isMaster,
      groupFullAccess,
    );
    if (functionArgs && typeof functionArgs === "object") {
      functionArgs.isMaster = ctx.isMaster;
      functionArgs.groupFullAccess = groupFullAccess;
      functionArgs.guid = toolGuid;
      if (
        functionName === "RunServerCommand" ||
        groupFullAccess ||
        functionArgs.scope === "public" ||
        functionArgs.scope === "root"
      ) {
        functionArgs.reviewGuid = ctx.guid;
      }
    }
    removePublicIpFromToolArguments(functionName, functionArgs, ctx.isMaster);
    if (functionName === "ScheduleAITask" && functionArgs) {
      functionArgs.userID = ctx.userID;
      functionArgs.platform = ctx.platform;
      functionArgs.spaceId = ctx.spaceId;
      functionArgs.isPrivate = ctx.isPrivate;
    }
    if (
      (functionName === "RunOpencode" || functionName === "RunCodex") &&
      functionArgs
    ) {
      functionArgs.userID = ctx.userID;
    }

    const functionToCall = availableTools[functionName];
    if (!functionToCall) {
      return { ok: false, error: `未找到函数：${functionName}` };
    }
    return await functionToCall(functionArgs);
  } catch (err: any) {
    console.error(`子agent工具执行失败：${functionName}`, err);
    return {
      ok: false,
      error: err?.message || String(err) || "工具执行失败",
    };
  }
};

const buildTaskUserContent = (record: SubAgentRecord) => {
  const task = truncateText(record.task, SUB_AGENT_TASK_MAX_LENGTH);
  const context = record.context
    ? `\n\n补充上下文：\n${truncateText(record.context, SUB_AGENT_CONTEXT_MAX_LENGTH)}`
    : "";
  return `主AI交办的任务：\n${task}${context}`;
};

/** 任务结束后：按需向会话发通知，并把结果报告投递回主对话 */
const deliverSubAgentResult = async (record: SubAgentRecord) => {
  const statusLabel =
    record.status === "completed"
      ? "已完成"
      : record.status === "cancelled"
        ? "已取消"
        : "失败";
  const body = record.result || record.error || "（无内容）";

  if (record.notify && (record.isPrivate ? record.userID : record.spaceId)) {
    try {
      const { removePublicIpFromOutput } = await loadAitools();
      const notifyText = removePublicIpFromOutput(
        truncateText(
          `🤖 后台子任务 ${record.id} ${statusLabel}\n任务：${truncateText(record.task, 120)}\n\n${body}`,
          SUB_AGENT_NOTIFY_MAX,
        ),
        record.isMaster,
      );
      const direct = MessageDirect.create();
      const payload = format(Text(notifyText));
      if (record.isPrivate) {
        await direct.sendToUser({ OpenID: record.userID, format: payload });
      } else {
        await direct.sendToChannel({
          SpaceId: String(record.spaceId || ""),
          format: payload,
        });
      }
    } catch (error) {
      console.error("子agent完成通知发送失败：", error);
    }
  }

  try {
    const { removePublicIpFromOutput } = await loadAitools();
    const reportText = removePublicIpFromOutput(body, record.isMaster);
    const note = truncateText(
      [
        `【后台子任务报告:${record.id}】状态：${statusLabel}`,
        `任务：${truncateText(record.task, 600)}`,
        `结果：\n${reportText}`,
        "这是后台子agent执行完毕后自动写回的报告，用户可能已收到完成通知。如需更多细节可调用 SubAgent action=result 查看。",
      ].join("\n"),
      SUB_AGENT_HISTORY_NOTE_MAX,
    );
    // 主对话正在工具循环中时走 guidance 队列，由主对话自己择机合并，
    // 避免两个写入方并发改写同一份聊天历史。
    const activeTurn = await redisClient.getAIToolLoopState(
      record.guid,
      record.platform,
    );
    if (activeTurn) {
      await redisClient.addAIGuidanceMessage(
        record.guid,
        {
          guidance: true,
          capiMessage: {
            role: "user",
            content: note,
          },
          createdAt: Date.now(),
          previewText: `后台子任务${statusLabel}:${truncateText(record.task, 60)}`,
        },
        record.platform,
      );
      return;
    }
    await redisClient.addAIChatHistory(record.guid, {
      role: "system",
      content: note,
    });
  } catch (error) {
    console.error("子agent结果写回对话历史失败：", error);
  }
};

/** 子agent执行主循环：独立的多轮工具调用会话 */
const runSubAgentLoop = async (
  record: SubAgentRecord,
  ctx: SubAgentContext,
) => {
  let settled = false;
  const finish = async (patch: Partial<SubAgentRecord>) => {
    if (settled) return;
    settled = true;
    Object.assign(record, patch);
    record.finishedAt = Date.now();
    liveRuns.delete(record.id);
    await saveRecord(record).catch(() => undefined);
    await deliverSubAgentResult(record);
  };

  try {
    const { tools } = await loadAitools();
    const signal = liveRuns.get(record.id)?.controller.signal;

    const aiConfig = await redisClient.getAIConfig(ctx.guid);
    if (
      !aiConfig?.host?.trim() ||
      !aiConfig?.key?.trim() ||
      !aiConfig?.model?.trim()
    ) {
      await finish({
        status: "failed",
        error: "当前会话未配置有效的 AI，无法启动子agent",
      });
      return;
    }

    const toolDefs: any[] = [];
    for (const tool of tools as any[]) {
      const name = String(tool?.function?.name || "");
      if (
        tool?.type !== "function" ||
        !name ||
        SUB_AGENT_EXCLUDED_TOOLS.has(name)
      ) {
        continue;
      }
      if ((await redisClient.getToolStatus(ctx.guid, name)) === "1") continue;
      toolDefs.push(tool);
    }

    const openai = new OpenAI({
      baseURL: aiConfig.host,
      apiKey: aiConfig.key,
      timeout: 300000,
      fetch: getOpenAIProxyFetch(
        getAiChatConfigValue().httpProxy,
        await redisClient.isToolProxyEnabled(aiConfig),
      ),
    });

    const messages: any[] = [
      { role: "system", content: await buildSubAgentSystemPrompt(ctx) },
      { role: "user", content: buildTaskUserContent(record) },
    ];
    let nudged = false;

    for (let round = 1; round <= SUB_AGENT_MAX_ROUNDS; round += 1) {
      if (signal?.aborted) {
        await finish({ status: "cancelled", error: "任务已被手动取消" });
        return;
      }
      if (Date.now() - record.startedAt > SUB_AGENT_TIMEOUT_MS) {
        await finish({ status: "failed", error: "任务超时（超过30分钟）" });
        return;
      }

      record.rounds = round;
      const params: any = { model: aiConfig.model, messages };
      if (toolDefs.length) {
        params.tools = toolDefs;
        params.tool_choice = "auto";
      }
      const completion =
        aiConfig.apiMode === "rapi"
          ? await requestRapiCompletion({
              client: openai,
              params,
              signal: signal ?? new AbortController().signal,
            })
          : await openai.chat.completions.create(params, {
              signal: signal as any,
            });

      const choice = (completion as any)?.choices?.[0]?.message;
      if (!choice) {
        await finish({ status: "failed", error: "AI 未返回内容" });
        return;
      }

      const assistantMessage: any = {
        role: "assistant",
        content: choice.content ?? "",
      };
      if (Array.isArray(choice.tool_calls) && choice.tool_calls.length) {
        assistantMessage.tool_calls = choice.tool_calls;
      }
      messages.push(assistantMessage);

      if (!assistantMessage.tool_calls) {
        const report = String(assistantMessage.content || "").trim();
        if (!report && !nudged) {
          nudged = true;
          messages.push({
            role: "user",
            content:
              "请直接输出最终报告：第一行结论，然后列出关键细节。不要再调用工具。",
          });
          continue;
        }
        await finish({
          status: report ? "completed" : "failed",
          result: report
            ? truncateText(report, SUB_AGENT_RESULT_MAX)
            : undefined,
          error: report ? undefined : "子agent未生成报告",
        });
        return;
      }

      for (const toolCall of assistantMessage.tool_calls) {
        if (signal?.aborted) break;
        const name = String(toolCall?.function?.name || "未知工具");
        const argsDigest = truncateText(
          String(toolCall?.function?.arguments || "").replace(/\s+/g, " "),
          120,
        );
        pushActivity(record, `[第${round}轮] ${name}(${argsDigest})`);
        const result = await dispatchSubAgentToolCall(toolCall, ctx);
        const content = truncateText(
          JSON.stringify(result ?? { ok: true, result: null }),
          SUB_AGENT_TOOL_CONTENT_MAX,
        );
        messages.push({
          role: "tool",
          tool_call_id: String(toolCall?.id || ""),
          name,
          content,
        });
      }
      await saveRecord(record).catch(() => undefined);
    }

    await finish({
      status: "failed",
      error: `达到最大工具调用轮次（${SUB_AGENT_MAX_ROUNDS}轮）仍未完成`,
    });
  } catch (error: any) {
    const aborted = liveRuns.get(record.id)?.controller.signal?.aborted;
    if (aborted) {
      await finish({ status: "cancelled", error: "任务已被手动取消" });
      return;
    }
    console.error(`子agent任务执行失败：${record.id}`, error);
    await finish({
      status: "failed",
      error: error?.message || String(error) || "任务执行失败",
    });
  }
};

/** 派遣后台子agent任务，立即返回任务记录 */
export const spawnSubAgent = async (
  ctx: SubAgentContext,
  input: { task: string; context?: string; notify?: boolean },
): Promise<SubAgentRecord> => {
  const running = await countRunning();
  if (running.inGuid >= SUB_AGENT_MAX_PER_GUID) {
    throw new Error(
      `当前会话已有 ${running.inGuid} 个运行中的子任务（上限${SUB_AGENT_MAX_PER_GUID}），请先用 action=status 查看、action=cancel 关闭部分任务`,
    );
  }
  if (running.total >= SUB_AGENT_MAX_GLOBAL) {
    throw new Error(
      `全局运行中的子任务已达上限（${SUB_AGENT_MAX_GLOBAL}），请稍后再试`,
    );
  }

  const now = Date.now();
  const record: SubAgentRecord = {
    id: `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    guid: ctx.guid,
    userID: ctx.userID,
    platform: ctx.platform,
    spaceId: ctx.spaceId,
    isPrivate: ctx.isPrivate,
    isMaster: ctx.isMaster,
    task: input.task.trim(),
    context: input.context?.trim() || undefined,
    notify: input.notify !== false,
    status: "running",
    createdAt: now,
    startedAt: now,
    rounds: 0,
    activity: [],
    ownerInstance: PROCESS_INSTANCE_ID,
  };

  liveRuns.set(record.id, { controller: new AbortController() });
  await saveRecord(record).catch((error) => {
    liveRuns.delete(record.id);
    throw error;
  });
  void runSubAgentLoop(record, ctx).catch(() => undefined);
  return record;
};

export const cancelSubAgent = async (guid: string, taskID: string) => {
  const record = await loadRecord(guid, taskID);
  if (!record) return { found: false, cancelled: false };
  if (record.status !== "running") {
    return { found: true, cancelled: false, status: record.status };
  }
  const liveRun = liveRuns.get(taskID);
  if (liveRun) {
    liveRun.controller.abort(new Error("任务已被手动取消"));
    return { found: true, cancelled: true };
  }
  // 不在本进程运行却仍是 running：直接标记取消
  record.status = "cancelled";
  record.finishedAt = Date.now();
  record.error = "任务已被手动取消";
  await saveRecord(record).catch(() => undefined);
  return { found: true, cancelled: true };
};

const formatDuration = (from: number, to?: number) => {
  const seconds = Math.max(1, Math.round(((to || Date.now()) - from) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分${seconds % 60}秒`;
};

const toStatusSummary = (record: SubAgentRecord) => ({
  id: record.id,
  status: record.status,
  task: truncateText(record.task, 120),
  rounds: record.rounds,
  createdAt: record.createdAt,
  elapsed: formatDuration(record.startedAt, record.finishedAt),
  notify: record.notify,
  ...(record.error ? { error: truncateText(record.error, 300) } : {}),
  ...(record.status === "running" && record.activity.length
    ? { recentActivity: record.activity.slice(-3) }
    : {}),
});

export const getSubAgentStatus = async (guid: string, taskID?: string) => {
  if (taskID) {
    const record = await loadRecord(guid, taskID);
    if (!record) return { success: false, error: `未找到子任务 ${taskID}` };
    return { success: true, task: toStatusSummary(record) };
  }
  const records = await listRecords(guid);
  if (!records.length) {
    return { success: true, message: "当前会话还没有子任务记录", tasks: [] };
  }
  return {
    success: true,
    running: records.filter((item) => item.status === "running").length,
    tasks: records.slice(0, SUB_AGENT_MAX_LIST).map(toStatusSummary),
  };
};

export const getSubAgentResult = async (guid: string, taskID: string) => {
  const record = await loadRecord(guid, taskID);
  if (!record) return { success: false, error: `未找到子任务 ${taskID}` };
  if (record.status === "running") {
    return {
      success: true,
      status: "running",
      rounds: record.rounds,
      elapsed: formatDuration(record.startedAt),
      message: "子任务仍在执行中，请稍后再用 action=result 获取结果",
      recentActivity: record.activity.slice(-5),
    };
  }
  return {
    success: true,
    status: record.status,
    rounds: record.rounds,
    elapsed: formatDuration(record.startedAt, record.finishedAt),
    ...(record.result ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
};

/** SubAgent 工具入口：spawn 派遣 / status 查看状态 / result 获取结果 / cancel 关闭 */
export const runSubAgentTool = async (args: {
  action?: "spawn" | "status" | "result" | "cancel";
  task?: string;
  context?: string;
  taskID?: string;
  notify?: boolean;
  guid?: string;
  userID?: string;
  platform?: string;
  spaceId?: string;
  isPrivate?: boolean;
  isMaster?: boolean;
}) => {
  const guid = String(args?.guid || "").trim();
  if (!guid) {
    return { success: false, error: "缺少会话信息，无法操作子agent任务" };
  }
  const action = args.action || "spawn";
  const ctx: SubAgentContext = {
    guid,
    userID: String(args.userID || ""),
    platform: args.platform,
    spaceId: args.spaceId,
    isPrivate: args.isPrivate === true,
    isMaster: args.isMaster === true,
  };

  if (action === "status") {
    return getSubAgentStatus(guid, args.taskID?.trim() || undefined);
  }

  if (action === "result") {
    const taskID = String(args.taskID || "").trim();
    if (!taskID) {
      return { success: false, error: "action=result 时必须提供 taskID" };
    }
    return getSubAgentResult(guid, taskID);
  }

  if (action === "cancel") {
    const taskID = String(args.taskID || "").trim();
    if (!taskID) {
      return { success: false, error: "action=cancel 时必须提供 taskID" };
    }
    const outcome = await cancelSubAgent(guid, taskID);
    if (!outcome.found) {
      return { success: false, error: `未找到子任务 ${taskID}` };
    }
    if (!outcome.cancelled) {
      return {
        success: true,
        taskID,
        message: `该任务已是结束状态（${outcome.status}），无需取消`,
      };
    }
    return {
      success: true,
      taskID,
      message: "已发送取消指令，子任务将停止执行",
    };
  }

  const task = String(args.task || "").trim();
  if (!task) {
    return {
      success: false,
      error: "action=spawn 时必须提供 task（任务描述）",
    };
  }
  if (task.length > SUB_AGENT_TASK_MAX_LENGTH) {
    return {
      success: false,
      error: `任务描述过长（上限${SUB_AGENT_TASK_MAX_LENGTH}字符）`,
    };
  }
  try {
    const record = await spawnSubAgent(ctx, {
      task,
      context: args.context,
      notify: args.notify,
    });
    return {
      success: true,
      taskID: record.id,
      notify: record.notify,
      message: `子agent已启动（taskID:${record.id}）。它会在后台自主执行任务，完成后结果会自动回传到本对话${record.notify ? "并通知会话" : ""}。期间可用 action=status 查看、action=cancel 随时关闭。你现在可以继续回复用户。`,
    };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
};
