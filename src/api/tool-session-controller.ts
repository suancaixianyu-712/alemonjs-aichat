import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import OpenAI from "openai";
import { getOpenAIProxyFetch } from "./openaiProxy";
import { getAiChatConfigValue } from "@src/config/app";
import redisClient from "@src/config";
import {
  buildToolMessageContent,
  hasToolMessageAttachments,
} from "@src/api/tool-message-content";
import { requestRapiCompletion } from "@src/response/zreply/rapi";
import { buildUserPermissionPrompt } from "@src/api/user-permission";
import {
  createOpencodeSession,
  ensureInheritedOpencodeServer,
  listOpencodeModels,
  listOpencodeSessions,
  sendOpencodeSessionMessage,
  updateOpencodeSessionPermission,
  type OpencodePermissionReply,
  type OpencodePermissionRequest,
  type OpencodePermissionRule,
} from "@src/api/opencode";

export type ThirdPartyToolName = "default" | "opencode";
export type ThirdPartyPermissionMode = "readonly" | "manual" | "auto" | "full";
export type ToolSelectionType = "tool" | "permission" | "session";

const CURRENT_TOOL_PREFIX = "ai:third_party_tool:current:";
const PERMISSION_PREFIX = "ai:third_party_tool:permission:";
const CURRENT_SESSION_PREFIX = "ai:third_party_tool:session:opencode:";
const CURRENT_SESSION_TITLE_PREFIX = "ai:third_party_tool:title:opencode:";
const CURRENT_MODEL_PREFIX = "ai:third_party_tool:model:opencode:";
const SELECTION_PREFIX = "ai:third_party_tool:selection:";
const SELECTION_TTL_SECONDS = 300;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PERMISSION_PREVIEW = 600;

const toolLabels: Record<ThirdPartyToolName, string> = {
  default: "默认",
  opencode: "opencode",
};

const permissionLabels: Record<ThirdPartyPermissionMode, string> = {
  readonly: "只读",
  manual: "手动确认",
  auto: "自动审核",
  full: "完全访问",
};

const toolAliases: Record<string, ThirdPartyToolName> = {
  default: "default",
  默认: "default",
  opencode: "opencode",
};

const permissionAliases: Record<string, ThirdPartyPermissionMode> = {
  readonly: "readonly",
  只读: "readonly",
  manual: "manual",
  手动确认: "manual",
  auto: "auto",
  自动审核: "auto",
  full: "full",
  完全访问: "full",
};

const permissionRules: Record<
  ThirdPartyPermissionMode,
  OpencodePermissionRule[]
> = {
  readonly: [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
  ],
  manual: [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "task", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
  ],
  auto: [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "task", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
  ],
  full: [{ permission: "*", pattern: "*", action: "allow" }],
};

type SendText = (text: string) => Promise<unknown>;

type PendingApproval = {
  request: OpencodePermissionRequest;
  resolve: (reply: OpencodePermissionReply) => void;
  timer: NodeJS.Timeout;
};

type QueuedStartupMessage = {
  event: any;
  send: SendText;
};

type ToolStartupState = {
  queue: QueuedStartupMessage[];
};

const pendingApprovals = new Map<string, PendingApproval>();
const messageChains = new Map<string, Promise<void>>();
const toolStartupStates = new Map<string, ToolStartupState>();

const assertGuid = (guid: string) => {
  const safeGuid = String(guid || "").trim();
  if (
    !safeGuid ||
    safeGuid === "." ||
    safeGuid === ".." ||
    path.isAbsolute(safeGuid) ||
    safeGuid.includes("/") ||
    safeGuid.includes("\\") ||
    safeGuid.includes("\0")
  ) {
    throw new Error("guid 只能作为 public 下的单级目录名");
  }
  return safeGuid;
};

export const resolveCurrentSessionDirectory = (
  guid: string,
  createIfMissing = false,
) => {
  const safeGuid = assertGuid(guid);
  const publicRoot = path.resolve(process.cwd(), "public");
  const target = path.resolve(publicRoot, safeGuid);
  const relative = path.relative(publicRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("当前会话路径超出 public 目录");
  }
  if (createIfMissing) fs.mkdirSync(target, { recursive: true });
  if (!fs.existsSync(target)) throw new Error("当前会话项目目录不存在");
  return fs.realpathSync.native(target);
};

const maskIpAddresses = (value: string) => {
  let text = String(value || "").replace(
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    (address) => (isIP(address) === 4 ? "***.***.***.***" : address),
  );
  text = text.replace(/[0-9a-f:]*:[0-9a-f:]+/gi, (address) =>
    isIP(address) === 6 ? "****:****:****:****" : address,
  );
  return text;
};

const redactPermissionPreview = (value: string) => {
  let text = maskIpAddresses(value);
  text = text.replace(
    /(^|[\s,{[])(["']?(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|authorization|cookie)["']?\s*[:=]\s*)([^\s,}\]\r\n]+)/gim,
    "$1$2[敏感信息已隐藏]",
  );
  if (text.length > MAX_PERMISSION_PREVIEW) {
    text = `${text.slice(0, MAX_PERMISSION_PREVIEW)}\n[内容过长已截断]`;
  }
  return text || "未提供具体内容";
};

const getPermissionContent = (request: OpencodePermissionRequest) => {
  const metadata = request.metadata || {};
  const candidates = [
    metadata.command,
    metadata.path,
    metadata.filepath,
    metadata.description,
    ...request.patterns,
  ]
    .filter((item) => item !== undefined && item !== null)
    .map((item) =>
      typeof item === "string" ? item : JSON.stringify(item, null, 2),
    );
  return redactPermissionPreview(
    candidates.length ? candidates.join("\n") : JSON.stringify(request.raw),
  );
};

const getSessionTime = (session: any) =>
  Number(session?.time?.updated || session?.time?.created || 0);

const normalizeSessions = (sessions: any[]) =>
  sessions
    .filter((session) => session?.id)
    .sort((left, right) => getSessionTime(right) - getSessionTime(left));

const extractReviewJSON = (content: string) => {
  const match = String(content || "").match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
};

const reviewPermissionWithCurrentAI = async (
  guid: string,
  request: OpencodePermissionRequest,
  permissionPrompt: string,
): Promise<OpencodePermissionReply> => {
  try {
    const config = await redisClient.getAIConfig(guid);
    if (!config.host?.trim() || !config.key?.trim() || !config.model?.trim()) {
      return "reject";
    }
    const client = new OpenAI({
      baseURL: config.host,
      apiKey: config.key,
      timeout: 120000,
      fetch: getOpenAIProxyFetch(
        getAiChatConfigValue().httpProxy,
        await redisClient.isToolProxyEnabled(config),
      ),
    });
    const params = {
      model: config.model,
      temperature: 0,
      max_tokens: 160,
      messages: [
        {
          role: "system",
          content:
            '你是 OpenCode 操作安全审核器。根据操作类型、完整参数、当前工作目录和当前用户权限判断是否允许本次操作。只有目标明确、风险可控，且没有超出当前用户权限时允许。涉及凭据窃取、破坏系统、持久化后门、越权外传或不相关目录时拒绝。拒绝是最终结果，调用方不能改写操作后再试。只输出 JSON：{"allowed":boolean,"reason":"简短原因"}。',
        },
        {
          role: "user",
          content: JSON.stringify({
            directory: resolveCurrentSessionDirectory(guid),
            permission: permissionPrompt,
            request: request.raw,
          }),
        },
      ],
    };
    const completion =
      config.apiMode === "rapi"
        ? await requestRapiCompletion({
            client,
            params,
            signal: new AbortController().signal,
          })
        : await client.chat.completions.create(params as any);
    const parsed = extractReviewJSON(
      String(completion?.choices?.[0]?.message?.content || ""),
    );
    return parsed?.allowed === true ? "once" : "reject";
  } catch {
    return "reject";
  }
};

const waitForManualApproval = async (
  guid: string,
  request: OpencodePermissionRequest,
  send: SendText,
) => {
  const previous = pendingApprovals.get(guid);
  if (previous) {
    clearTimeout(previous.timer);
    previous.resolve("reject");
  }
  await send(
    [
      "OpenCode 请求执行操作",
      "",
      `类型：${request.permission}`,
      `内容：${getPermissionContent(request)}`,
      "有效时间：5 分钟",
      "",
      "1. 本次允许",
      "2. 始终允许",
      "3. 拒绝",
      "请由主人回复序号。",
    ].join("\n"),
  );
  return await new Promise<OpencodePermissionReply>((resolve) => {
    const finish = (reply: OpencodePermissionReply) => {
      const current = pendingApprovals.get(guid);
      if (current?.request.id === request.id) {
        clearTimeout(current.timer);
        pendingApprovals.delete(guid);
      }
      resolve(reply);
    };
    const timer = setTimeout(() => finish("reject"), APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(guid, { request, resolve: finish, timer });
  });
};

const enqueueByGuid = async (guid: string, task: () => Promise<void>) => {
  const previous = messageChains.get(guid) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  messageChains.set(guid, current);
  try {
    await current;
  } finally {
    if (messageChains.get(guid) === current) messageChains.delete(guid);
  }
};

export class ToolSessionController {
  async getCurrentTool(guid: string): Promise<ThirdPartyToolName> {
    const value = await redisClient.redis.get(`${CURRENT_TOOL_PREFIX}${guid}`);
    return value === "opencode" ? "opencode" : "default";
  }

  async setCurrentTool(guid: string, tool: ThirdPartyToolName) {
    const current = await this.getCurrentTool(guid);
    const previousSession = await this.getCurrentSessionId(guid);
    const previousTitle =
      (await redisClient.redis.get(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`)) ||
      "";
    await redisClient.redis.set(`${CURRENT_TOOL_PREFIX}${guid}`, tool);
    if (tool === "default") return null;
    if (current === tool && previousSession) {
      return {
        id: previousSession,
        title: previousTitle || "新会话",
        created: false,
      };
    }
    if (current !== tool) {
      await redisClient.redis.del(`${CURRENT_SESSION_PREFIX}${guid}`);
      await redisClient.redis.del(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`);
    }
    try {
      const session = await this.createSession(guid);
      return { ...session, created: true };
    } catch (error) {
      await redisClient.redis.set(`${CURRENT_TOOL_PREFIX}${guid}`, current);
      if (previousSession) {
        await redisClient.redis.set(
          `${CURRENT_SESSION_PREFIX}${guid}`,
          previousSession,
        );
      } else {
        await redisClient.redis.del(`${CURRENT_SESSION_PREFIX}${guid}`);
      }
      if (previousTitle) {
        await redisClient.redis.set(
          `${CURRENT_SESSION_TITLE_PREFIX}${guid}`,
          previousTitle,
        );
      } else {
        await redisClient.redis.del(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`);
      }
      throw error;
    }
  }

  async switchToolWithFeedback(
    guid: string,
    tool: ThirdPartyToolName,
    send: SendText,
  ) {
    const startup = toolStartupStates.get(guid);
    if (startup) {
      await send(
        tool === "opencode"
          ? `OpenCode 正在启动，当前已有 ${startup.queue.length} 条消息等待处理。`
          : "OpenCode 正在启动，请等待启动完成后再切换工具。",
      );
      return null;
    }

    const current = await this.getCurrentTool(guid);
    const currentSession = await this.getCurrentSessionId(guid);
    if (tool !== "opencode" || (current === tool && currentSession)) {
      const session = await this.setCurrentTool(guid, tool);
      await send(
        tool === "default"
          ? "已切换到默认工具"
          : `当前已是 opencode：${session?.title || "新会话"}\n${session?.id || ""}`,
      );
      return session;
    }

    const state: ToolStartupState = { queue: [] };
    toolStartupStates.set(guid, state);

    try {
      await send(
        "OpenCode 正在启动，请稍候。启动期间发送的消息会自动加入队列。",
      );
    } catch (error) {
      toolStartupStates.delete(guid);
      throw error;
    }

    let session: Awaited<ReturnType<ToolSessionController["setCurrentTool"]>>;
    try {
      session = await this.setCurrentTool(guid, tool);
    } catch (error) {
      toolStartupStates.delete(guid);
      const queuedCount = state.queue.length;
      state.queue.length = 0;
      await send(
        `OpenCode 启动失败：${error instanceof Error ? error.message : String(error)}${
          queuedCount > 0
            ? `\n启动期间排队的 ${queuedCount} 条消息已清理。`
            : ""
        }`,
      );
      return null;
    }

    try {
      await send(
        `OpenCode 启动完成，已切换并创建子会话：${session?.title || "新会话"}\n${session?.id || ""}`,
      );
    } finally {
      toolStartupStates.delete(guid);
      for (const queued of state.queue) {
        void this.enqueueMessage(queued.event, queued.send).catch(
          async (error) => {
            try {
              await queued.send(
                `第三方工具处理失败：${error instanceof Error ? error.message : String(error)}`,
              );
            } catch {
              // 消息发送失败不影响后续排队任务继续执行。
            }
          },
        );
      }
      state.queue.length = 0;
    }
    return session;
  }

  parseTool(value: string) {
    return (
      toolAliases[
        String(value || "")
          .trim()
          .toLowerCase()
      ] || null
    );
  }

  async getPermission(guid: string): Promise<ThirdPartyPermissionMode> {
    const value = await redisClient.redis.get(`${PERMISSION_PREFIX}${guid}`);
    return permissionAliases[String(value || "").toLowerCase()] || "readonly";
  }

  parsePermission(value: string) {
    return (
      permissionAliases[
        String(value || "")
          .trim()
          .toLowerCase()
      ] || null
    );
  }

  async setPermission(guid: string, mode: ThirdPartyPermissionMode) {
    await redisClient.redis.set(`${PERMISSION_PREFIX}${guid}`, mode);
    const sessionId = await this.getCurrentSessionId(guid);
    if (!sessionId || (await this.getCurrentTool(guid)) !== "opencode") return;
    const config = await redisClient.getAIConfig(guid);
    const runtime = await ensureInheritedOpencodeServer(guid, config);
    const directory = resolveCurrentSessionDirectory(guid);
    await updateOpencodeSessionPermission(
      runtime.url,
      directory,
      sessionId,
      permissionRules[mode],
    );
  }

  async beginSelection(guid: string, type: ToolSelectionType) {
    await redisClient.redis.set(
      `${SELECTION_PREFIX}${guid}`,
      type,
      "EX",
      SELECTION_TTL_SECONDS,
    );
  }

  async getCurrentSessionId(guid: string) {
    return (
      (await redisClient.redis.get(`${CURRENT_SESSION_PREFIX}${guid}`)) || ""
    );
  }

  async createSession(guid: string) {
    const tool = await this.getCurrentTool(guid);
    if (tool === "default") {
      throw new Error("/new 仅用于当前已切换的第三方工具");
    }
    const config = await redisClient.getAIConfig(guid);
    const runtime = await ensureInheritedOpencodeServer(guid, config);
    const directory = resolveCurrentSessionDirectory(guid, true);
    const mode = await this.getPermission(guid);
    const session = await createOpencodeSession(
      runtime.url,
      directory,
      permissionRules[mode],
    );
    await redisClient.redis.set(
      `${CURRENT_SESSION_PREFIX}${guid}`,
      String(session.id),
    );
    await redisClient.redis.set(
      `${CURRENT_SESSION_TITLE_PREFIX}${guid}`,
      String(session.title || "新会话"),
    );
    return session;
  }

  async getCurrentModel(guid: string) {
    const selected = await redisClient.redis.get(
      `${CURRENT_MODEL_PREFIX}${guid}`,
    );
    if (selected) return selected;
    const config = await redisClient.getAIConfig(guid);
    return config.model ? `alemon-aichat/${config.model}` : "";
  }

  async syncModelFromCurrentAI(guid: string) {
    const config = await redisClient.getAIConfig(guid);
    const model = config.model ? `alemon-aichat/${config.model}` : "";
    if (model) {
      await redisClient.redis.set(`${CURRENT_MODEL_PREFIX}${guid}`, model);
    } else {
      await redisClient.redis.del(`${CURRENT_MODEL_PREFIX}${guid}`);
    }
    return model;
  }

  async listModels(guid: string) {
    if ((await this.getCurrentTool(guid)) === "default") {
      throw new Error("/models 仅用于当前已切换的第三方工具");
    }
    const config = await redisClient.getAIConfig(guid);
    const runtime = await ensureInheritedOpencodeServer(guid, config);
    return await listOpencodeModels(
      runtime.url,
      resolveCurrentSessionDirectory(guid, true),
    );
  }

  async setModel(guid: string, selector: string) {
    const input = String(selector || "").trim();
    if (!input) throw new Error("格式：/model <序号|provider/model>");
    const models = await this.listModels(guid);
    const index = Number(input);
    const byIndex =
      Number.isInteger(index) && index > 0 ? models[index - 1] : null;
    const exact = models.find(
      (model) => model.id.toLowerCase() === input.toLowerCase(),
    );
    const byModelID = models.filter(
      (model) => model.modelID.toLowerCase() === input.toLowerCase(),
    );
    const selected =
      byIndex || exact || (byModelID.length === 1 ? byModelID[0] : null);
    if (!selected) {
      throw new Error(
        byModelID.length > 1
          ? "存在多个同名模型，请使用完整的 provider/model"
          : "OpenCode 模型列表中未找到该模型，请先使用 /models 查看",
      );
    }
    await redisClient.redis.set(`${CURRENT_MODEL_PREFIX}${guid}`, selected.id);
    return selected;
  }

  async formatModelList(guid: string) {
    const models = await this.listModels(guid);
    const current = await this.getCurrentModel(guid);
    if (!models.length) return "当前 OpenCode 没有可用模型。";
    const lines = [
      `OpenCode 模型列表（当前：${current || "未设置"}）：`,
      ...models.map(
        (model, index) =>
          `${index + 1}. ${model.id === current ? "[当前] " : ""}${model.id}${model.name !== model.modelID ? ` - ${model.name}` : ""}`,
      ),
      "",
      "主人可使用 /model <序号> 切换，也可直接指定 provider/model。",
    ];
    return lines.join("\n");
  }

  async listSessions(guid: string) {
    const tool = await this.getCurrentTool(guid);
    if (tool === "default") throw new Error("请先切换到第三方工具");
    const directory = resolveCurrentSessionDirectory(guid, true);
    const config = await redisClient.getAIConfig(guid);
    const runtime = await ensureInheritedOpencodeServer(guid, config);
    return normalizeSessions(
      await listOpencodeSessions(runtime.url, directory),
    );
  }

  async switchSession(guid: string, selector: string) {
    const sessions = await this.listSessions(guid);
    const trimmed = String(selector || "").trim();
    const index = Number(trimmed);
    const session =
      Number.isInteger(index) && index > 0
        ? sessions[index - 1]
        : sessions.find((item) => String(item.id) === trimmed);
    if (!session) throw new Error("未找到指定子会话");
    await redisClient.redis.set(
      `${CURRENT_SESSION_PREFIX}${guid}`,
      String(session.id),
    );
    await redisClient.redis.set(
      `${CURRENT_SESSION_TITLE_PREFIX}${guid}`,
      String(session.title || "新会话"),
    );
    const config = await redisClient.getAIConfig(guid);
    const runtime = await ensureInheritedOpencodeServer(guid, config);
    const directory = resolveCurrentSessionDirectory(guid);
    const mode = await this.getPermission(guid);
    await updateOpencodeSessionPermission(
      runtime.url,
      directory,
      String(session.id),
      permissionRules[mode],
    );
    return session;
  }

  async formatSessionList(guid: string) {
    const sessions = await this.listSessions(guid);
    const current = await this.getCurrentSessionId(guid);
    if (!sessions.length) return "当前还没有子会话，请由主人使用 /new 创建。";
    return [
      "OpenCode 子会话：",
      ...sessions.map(
        (session, index) =>
          `${index + 1}. ${session.id === current ? "[当前] " : ""}${session.title || "新会话"}\n   ${session.id}`,
      ),
    ].join("\n");
  }

  async getStatus(guid: string) {
    const tool = await this.getCurrentTool(guid);
    const permission = await this.getPermission(guid);
    const sessionId = await this.getCurrentSessionId(guid);
    const title =
      (await redisClient.redis.get(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`)) ||
      "";
    return {
      tool,
      toolLabel: toolLabels[tool],
      permission,
      permissionLabel: permissionLabels[permission],
      sessionId,
      title,
      model: tool === "default" ? "" : await this.getCurrentModel(guid),
    };
  }

  async handleInteractiveInput(event: any, send: SendText) {
    if (event.IsMaster !== true) return false;
    const input = String(event.msg || "").trim();
    const pending = pendingApprovals.get(event.guid);
    if (pending && /^[123]$/.test(input)) {
      const reply: OpencodePermissionReply =
        input === "1" ? "once" : input === "2" ? "always" : "reject";
      pending.resolve(reply);
      await send(
        reply === "once"
          ? "已允许本次操作"
          : reply === "always"
            ? "已在当前 OpenCode 子会话中始终允许此类操作"
            : "已拒绝本次操作",
      );
      return true;
    }

    if (!/^[1-9]\d*$/.test(input)) return false;
    const selection = await redisClient.redis.get(
      `${SELECTION_PREFIX}${event.guid}`,
    );
    if (!selection) return false;
    await redisClient.redis.del(`${SELECTION_PREFIX}${event.guid}`);
    if (selection === "tool") {
      const tool =
        input === "1" ? "default" : input === "2" ? "opencode" : null;
      if (!tool) return false;
      await this.switchToolWithFeedback(event.guid, tool, send);
      return true;
    }
    if (selection === "permission") {
      const modes: ThirdPartyPermissionMode[] = [
        "readonly",
        "manual",
        "auto",
        "full",
      ];
      const mode = modes[Number(input) - 1];
      if (!mode) return false;
      await this.setPermission(event.guid, mode);
      await send(`当前会话权限已设置为：${permissionLabels[mode]}`);
      return true;
    }
    if (selection === "session") {
      const session = await this.switchSession(event.guid, input);
      await send(`已切换到子会话：${session.title || "新会话"}\n${session.id}`);
      return true;
    }
    return false;
  }

  async handleMessage(event: any, send: SendText): Promise<boolean> {
    if (await this.handleInteractiveInput(event, send)) return true;
    const startup = toolStartupStates.get(event.guid);
    if (startup) {
      if (
        String(event.msg).startsWith("/") ||
        String(event.msg).startsWith("#") ||
        event.UserId == event.bot?.user_id
      ) {
        return true;
      }
      if (!event.msg && !hasToolMessageAttachments(event)) return true;
      startup.queue.push({ event, send });
      await send(
        `OpenCode 正在启动，你的消息已加入队列（第 ${startup.queue.length} 位）。`,
      );
      return true;
    }
    if ((await this.getCurrentTool(event.guid)) === "default") return false;
    if (
      String(event.msg).startsWith("/") ||
      String(event.msg).startsWith("#") ||
      event.UserId == event.bot?.user_id
    ) {
      return true;
    }
    if (!event.msg && !hasToolMessageAttachments(event)) return true;
    await this.enqueueMessage(event, send);
    return true;
  }

  private async enqueueMessage(event: any, send: SendText) {
    await enqueueByGuid(event.guid, async () => {
      const sessionId = await this.getCurrentSessionId(event.guid);
      if (!sessionId) {
        await send("当前还没有 OpenCode 子会话，请由主人使用 /new 创建。");
        return;
      }
      const content = await buildToolMessageContent(event);
      const config = await redisClient.getAIConfig(event.guid);
      const runtime = await ensureInheritedOpencodeServer(event.guid, config);
      const directory = resolveCurrentSessionDirectory(event.guid);
      const mode = await this.getPermission(event.guid);
      const permissionPrompt = buildUserPermissionPrompt({
        isMaster: event.IsMaster === true,
        isAdmin: event.isAdmin === true,
        isPrivate:
          event.name === "private.message.create" ||
          event.Name === "private.message.create",
        agentEnabled: (await redisClient.getAgentSwitch(event.guid)) === "1",
        opencodeActive: true,
        opencodePermission: mode,
      });
      const userText = String(content.text || "").trim();
      const result = await sendOpencodeSessionMessage({
        url: runtime.url,
        directory,
        sessionId,
        prompt: userText
          ? `${permissionPrompt}\n\n用户消息:\n${userText}`
          : permissionPrompt,
        files: content.files,
        model: (await this.getCurrentModel(event.guid)) || runtime.model,
        guid: event.guid,
        userID: String(event.UserId || ""),
        replyPermission: async (request) => {
          if (mode === "full") return "always";
          if (mode === "readonly") return "reject";
          if (mode === "auto") {
            return await reviewPermissionWithCurrentAI(
              event.guid,
              request,
              permissionPrompt,
            );
          }
          return await waitForManualApproval(event.guid, request, send);
        },
      });
      if (result.session) {
        await redisClient.redis.set(
          `${CURRENT_SESSION_TITLE_PREFIX}${event.guid}`,
          String(result.session.title || "新会话"),
        );
      }
      const activity = String(result.activity || "").trim();
      if (activity) await send(`OpenCode 执行过程：\n${activity}`);

      const reasoning = String(result.reasoning || "").trim();
      if (reasoning) await send(`OpenCode 思考过程：\n${reasoning}`);

      const output = String(result.output || "").trim();
      if (output) await send(output);
      else if (result.error) await send(`OpenCode 执行失败：${result.error}`);
      else if (!activity && !reasoning)
        await send("OpenCode 已完成处理，但没有可展示的结果。");
    });
  }
}

export const toolSessionController = new ToolSessionController();

export const getToolLabel = (tool: ThirdPartyToolName) => toolLabels[tool];
export const getPermissionLabel = (mode: ThirdPartyPermissionMode) =>
  permissionLabels[mode];
