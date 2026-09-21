import { handleAddAIMessage } from "@src/response/add-ai/res";
import { handleSwitchAIMessage } from "@src/response/switch-ai/res";

const selects = onSelects(["message.create", "private.message.create"]);

/**
 * 添加/切换 AI 都是连续会话，必须先于普通 AI 对话消费对应消息。
 */
export default onMiddleware(selects, async (event, next) => {
  event["msg"] = event.MessageText;
  event["guid"] = event.ChannelId ?? event.UserId;

  const isAILockCommand =
    /^(#|\/)(?:锁定ai列表|(?:锁定|解锁)ai)(?:\s|$)/i.test(event.msg);
  if (isAILockCommand) return next();

  const isSwitchCommand = /^(#|\/)切换(?:ai|配置)(?:\s|$)/i.test(event.msg);
  const handled = isSwitchCommand
    ? await handleSwitchAIMessage(event)
    : (await handleAddAIMessage(event)) || (await handleSwitchAIMessage(event));

  if (handled) {
    event["Xianyu"] = false;
    return;
  }

  return next();
});
