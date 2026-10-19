import { useClient, ResultCode } from "alemonjs";
import { attachmentScope, loadAttachment } from "./attachment-store";
import { fetchFileBuffer } from "./fileMessage";

export type SendChatFileArgs = {
  url?: string; filePath?: string; content?: string; name?: string; attachmentId?: string;
  mimeType?: string; text?: string; attachmentEvent?: any;
};

/** 目标只能来自框架事件，不能由模型指定其他用户或群。 */
export const sendChatFile = async (args: SendChatFileArgs, resolveLocalPath: (filePath: string) => string) => {
  const event = args.attachmentEvent;
  if (event?.Platform !== "scbbs") throw new Error("SendChatFile 当前仅支持 scbbs 平台");
  if ([args.url, args.filePath, args.content, args.attachmentId].filter((value) => value !== undefined).length !== 1) {
    throw new Error("url、filePath、content、attachmentId 必须且只能提供一个");
  }
  let source: string;
  let name = args.name;
  let mimeType = args.mimeType;
  if (args.attachmentId !== undefined) {
    const { record, buffer } = await loadAttachment(attachmentScope(event), args.attachmentId);
    const bytes = buffer || await fetchFileBuffer(record.source, event);
    if (!bytes) throw new Error("附件下载失败，无法发送");
    source = `base64://${bytes.toString("base64")}`;
    name ||= record.fileName;
    mimeType ||= record.source.MimeType;
  } else if (args.content !== undefined) {
    if (!name?.trim()) throw new Error("生成文件时必须指定 name（如 result.txt）");
    const bytes = Buffer.from(args.content, "utf8");
    if (bytes.length > 50 * 1024 * 1024) throw new Error("文件超过 50 MB 上限");
    source = `base64://${bytes.toString("base64")}`;
  } else if (args.filePath !== undefined) {
    source = resolveLocalPath(args.filePath);
  } else {
    const url = new URL(args.url!);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("文件链接必须是 HTTP(S) 地址");
    source = args.url!;
  }
  const isPrivate = event.name === "private.message.create" || event.Name === "private.message.create" || event.IsPrivate === true;
  const targetId = isPrivate ? event.UserId : event.ChannelId || event.GuildId || event.SpaceId;
  if (!targetId) throw new Error("当前会话没有有效发送目标");
  const [client] = useClient<{ sendFileMessage: (options: Record<string, unknown>) => Promise<unknown> }>(event);
  const result = await client.sendFileMessage({ scope: isPrivate ? "private" : "group", targetId,
    source, name, mimeType, text: args.text });
  let body: any = result;
  // CBP Result -> 后端 envelope，逐层检查，Warn/Fail 都不得当作发送成功。
  for (let depth = 0; depth < 6; depth++) {
    if (Array.isArray(body)) {
      if (body.length !== 1) throw new Error("平台未确认文件发送成功");
      body = body[0]; continue;
    }
    if (body && typeof body === "object" && "code" in body) {
      if (![ResultCode.Ok, 200].includes(body.code)) throw new Error("平台拒绝或不支持文件发送");
      body = body.data; continue;
    }
    break;
  }
  if (!body?.id) throw new Error("平台没有返回文件消息 ID，无法确认发送成功");
  return { ok: true, messageId: String(body.id), name: name || body.content?.find((item: any) => item.type === "file")?.data?.name,
    hint: "文件已发送到当前会话，不要重复发送或再次输出文件链接。" };
};
