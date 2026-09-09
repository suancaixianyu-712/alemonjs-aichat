import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import OpenAi from 'openai';
import redisClient from '../config.js';
import { hasToolMessageAttachments, buildToolMessageContent } from './tool-message-content.js';
import { requestRapiCompletion } from '../response/zreply/rapi.js';
import { ensureInheritedOpencodeServer, updateOpencodeSessionPermission, createOpencodeSession, listOpencodeModels, listOpencodeSessions, sendOpencodeSessionMessage } from './opencode.js';

const CURRENT_TOOL_PREFIX = "ai:third_party_tool:current:";
const PERMISSION_PREFIX = "ai:third_party_tool:permission:";
const CURRENT_SESSION_PREFIX = "ai:third_party_tool:session:opencode:";
const CURRENT_SESSION_TITLE_PREFIX = "ai:third_party_tool:title:opencode:";
const CURRENT_MODEL_PREFIX = "ai:third_party_tool:model:opencode:";
const SELECTION_PREFIX = "ai:third_party_tool:selection:";
const SELECTION_TTL_SECONDS = 300;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PERMISSION_PREVIEW = 600;
const toolLabels = {
    default: "默认",
    opencode: "opencode",
};
const permissionLabels = {
    readonly: "只读",
    manual: "手动确认",
    auto: "自动审核",
    full: "完全访问",
};
const toolAliases = {
    default: "default",
    默认: "default",
    opencode: "opencode",
};
const permissionAliases = {
    readonly: "readonly",
    只读: "readonly",
    manual: "manual",
    手动确认: "manual",
    auto: "auto",
    自动审核: "auto",
    full: "full",
    完全访问: "full",
};
const permissionRules = {
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
const pendingApprovals = new Map();
const messageChains = new Map();
const toolStartupStates = new Map();
const assertGuid = (guid) => {
    const safeGuid = String(guid || "").trim();
    if (!safeGuid ||
        safeGuid === "." ||
        safeGuid === ".." ||
        path.isAbsolute(safeGuid) ||
        safeGuid.includes("/") ||
        safeGuid.includes("\\") ||
        safeGuid.includes("\0")) {
        throw new Error("guid 只能作为 public 下的单级目录名");
    }
    return safeGuid;
};
const resolveCurrentSessionDirectory = (guid, createIfMissing = false) => {
    const safeGuid = assertGuid(guid);
    const publicRoot = path.resolve(process.cwd(), "public");
    const target = path.resolve(publicRoot, safeGuid);
    const relative = path.relative(publicRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("当前会话路径超出 public 目录");
    }
    if (createIfMissing)
        fs.mkdirSync(target, { recursive: true });
    if (!fs.existsSync(target))
        throw new Error("当前会话项目目录不存在");
    return fs.realpathSync.native(target);
};
const maskIpAddresses = (value) => {
    let text = String(value || "").replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (address) => (isIP(address) === 4 ? "***.***.***.***" : address));
    text = text.replace(/[0-9a-f:]*:[0-9a-f:]+/gi, (address) => isIP(address) === 6 ? "****:****:****:****" : address);
    return text;
};
const redactPermissionPreview = (value) => {
    let text = maskIpAddresses(value);
    text = text.replace(/(^|[\s,{[])(["']?(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|authorization|cookie)["']?\s*[:=]\s*)([^\s,}\]\r\n]+)/gim, "$1$2[敏感信息已隐藏]");
    if (text.length > MAX_PERMISSION_PREVIEW) {
        text = `${text.slice(0, MAX_PERMISSION_PREVIEW)}\n[内容过长已截断]`;
    }
    return text || "未提供具体内容";
};
const getPermissionContent = (request) => {
    const metadata = request.metadata || {};
    const candidates = [
        metadata.command,
        metadata.path,
        metadata.filepath,
        metadata.description,
        ...request.patterns,
    ]
        .filter((item) => item !== undefined && item !== null)
        .map((item) => typeof item === "string" ? item : JSON.stringify(item, null, 2));
    return redactPermissionPreview(candidates.length ? candidates.join("\n") : JSON.stringify(request.raw));
};
const getSessionTime = (session) => Number(session?.time?.updated || session?.time?.created || 0);
const normalizeSessions = (sessions) => sessions
    .filter((session) => session?.id)
    .sort((left, right) => getSessionTime(right) - getSessionTime(left));
const extractReviewJSON = (content) => {
    const match = String(content || "").match(/\{[\s\S]*?\}/);
    if (!match)
        return null;
    try {
        return JSON.parse(match[0]);
    }
    catch {
        return null;
    }
};
const reviewPermissionWithCurrentAI = async (guid, request) => {
    try {
        const config = await redisClient.getAIConfig(guid);
        if (!config.host?.trim() || !config.key?.trim() || !config.model?.trim()) {
            return "reject";
        }
        const client = new OpenAi({
            baseURL: config.host,
            apiKey: config.key,
            timeout: 120000,
        });
        const params = {
            model: config.model,
            temperature: 0,
            max_tokens: 160,
            messages: [
                {
                    role: "system",
                    content: '你是 OpenCode 操作安全审核器。根据操作类型、完整参数和当前工作目录判断是否允许本次操作。只有目标明确且风险可控时允许。涉及凭据窃取、破坏系统、持久化后门、越权外传或不相关目录时拒绝。只输出 JSON：{"allowed":boolean,"reason":"简短原因"}。',
                },
                {
                    role: "user",
                    content: JSON.stringify({
                        directory: resolveCurrentSessionDirectory(guid),
                        request: request.raw,
                    }),
                },
            ],
        };
        const completion = config.apiMode === "rapi"
            ? await requestRapiCompletion({
                client,
                params,
                signal: new AbortController().signal,
            })
            : await client.chat.completions.create(params);
        const parsed = extractReviewJSON(String(completion?.choices?.[0]?.message?.content || ""));
        return parsed?.allowed === true ? "once" : "reject";
    }
    catch {
        return "reject";
    }
};
const waitForManualApproval = async (guid, request, send) => {
    const previous = pendingApprovals.get(guid);
    if (previous) {
        clearTimeout(previous.timer);
        previous.resolve("reject");
    }
    await send([
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
    ].join("\n"));
    return await new Promise((resolve) => {
        const finish = (reply) => {
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
const enqueueByGuid = async (guid, task) => {
    const previous = messageChains.get(guid) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    messageChains.set(guid, current);
    try {
        await current;
    }
    finally {
        if (messageChains.get(guid) === current)
            messageChains.delete(guid);
    }
};
class ToolSessionController {
    async getCurrentTool(guid) {
        const value = await redisClient.redis.get(`${CURRENT_TOOL_PREFIX}${guid}`);
        return value === "opencode" ? "opencode" : "default";
    }
    async setCurrentTool(guid, tool) {
        const current = await this.getCurrentTool(guid);
        const previousSession = await this.getCurrentSessionId(guid);
        const previousTitle = (await redisClient.redis.get(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`)) ||
            "";
        await redisClient.redis.set(`${CURRENT_TOOL_PREFIX}${guid}`, tool);
        if (tool === "default")
            return null;
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
        }
        catch (error) {
            await redisClient.redis.set(`${CURRENT_TOOL_PREFIX}${guid}`, current);
            if (previousSession) {
                await redisClient.redis.set(`${CURRENT_SESSION_PREFIX}${guid}`, previousSession);
            }
            else {
                await redisClient.redis.del(`${CURRENT_SESSION_PREFIX}${guid}`);
            }
            if (previousTitle) {
                await redisClient.redis.set(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`, previousTitle);
            }
            else {
                await redisClient.redis.del(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`);
            }
            throw error;
        }
    }
    async switchToolWithFeedback(guid, tool, send) {
        const startup = toolStartupStates.get(guid);
        if (startup) {
            await send(tool === "opencode"
                ? `OpenCode 正在启动，当前已有 ${startup.queue.length} 条消息等待处理。`
                : "OpenCode 正在启动，请等待启动完成后再切换工具。");
            return null;
        }
        const current = await this.getCurrentTool(guid);
        const currentSession = await this.getCurrentSessionId(guid);
        if (tool !== "opencode" || (current === tool && currentSession)) {
            const session = await this.setCurrentTool(guid, tool);
            await send(tool === "default"
                ? "已切换到默认工具"
                : `当前已是 opencode：${session?.title || "新会话"}\n${session?.id || ""}`);
            return session;
        }
        const state = { queue: [] };
        toolStartupStates.set(guid, state);
        try {
            await send("OpenCode 正在启动，请稍候。启动期间发送的消息会自动加入队列。");
        }
        catch (error) {
            toolStartupStates.delete(guid);
            throw error;
        }
        let session;
        try {
            session = await this.setCurrentTool(guid, tool);
        }
        catch (error) {
            toolStartupStates.delete(guid);
            const queuedCount = state.queue.length;
            state.queue.length = 0;
            await send(`OpenCode 启动失败：${error instanceof Error ? error.message : String(error)}${queuedCount > 0
                ? `\n启动期间排队的 ${queuedCount} 条消息已清理。`
                : ""}`);
            return null;
        }
        try {
            await send(`OpenCode 启动完成，已切换并创建子会话：${session?.title || "新会话"}\n${session?.id || ""}`);
        }
        finally {
            toolStartupStates.delete(guid);
            for (const queued of state.queue) {
                void this.enqueueMessage(queued.event, queued.send).catch(async (error) => {
                    try {
                        await queued.send(`第三方工具处理失败：${error instanceof Error ? error.message : String(error)}`);
                    }
                    catch {
                        // 消息发送失败不影响后续排队任务继续执行。
                    }
                });
            }
            state.queue.length = 0;
        }
        return session;
    }
    parseTool(value) {
        return (toolAliases[String(value || "")
            .trim()
            .toLowerCase()] || null);
    }
    async getPermission(guid) {
        const value = await redisClient.redis.get(`${PERMISSION_PREFIX}${guid}`);
        return permissionAliases[String(value || "").toLowerCase()] || "readonly";
    }
    parsePermission(value) {
        return (permissionAliases[String(value || "")
            .trim()
            .toLowerCase()] || null);
    }
    async setPermission(guid, mode) {
        await redisClient.redis.set(`${PERMISSION_PREFIX}${guid}`, mode);
        const sessionId = await this.getCurrentSessionId(guid);
        if (!sessionId || (await this.getCurrentTool(guid)) !== "opencode")
            return;
        const config = await redisClient.getAIConfig(guid);
        const runtime = await ensureInheritedOpencodeServer(guid, config);
        const directory = resolveCurrentSessionDirectory(guid);
        await updateOpencodeSessionPermission(runtime.url, directory, sessionId, permissionRules[mode]);
    }
    async beginSelection(guid, type) {
        await redisClient.redis.set(`${SELECTION_PREFIX}${guid}`, type, "EX", SELECTION_TTL_SECONDS);
    }
    async getCurrentSessionId(guid) {
        return ((await redisClient.redis.get(`${CURRENT_SESSION_PREFIX}${guid}`)) || "");
    }
    async createSession(guid) {
        const tool = await this.getCurrentTool(guid);
        if (tool === "default") {
            throw new Error("/new 仅用于当前已切换的第三方工具");
        }
        const config = await redisClient.getAIConfig(guid);
        const runtime = await ensureInheritedOpencodeServer(guid, config);
        const directory = resolveCurrentSessionDirectory(guid, true);
        const mode = await this.getPermission(guid);
        const session = await createOpencodeSession(runtime.url, directory, permissionRules[mode]);
        await redisClient.redis.set(`${CURRENT_SESSION_PREFIX}${guid}`, String(session.id));
        await redisClient.redis.set(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`, String(session.title || "新会话"));
        return session;
    }
    async getCurrentModel(guid) {
        const selected = await redisClient.redis.get(`${CURRENT_MODEL_PREFIX}${guid}`);
        if (selected)
            return selected;
        const config = await redisClient.getAIConfig(guid);
        return config.model ? `alemon-aichat/${config.model}` : "";
    }
    async syncModelFromCurrentAI(guid) {
        const config = await redisClient.getAIConfig(guid);
        const model = config.model ? `alemon-aichat/${config.model}` : "";
        if (model) {
            await redisClient.redis.set(`${CURRENT_MODEL_PREFIX}${guid}`, model);
        }
        else {
            await redisClient.redis.del(`${CURRENT_MODEL_PREFIX}${guid}`);
        }
        return model;
    }
    async listModels(guid) {
        if ((await this.getCurrentTool(guid)) === "default") {
            throw new Error("/models 仅用于当前已切换的第三方工具");
        }
        const config = await redisClient.getAIConfig(guid);
        const runtime = await ensureInheritedOpencodeServer(guid, config);
        return await listOpencodeModels(runtime.url, resolveCurrentSessionDirectory(guid, true));
    }
    async setModel(guid, selector) {
        const input = String(selector || "").trim();
        if (!input)
            throw new Error("格式：/model <序号|provider/model>");
        const models = await this.listModels(guid);
        const index = Number(input);
        const byIndex = Number.isInteger(index) && index > 0 ? models[index - 1] : null;
        const exact = models.find((model) => model.id.toLowerCase() === input.toLowerCase());
        const byModelID = models.filter((model) => model.modelID.toLowerCase() === input.toLowerCase());
        const selected = byIndex || exact || (byModelID.length === 1 ? byModelID[0] : null);
        if (!selected) {
            throw new Error(byModelID.length > 1
                ? "存在多个同名模型，请使用完整的 provider/model"
                : "OpenCode 模型列表中未找到该模型，请先使用 /models 查看");
        }
        await redisClient.redis.set(`${CURRENT_MODEL_PREFIX}${guid}`, selected.id);
        return selected;
    }
    async formatModelList(guid) {
        const models = await this.listModels(guid);
        const current = await this.getCurrentModel(guid);
        if (!models.length)
            return "当前 OpenCode 没有可用模型。";
        const lines = [
            `OpenCode 模型列表（当前：${current || "未设置"}）：`,
            ...models.map((model, index) => `${index + 1}. ${model.id === current ? "[当前] " : ""}${model.id}${model.name !== model.modelID ? ` - ${model.name}` : ""}`),
            "",
            "主人可使用 /model <序号> 切换，也可直接指定 provider/model。",
        ];
        return lines.join("\n");
    }
    async listSessions(guid) {
        const tool = await this.getCurrentTool(guid);
        if (tool === "default")
            throw new Error("请先切换到第三方工具");
        const directory = resolveCurrentSessionDirectory(guid, true);
        const config = await redisClient.getAIConfig(guid);
        const runtime = await ensureInheritedOpencodeServer(guid, config);
        return normalizeSessions(await listOpencodeSessions(runtime.url, directory));
    }
    async switchSession(guid, selector) {
        const sessions = await this.listSessions(guid);
        const trimmed = String(selector || "").trim();
        const index = Number(trimmed);
        const session = Number.isInteger(index) && index > 0
            ? sessions[index - 1]
            : sessions.find((item) => String(item.id) === trimmed);
        if (!session)
            throw new Error("未找到指定子会话");
        await redisClient.redis.set(`${CURRENT_SESSION_PREFIX}${guid}`, String(session.id));
        await redisClient.redis.set(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`, String(session.title || "新会话"));
        const config = await redisClient.getAIConfig(guid);
        const runtime = await ensureInheritedOpencodeServer(guid, config);
        const directory = resolveCurrentSessionDirectory(guid);
        const mode = await this.getPermission(guid);
        await updateOpencodeSessionPermission(runtime.url, directory, String(session.id), permissionRules[mode]);
        return session;
    }
    async formatSessionList(guid) {
        const sessions = await this.listSessions(guid);
        const current = await this.getCurrentSessionId(guid);
        if (!sessions.length)
            return "当前还没有子会话，请由主人使用 /new 创建。";
        return [
            "OpenCode 子会话：",
            ...sessions.map((session, index) => `${index + 1}. ${session.id === current ? "[当前] " : ""}${session.title || "新会话"}\n   ${session.id}`),
        ].join("\n");
    }
    async getStatus(guid) {
        const tool = await this.getCurrentTool(guid);
        const permission = await this.getPermission(guid);
        const sessionId = await this.getCurrentSessionId(guid);
        const title = (await redisClient.redis.get(`${CURRENT_SESSION_TITLE_PREFIX}${guid}`)) ||
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
    async handleInteractiveInput(event, send) {
        if (event.IsMaster !== true)
            return false;
        const input = String(event.msg || "").trim();
        const pending = pendingApprovals.get(event.guid);
        if (pending && /^[123]$/.test(input)) {
            const reply = input === "1" ? "once" : input === "2" ? "always" : "reject";
            pending.resolve(reply);
            await send(reply === "once"
                ? "已允许本次操作"
                : reply === "always"
                    ? "已在当前 OpenCode 子会话中始终允许此类操作"
                    : "已拒绝本次操作");
            return true;
        }
        if (!/^[1-9]\d*$/.test(input))
            return false;
        const selection = await redisClient.redis.get(`${SELECTION_PREFIX}${event.guid}`);
        if (!selection)
            return false;
        await redisClient.redis.del(`${SELECTION_PREFIX}${event.guid}`);
        if (selection === "tool") {
            const tool = input === "1" ? "default" : input === "2" ? "opencode" : null;
            if (!tool)
                return false;
            await this.switchToolWithFeedback(event.guid, tool, send);
            return true;
        }
        if (selection === "permission") {
            const modes = [
                "readonly",
                "manual",
                "auto",
                "full",
            ];
            const mode = modes[Number(input) - 1];
            if (!mode)
                return false;
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
    async handleMessage(event, send) {
        if (await this.handleInteractiveInput(event, send))
            return true;
        const startup = toolStartupStates.get(event.guid);
        if (startup) {
            if (String(event.msg).startsWith("/") ||
                String(event.msg).startsWith("#") ||
                event.UserId == event.bot?.user_id) {
                return true;
            }
            if (!event.msg && !hasToolMessageAttachments(event))
                return true;
            startup.queue.push({ event, send });
            await send(`OpenCode 正在启动，你的消息已加入队列（第 ${startup.queue.length} 位）。`);
            return true;
        }
        if ((await this.getCurrentTool(event.guid)) === "default")
            return false;
        if (String(event.msg).startsWith("/") ||
            String(event.msg).startsWith("#") ||
            event.UserId == event.bot?.user_id) {
            return true;
        }
        if (!event.msg && !hasToolMessageAttachments(event))
            return true;
        await this.enqueueMessage(event, send);
        return true;
    }
    async enqueueMessage(event, send) {
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
            const result = await sendOpencodeSessionMessage({
                url: runtime.url,
                directory,
                sessionId,
                prompt: content.text,
                files: content.files,
                model: (await this.getCurrentModel(event.guid)) || runtime.model,
                guid: event.guid,
                userID: String(event.UserId || ""),
                replyPermission: async (request) => {
                    if (mode === "full")
                        return "always";
                    if (mode === "readonly")
                        return "reject";
                    if (mode === "auto") {
                        return await reviewPermissionWithCurrentAI(event.guid, request);
                    }
                    return await waitForManualApproval(event.guid, request, send);
                },
            });
            if (result.session) {
                await redisClient.redis.set(`${CURRENT_SESSION_TITLE_PREFIX}${event.guid}`, String(result.session.title || "新会话"));
            }
            const activity = String(result.activity || "").trim();
            if (activity)
                await send(`OpenCode 执行过程：\n${activity}`);
            const reasoning = String(result.reasoning || "").trim();
            if (reasoning)
                await send(`OpenCode 思考过程：\n${reasoning}`);
            const output = String(result.output || "").trim();
            if (output)
                await send(output);
            else if (result.error)
                await send(`OpenCode 执行失败：${result.error}`);
            else if (!activity && !reasoning)
                await send("OpenCode 已完成处理，但没有可展示的结果。");
        });
    }
}
const toolSessionController = new ToolSessionController();
const getToolLabel = (tool) => toolLabels[tool];
const getPermissionLabel = (mode) => permissionLabels[mode];

export { ToolSessionController, getPermissionLabel, getToolLabel, resolveCurrentSessionDirectory, toolSessionController };
