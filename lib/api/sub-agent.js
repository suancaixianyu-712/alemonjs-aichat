import { randomUUID } from 'node:crypto';
import OpenAi from 'openai';
import { Mention, Text, MessageDirect, ResultCode } from 'alemonjs';
import redisClient from '../config.js';
import { getAiChatConfigValue } from '../config/app.js';
import { getOpenAIProxyFetch } from './openaiProxy.js';
import { PROCESS_INSTANCE_ID } from './runtime-instance.js';
import { buildUserPermissionPrompt } from './user-permission.js';
import { requestRapiCompletion } from '../response/zreply/rapi.js';
import { createSubAgentDelivery, createOriginOutput } from './sub-agent-delivery.js';
import { bindOwnerPrivateToolCall } from './owner-private.js';
import { createSubAgentProgress } from './sub-agent-progress.js';
import { getDeepThoughtReasoning } from './deep-thought.js';

const SUB_AGENT_MAX_ROUNDS = 40;
const SUB_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const SUB_AGENT_TASK_MAX_LENGTH = 8000;
const SUB_AGENT_CONTEXT_MAX_LENGTH = 4000;
const SUB_AGENT_TOOL_CONTENT_MAX = 16000;
const SUB_AGENT_RESULT_MAX = 16000;
const SUB_AGENT_MAX_PER_GUID = 3;
const SUB_AGENT_MAX_GLOBAL = 8;
const SUB_AGENT_MAX_LIST = 20;
const SUB_AGENT_RECORD_TTL_SECONDS = 48 * 60 * 60;
/** 需要真实活动事件绑定，或只能向主对话输出多媒体的工具，不进入子agent工具集 */
const SUB_AGENT_EXCLUDED_TOOLS = new Set([
    "SubAgent",
    "ManageCredentials",
    "ExecuteAlemonCommand",
    "XianyuGame",
    "SubscribeNextUserMessage",
    "GenerateSpeech",
    "MiniMaxVoice",
    "DsTtsSpeak",
    "DsTtsStatus",
    "ConvertToImageUrl",
    "StableDiffusionGenerateImage",
    "GrokGenerateImage",
    "GPTGenerateImage",
    "AIVideos",
]);
const liveRuns = new Map();
/** aitools 与本模块互相引用，运行时动态加载避免初始化顺序问题 */
let aitoolsModule = null;
const loadAitools = () => (aitoolsModule ??= import('./aitools.js'));
const taskKey = (id) => `ai:subagent:task:${id}`;
const indexKey = (guid) => `ai:subagent:index:${guid}`;
const cloneRecord = (record) => JSON.parse(JSON.stringify(record));
const saveRecord = async (record) => {
    await redisClient.redis.set(taskKey(record.id), JSON.stringify(cloneRecord(record)), "EX", SUB_AGENT_RECORD_TTL_SECONDS);
    await redisClient.redis.zadd(indexKey(record.guid), record.createdAt, record.id);
    await redisClient.redis.expire(indexKey(record.guid), SUB_AGENT_RECORD_TTL_SECONDS);
    // 每个会话最多保留 50 条历史记录
    await redisClient.redis.zremrangebyrank(indexKey(record.guid), 0, -51);
};
/** running 但已不在本进程运行，说明进程重启过，标记为中断 */
const reconcileRecord = (record) => {
    if (record.status === "running" && !liveRuns.has(record.id)) {
        record.status = "failed";
        record.finishedAt = record.finishedAt || Date.now();
        record.error = "进程重启，任务已中断";
        void saveRecord(record).catch(() => undefined);
    }
    return record;
};
const parseRecord = (raw, guid) => {
    try {
        const record = JSON.parse(raw);
        if (guid && record.guid !== guid)
            return null;
        return record;
    }
    catch {
        return null;
    }
};
const loadRecord = async (guid, id) => {
    const raw = await redisClient.redis.get(taskKey(id));
    if (!raw)
        return null;
    const record = parseRecord(raw, guid);
    return record ? reconcileRecord(record) : null;
};
const listRecords = async (guid) => {
    const ids = await redisClient.redis.zrevrange(indexKey(guid), 0, SUB_AGENT_MAX_LIST - 1);
    if (!ids.length)
        return [];
    const rawList = await redisClient.redis.mget(...ids.map(taskKey));
    const records = [];
    for (const raw of rawList) {
        if (!raw)
            continue;
        const record = parseRecord(raw, guid);
        if (record)
            records.push(reconcileRecord(record));
    }
    return records.sort((left, right) => right.createdAt - left.createdAt);
};
const countRunning = async (guid) => {
    let total = 0;
    let inGuid = 0;
    for (const id of liveRuns.keys()) {
        const raw = await redisClient.redis.get(taskKey(id));
        if (!raw)
            continue;
        const record = parseRecord(raw);
        if (!record || record.status !== "running")
            continue;
        total += 1;
        inGuid += 1;
    }
    return { total, inGuid };
};
const pushActivity = (record, line) => {
    record.activity = [...record.activity, line].slice(-24);
};
const truncateText = (text, maxLength) => {
    const value = String(text || "").trim();
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, maxLength)}\n[内容过长已截断]`;
};
const buildSubAgentSystemPrompt = async (ctx) => {
    const agentEnabled = (await redisClient.getAgentSwitch(ctx.guid)) === "1";
    const opencodePermission = String((await redisClient.redis.get(`ai:third_party_tool:permission:${ctx.guid}`)) || "");
    const permissionPrompt = buildUserPermissionPrompt({
        isMaster: ctx.isMaster,
        isAdmin: false,
        isPrivate: ctx.isPrivate,
        agentEnabled,
        opencodeActive: false,
        opencodePermission: opencodePermission === "full"
            ? "full"
            : opencodePermission === "auto"
                ? "auto"
                : opencodePermission === "manual"
                    ? "manual"
                    : "readonly",
    });
    return `你是主AI派出的后台子agent，负责独立完成主AI交办的任务。系统会展示执行阶段、工具名与耗时，不展示工具参数或思考原文。最终报告会回传给主AI，并可能转告用户。

执行要求：
- 直接开始执行任务，不要问候、确认或闲聊
- 优先使用工具完成实际操作（检索、读写文件、执行命令、访问网页等）；工具权限与主会话一致
- 工具失败时可以调整方式重试，但同一失败不要重复超过2次；被权限或审核拒绝是最终拒绝，不要改写命令、换工具或拆步骤再试
- 无法继续时，仍然输出报告：说明原因和已获得的部分结果
- 完成任务后直接输出最终报告（不要再调用工具）：第一行给结论，然后列出关键细节（做了什么、改了哪些文件、发现了什么、还剩什么没做）
- 你就是执行任务的子agent，不存在再次派后台的步骤。不能把“已派后台执行”当作最终报告，没有执行检查时不能声称已查过
- 报告必须自包含、简洁、准确，包含必要的文件路径、命令和数据；禁止包含服务器凭据、密钥等敏感信息

${permissionPrompt}`;
};
/** 子agent内部的工具调用：复刻主对话派发的关键绑定和权限检查 */
const dispatchSubAgentToolCall = async (toolCall, ctx) => {
    const { availableTools, assertAgentToolAccess, assertGroupFullToolAccess, removePublicIpFromToolArguments, } = await loadAitools();
    const functionName = String(toolCall?.function?.name || "").trim();
    let functionArgs = {};
    try {
        functionArgs = toolCall?.function?.arguments
            ? JSON.parse(toolCall.function.arguments)
            : {};
    }
    catch {
        console.error("子agent工具参数解析失败（参数已隐藏）");
        functionArgs = {};
    }
    try {
        if ((await redisClient.getToolStatus(ctx.guid, functionName)) === "1") {
            return { ok: false, error: `工具被禁用：${functionName}` };
        }
        // 与主对话相同：完全访问群的非主人身份保留“仅主人”边界
        const event = { guid: ctx.guid, IsMaster: ctx.isMaster, name: ctx.isPrivate ? "private.message.create" : "message.create", UserId: ctx.userID, Platform: ctx.platform, __background: true };
        const groupFullAccess = await assertGroupFullToolAccess(event, functionName, functionArgs);
        const toolGuid = await assertAgentToolAccess(functionName, ctx.guid, functionArgs?.scope, ctx.isMaster, groupFullAccess, ctx.isPrivate);
        if (functionArgs && typeof functionArgs === "object") {
            functionArgs.isMaster = ctx.isMaster;
            functionArgs.groupFullAccess = groupFullAccess;
            functionArgs.guid = toolGuid;
            if (functionName === "RunServerCommand" ||
                groupFullAccess ||
                functionArgs.scope === "public" ||
                functionArgs.scope === "root") {
                functionArgs.reviewGuid = ctx.guid;
            }
        }
        await bindOwnerPrivateToolCall(event, functionName, functionArgs);
        removePublicIpFromToolArguments(functionName, functionArgs, ctx.isMaster);
        if (functionName === "ScheduleAITask" && functionArgs) {
            functionArgs.userID = ctx.userID;
            functionArgs.platform = ctx.platform;
            functionArgs.spaceId = ctx.spaceId;
            functionArgs.isPrivate = ctx.isPrivate;
        }
        if ((functionName === "RunOpencode" || functionName === "RunCodex") &&
            functionArgs) {
            functionArgs.userID = ctx.userID;
        }
        const functionToCall = availableTools[functionName];
        if (!functionToCall) {
            return { ok: false, error: `未找到函数：${functionName}` };
        }
        return await functionToCall(functionArgs);
    }
    catch (err) {
        console.error("子agent工具执行失败（参数与异常正文已隐藏）");
        return {
            ok: false,
            error: err?.message || String(err) || "工具执行失败",
        };
    }
};
const buildTaskUserContent = (record) => {
    const task = truncateText(record.task, SUB_AGENT_TASK_MAX_LENGTH);
    const context = record.context
        ? `\n\n补充上下文：\n${truncateText(record.context, SUB_AGENT_CONTEXT_MAX_LENGTH)}`
        : "";
    return `主AI交办的任务：\n${task}${context}`;
};
const sendSubAgentDirect = async (target, payload) => {
    const direct = MessageDirect.create();
    const result = target.isPrivate
        ? await direct.sendToUser({ OpenID: target.userID, format: payload })
        : await direct.sendToChannel({
            SpaceId: String(target.spaceId || ""), format: payload,
            ...(target.replyId ? { replyId: target.replyId } : {}),
        });
    const results = Array.isArray(result) ? result : [result];
    if (!results.some((item) => item?.code === ResultCode.Ok))
        throw new Error("后台任务消息发送失败");
    return result;
};
/** 结果回传：完成时防抖合并后由主 AI 起一轮回复；失败/取消只发短通知 */
const subAgentDelivery = createSubAgentDelivery({
    startTurn: async (event, output) => {
        const { CApiReply } = await import('../response/zreply/capi.js');
        return CApiReply(event, output);
    },
    getActiveTurn: (guid, platform) => redisClient.getAIToolLoopState(guid, platform),
    addGuidance: (guid, data, platform) => redisClient.addAIGuidanceMessage(guid, data, platform),
    addHistory: (guid, message) => redisClient.addAIChatHistory(guid, message),
    sendDirect: sendSubAgentDirect,
    text: (value) => Text(value),
    mention: (userID) => Mention(userID),
});
const deliverSubAgentResult = async (record) => {
    const { removePublicIpFromOutput } = await loadAitools();
    const hide = (text) => text ? removePublicIpFromOutput(text, record.isMaster) : text;
    // 完整结果只保留在子agent记录里；回传内容会在投递模块里截断。不等待防抖窗口
    void subAgentDelivery
        .deliver({ ...record, result: hide(record.result), error: hide(record.error) })
        .catch((error) => console.error("子agent结果回传失败：", error));
};
/** 子agent执行主循环：独立的多轮工具调用会话 */
const runSubAgentLoop = async (record, ctx) => {
    let settled = false;
    const output = createOriginOutput(record, { sendDirect: sendSubAgentDirect, text: Text, mention: Mention });
    const progress = createSubAgentProgress({
        id: record.id,
        notify: record.notify,
        send: (text) => output.sendText(text),
        log: (text) => console.info(text),
        onActivity: (text) => pushActivity(record, text),
    });
    const reportProgress = async (event) => {
        progress.emit(event);
        await saveRecord(record).catch(() => undefined);
    };
    progress.emit({ type: "started" });
    const finish = async (patch) => {
        if (settled)
            return;
        settled = true;
        Object.assign(record, patch);
        record.finishedAt = Date.now();
        liveRuns.delete(record.id);
        progress.emit({ type: record.status === "running" ? "failed" : record.status });
        await saveRecord(record).catch(() => undefined);
        await progress.finish(record.status === "running" ? "failed" : record.status);
        // 进度层已发失败/取消状态，回传层继续保留记录，避免重复通知。
        await deliverSubAgentResult({ ...record, notify: record.status === "completed" && record.notify });
    };
    try {
        const { tools } = await loadAitools();
        const signal = liveRuns.get(record.id)?.controller.signal;
        const aiConfig = await redisClient.getAIConfig(ctx.guid);
        if (!aiConfig?.host?.trim() ||
            !aiConfig?.key?.trim() ||
            !aiConfig?.model?.trim()) {
            await finish({
                status: "failed",
                error: "当前会话未配置有效的 AI，无法启动子agent",
            });
            return;
        }
        const toolDefs = [];
        for (const tool of tools) {
            const name = String(tool?.function?.name || "");
            if (tool?.type !== "function" ||
                !name ||
                SUB_AGENT_EXCLUDED_TOOLS.has(name)) {
                continue;
            }
            if ((await redisClient.getToolStatus(ctx.guid, name)) === "1")
                continue;
            toolDefs.push(tool);
        }
        const openai = new OpenAi({
            baseURL: aiConfig.host,
            apiKey: aiConfig.key,
            timeout: 300000,
            fetch: getOpenAIProxyFetch(getAiChatConfigValue().httpProxy, await redisClient.isToolProxyEnabled(aiConfig)),
        });
        const messages = [
            { role: "system", content: await buildSubAgentSystemPrompt(ctx) },
            { role: "user", content: buildTaskUserContent(record) },
        ];
        const deepThoughtEffort = await redisClient.getDeepThoughtEffort(ctx.guid);
        let nudged = false;
        let executedTools = 0;
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
            await reportProgress({ type: "thinking", round });
            const params = { model: aiConfig.model, messages, ...getDeepThoughtReasoning({ config: aiConfig, deepThoughtEffort }) };
            if (toolDefs.length) {
                params.tools = toolDefs;
                params.tool_choice = "auto";
            }
            const completion = aiConfig.apiMode === "rapi"
                ? await requestRapiCompletion({
                    client: openai,
                    params,
                    signal: signal ?? new AbortController().signal,
                })
                : await openai.chat.completions.create(params, {
                    signal: signal,
                });
            const choice = completion?.choices?.[0]?.message;
            if (!choice) {
                await finish({ status: "failed", error: "AI 未返回内容" });
                return;
            }
            const assistantMessage = {
                role: "assistant",
                content: choice.content ?? "",
            };
            if (Array.isArray(choice.tool_calls) && choice.tool_calls.length) {
                assistantMessage.tool_calls = choice.tool_calls;
            }
            if (Array.isArray(choice._rapiOutput))
                assistantMessage._rapiOutput = choice._rapiOutput;
            messages.push(assistantMessage);
            if (!assistantMessage.tool_calls) {
                const report = String(assistantMessage.content || "").trim();
                const noReport = !report || /^(?:\[\]|NO_ACTION)$/i.test(report);
                const onlyAcknowledged = executedTools === 0 && /(?:已派|已交给|已转交|已安排|已提交).{0,12}(?:后台|子agent|子任务)/i.test(report);
                if ((noReport || onlyAcknowledged) && !nudged) {
                    nudged = true;
                    messages.push({
                        role: "user",
                        content: executedTools === 0 ? "你就是负责执行任务的子agent，不能再次派后台或只回复开始。现在直接使用工具执行原任务，完成后报告实际结果；无法执行时明确说明原因。" : "请直接输出最终报告：第一行结论，然后列出关键细节。不要再调用工具。",
                    });
                    continue;
                }
                await finish({
                    status: !noReport && !onlyAcknowledged ? "completed" : "failed",
                    result: !noReport && !onlyAcknowledged
                        ? truncateText(report, SUB_AGENT_RESULT_MAX)
                        : undefined,
                    error: onlyAcknowledged ? "子agent未执行任务，仅返回后台派遣话术" : noReport ? "子agent未生成报告" : undefined,
                });
                return;
            }
            for (const toolCall of assistantMessage.tool_calls) {
                if (signal?.aborted)
                    break;
                const name = String(toolCall?.function?.name || "未知工具");
                const displayName = toolDefs.some((tool) => tool.function?.name === name) ? name : "未知工具";
                await reportProgress({ type: "tool_start", round, tool: displayName });
                const toolStartedAt = Date.now();
                const result = await dispatchSubAgentToolCall(toolCall, ctx);
                executedTools += 1;
                await reportProgress({ type: "tool_finish", round, tool: displayName, durationMs: Date.now() - toolStartedAt,
                    success: result?.ok !== false && result?.success !== false && result?.allowed !== false && result?.permissionDenied !== true && !result?.error });
                const content = truncateText(JSON.stringify(result ?? { ok: true, result: null }), SUB_AGENT_TOOL_CONTENT_MAX);
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
    }
    catch (error) {
        const aborted = liveRuns.get(record.id)?.controller.signal?.aborted;
        if (aborted) {
            await finish({ status: "cancelled", error: "任务已被手动取消" });
            return;
        }
        await finish({
            status: "failed",
            error: error?.message || String(error) || "任务执行失败",
        });
    }
};
/** 派遣后台子agent任务，立即返回任务记录 */
const spawnSubAgent = async (ctx, input) => {
    const running = await countRunning();
    if (running.inGuid >= SUB_AGENT_MAX_PER_GUID) {
        throw new Error(`当前会话已有 ${running.inGuid} 个运行中的子任务（上限${SUB_AGENT_MAX_PER_GUID}），请先用 action=status 查看、action=cancel 关闭部分任务`);
    }
    if (running.total >= SUB_AGENT_MAX_GLOBAL) {
        throw new Error(`全局运行中的子任务已达上限（${SUB_AGENT_MAX_GLOBAL}），请稍后再试`);
    }
    const now = Date.now();
    const record = {
        id: `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        guid: ctx.guid,
        userID: ctx.userID,
        platform: ctx.platform,
        spaceId: ctx.spaceId,
        messageId: ctx.messageId,
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
const cancelSubAgent = async (guid, taskID) => {
    const record = await loadRecord(guid, taskID);
    if (!record)
        return { found: false, cancelled: false };
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
const formatDuration = (from, to) => {
    const seconds = Math.max(1, Math.round(((to || Date.now()) - from) / 1000));
    if (seconds < 60)
        return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}分${seconds % 60}秒`;
};
const toStatusSummary = (record) => ({
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
const getSubAgentStatus = async (guid, taskID) => {
    if (taskID) {
        const record = await loadRecord(guid, taskID);
        if (!record)
            return { success: false, error: `未找到子任务 ${taskID}` };
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
const getSubAgentResult = async (guid, taskID) => {
    const record = await loadRecord(guid, taskID);
    if (!record)
        return { success: false, error: `未找到子任务 ${taskID}` };
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
const runSubAgentTool = async (args) => {
    const guid = String(args?.guid || "").trim();
    if (!guid) {
        return { success: false, error: "缺少会话信息，无法操作子agent任务" };
    }
    const action = args.action || "spawn";
    const ctx = {
        guid,
        userID: String(args.userID || ""),
        platform: args.platform,
        spaceId: args.spaceId,
        messageId: args.messageId ? String(args.messageId) : undefined,
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
            message: `子agent已启动（taskID:${record.id}）。${record.notify ? "执行进度会自动发送到本对话，长时间等待也会报告状态。" : "执行进度只记录终端日志。"}完成结果会主动送达，无需用户追问。可用 action=status 查看、action=cancel 随时关闭。你现在可以继续回复用户。`,
        };
    }
    catch (error) {
        return { success: false, error: error?.message || String(error) };
    }
};

export { cancelSubAgent, getSubAgentResult, getSubAgentStatus, runSubAgentTool, spawnSubAgent };
