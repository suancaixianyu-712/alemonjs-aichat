import { Text } from "alemonjs";
import { useMessage } from "@src/utils/command-message";

export const selects = onSelects(["message.create", "private.message.create"]);

const normalizeMessageId = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" || text === "-1" ? undefined : text;
};

const getReplyMessageId = (e: any): string | undefined => {
  const replySegment = Array.isArray(e.value?.message)
    ? e.value.message.find((item: any) => item?.type === "reply")
    : undefined;

  return (
    normalizeMessageId(e.replyMessageId) ||
    normalizeMessageId(replySegment?.data?.id) ||
    normalizeMessageId(e.replyId) ||
    normalizeMessageId(e.value?.replyToId) ||
    normalizeMessageId(e.reply?.message_id) ||
    normalizeMessageId(e.reply?.id)
  );
};

export default onResponse(selects, async (e) => {
  const [message] = useMessage(e);
  const targetMessageId = getReplyMessageId(e);

  if (!targetMessageId) {
    await message.send(format(Text("请引用一条消息后再发送 /撤回")));
    return;
  }

  const result = await message.delete({ messageId: targetMessageId });
  if (result.code !== 2000) {
    await message.send(format(Text("撤回失败，可能是平台不支持或机器人没有权限")));
  }
});
