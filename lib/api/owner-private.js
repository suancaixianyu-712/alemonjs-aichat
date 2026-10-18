import { createHash, randomBytes } from 'node:crypto';
import { isOwnerOnlyOperation } from './group-full-access.js';
import { redactCredentialValues } from './credential-vault.js';

const isOwnerPrivateEvent = (event) => event?.IsMaster === true &&
    (event.name === "private.message.create" || event.Name === "private.message.create");
const credentialOwnerFromEvent = (event) => {
    if (!isOwnerPrivateEvent(event) || !event.UserId || !event.Platform)
        return "";
    return JSON.stringify([String(event.Platform), String(event.UserId)]);
};
/** 不展示工具参数：保存凭据时参数本身就是敏感内容。 */
const toolCallForDisplay = (call, showArguments = true) => `工具调用: ${String(call?.function?.name || "")}(${call?.function?.name === "ManageCredentials" ? "[凭据参数已隐藏]" : showArguments ? String(call?.function?.arguments || "") : ""})`;
/** 保存完成后，把本轮及旧对话中的相同原文替换掉，再继续持久化或请求模型。 */
const redactSavedCredentialContext = async (name, args, result, objects, historyClient, guid) => {
    if (name !== "ManageCredentials" || args?.action !== "save" || result?.success !== true)
        return;
    const secrets = Object.values(args.fields);
    const protocolFields = new Set(["role", "type", "name", "id", "tool_call_id", "status"]);
    const scrub = (object) => {
        if (!object || typeof object !== "object")
            return;
        for (const key of Object.keys(object)) {
            if (typeof object[key] === "string" && !protocolFields.has(key))
                object[key] = redactCredentialValues(object[key], secrets);
            else
                scrub(object[key]);
        }
    };
    for (const object of objects)
        scrub(object);
    const history = await historyClient.getAIChatHistory(guid);
    scrub(history);
    await historyClient.setAIChatHistory(guid, history);
};
const stableJson = (value) => {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
};
/** 每次派发都覆盖真实身份；确认码绑定用户、会话、工具及全部操作参数。 */
const bindOwnerPrivateToolCall = async (event, functionName, args, store) => {
    if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("工具参数必须是对象");
    args.ownerPrivate = isOwnerPrivateEvent(event);
    args.credentialOwner = credentialOwnerFromEvent(event);
    // 模型传入的身份字段一律覆盖，包括非主人和群聊。
    args.isMaster = event?.IsMaster === true;
    if (functionName === "ManageCredentials" || args.credentialEnv !== undefined) {
        if (!args.credentialOwner)
            throw new Error("凭据管理和使用仅主人私聊可用");
    }
    if (!args.ownerPrivate)
        return;
    const needsConfirmation = functionName === "AgentDeleteFile" ||
        (["RunServerCommand", "AgentProjectCommand"].includes(functionName) && isOwnerOnlyOperation(String(args.command || ""))) ||
        (["RunCodex", "RunOpencode", "SubAgent"].includes(functionName) && isOwnerOnlyOperation(String(args.prompt || args.task || "")));
    if (!needsConfirmation)
        return;
    const operation = { ...args };
    for (const key of ["isMaster", "ownerPrivate", "credentialOwner", "groupFullAccess", "reviewGuid", "guid"])
        delete operation[key];
    const digest = createHash("sha256").update(stableJson([args.credentialOwner, event.guid, functionName, operation])).digest("hex");
    const key = `data:aiChat:owner-confirm:${digest}`;
    const text = typeof event.msg === "string" ? event.msg.trim() : "";
    const confirmation = /^(?:确认执行|確認執行)\s+([a-f0-9]{12})$/i.exec(text);
    // 后台任务不能把上下文或模型参数伪装成新收到的主人确认。
    if (confirmation && !event.heartbeat && !event.followupJudgement && !event.__background) {
        const consumed = await store.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]); return 1 end; return 0", 1, key, confirmation[1].toLowerCase());
        if (Number(consumed) === 1)
            return;
    }
    let token = await store.get(key);
    if (!token) {
        const candidate = randomBytes(6).toString("hex");
        await store.set(key, candidate, "EX", 600, "NX");
        token = await store.get(key);
        if (!token)
            throw new Error("无法创建操作确认，请稍后重试");
    }
    throw new Error(`此删除或服务操作需要主人确认。请说明具体目标和影响，并请主人在私聊回复「确认执行 ${token}」（10 分钟内有效）。收到后以完全相同的工具和操作参数执行；不得自行确认或改用其他工具。`);
};

export { bindOwnerPrivateToolCall, credentialOwnerFromEvent, isOwnerPrivateEvent, redactSavedCredentialContext, toolCallForDisplay };
