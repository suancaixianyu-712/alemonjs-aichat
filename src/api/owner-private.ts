import { redactCredentialValues } from "./credential-vault";

export const isOwnerPrivateEvent = (event: any) =>
  event?.IsMaster === true &&
  (event.name === "private.message.create" || event.Name === "private.message.create");

export const credentialOwnerFromEvent = (event: any) => {
  if (!isOwnerPrivateEvent(event) || !event.UserId || !event.Platform) return "";
  return JSON.stringify([String(event.Platform), String(event.UserId)]);
};

/** 不展示工具参数：保存凭据时参数本身就是敏感内容。 */
export const toolCallForDisplay = (call: any, showArguments = true) =>
  `工具调用: ${String(call?.function?.name || "")}(${call?.function?.name === "ManageCredentials" ? "[凭据参数已隐藏]" : showArguments ? String(call?.function?.arguments || "") : ""})`;

/** 保存完成后，把本轮及旧对话中的相同原文替换掉，再继续持久化或请求模型。 */
export const redactSavedCredentialContext = async (name: string, args: any, result: any, objects: any[], historyClient: any, guid: string) => {
  if (name !== "ManageCredentials" || args?.action !== "save" || result?.success !== true) return;
  const secrets = Object.values(args.fields) as string[];
  const protocolFields = new Set(["role", "type", "name", "id", "tool_call_id", "status"]);
  const scrub = (object: any) => {
    if (!object || typeof object !== "object") return;
    for (const key of Object.keys(object)) {
      if (typeof object[key] === "string" && !protocolFields.has(key)) object[key] = redactCredentialValues(object[key], secrets);
      else scrub(object[key]);
    }
  };
  for (const object of objects) scrub(object);
  const history = await historyClient.getAIChatHistory(guid);
  scrub(history);
  await historyClient.setAIChatHistory(guid, history);
};

/** 每次派发都覆盖真实身份；主人私聊及其后台任务不额外要求确认码。 */
export const bindOwnerPrivateToolCall = async (
  event: any,
  functionName: string,
  args: any,
) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象");
  args.ownerPrivate = isOwnerPrivateEvent(event);
  args.credentialOwner = credentialOwnerFromEvent(event);
  // 模型传入的身份字段一律覆盖，包括非主人和群聊。
  args.isMaster = event?.IsMaster === true;
  if (functionName === "ManageCredentials" || args.credentialEnv !== undefined) {
    if (!args.credentialOwner) throw new Error("凭据管理和使用仅主人私聊可用");
  }
};
