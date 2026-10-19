import path from "node:path";
import mime from "mime-types";
import {
  collectFileMedia,
  formatFileBlock,
  resolveFileContent,
  type FileMediaItem,
} from "@src/api/fileMessage";
import { inlineHttpFileAsDataUrl } from "@src/api/opencode-attachment";
import { uploadImageToR2 } from "@src/s3";

export type ToolMessageFile = {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
};

export type ToolMessageContent = {
  text: string;
  files: ToolMessageFile[];
};

const mediaItems = (event: any): FileMediaItem[] =>
  [
    ...(Array.isArray(event.MessageMedia) ? event.MessageMedia : []).filter((item: any) =>
      ["image", "sticker", "animation"].includes(String(item?.Type).toLowerCase())),
    ...collectFileMedia(event),
  ].filter((item) => item && typeof item === "object");

export const hasToolMessageAttachments = (event: any) =>
  (Array.isArray(event.img) && event.img.length > 0) ||
  mediaItems(event).some((item) =>
    ["image", "sticker", "animation", "file", "audio", "video"].includes(
      String(item.Type || "").toLowerCase(),
    ),
  ) ||
  (Array.isArray(event.reply?.message) &&
    event.reply.message.some((item: any) =>
      ["image", "file", "record", "video"].includes(String(item?.type)),
    ));

const resolveMime = (url: string, fileName?: string, fallback?: string) => {
  if (fallback?.trim()) return fallback;
  const byName = fileName ? mime.lookup(fileName) : false;
  if (byName) return String(byName);
  try {
    const byUrl = mime.lookup(path.basename(new URL(url).pathname));
    if (byUrl) return String(byUrl);
  } catch {
    // URL 无法解析时使用默认 MIME。
  }
  return "application/octet-stream";
};

const imageName = (url: string, index: number, preferred?: string) => {
  if (preferred?.trim()) return preferred;
  try {
    return path.basename(new URL(url).pathname) || `image-${index + 1}.webp`;
  } catch {
    return `image-${index + 1}.webp`;
  }
};

export const buildToolMessageContent = async (
  event: any,
): Promise<ToolMessageContent> => {
  let text = String(
    event.value?.raw_message || event.raw_message || event.msg || "",
  )
    .replace(/\[CQ:image,[^\]]+\]/g, "")
    .replace(/\[CQ:file,[^\]]+\]/g, "")
    .trim();

  const allMedia = mediaItems(event);
  const imageCandidates: Array<{ url: string; name?: string; mime?: string }> =
    [];
  for (const url of Array.isArray(event.img) ? event.img : []) {
    if (url) imageCandidates.push({ url: String(url) });
  }
  for (const item of allMedia) {
    if (
      ["image", "sticker", "animation"].includes(
        String(item.Type || "").toLowerCase(),
      ) &&
      item.Url
    ) {
      imageCandidates.push({
        url: item.Url,
        name: item.FileName,
        mime: (item as any).MimeType,
      });
    }
  }
  for (const item of Array.isArray(event.reply?.message)
    ? event.reply.message
    : []) {
    if (item?.type === "image" && item.data?.url) {
      imageCandidates.push({
        url: String(item.data.url),
        name: item.data.name,
      });
    }
  }

  const uniqueImages = [
    ...new Map(imageCandidates.map((item) => [item.url, item])).values(),
  ];
  const files: ToolMessageFile[] = [];
  for (const [index, image] of uniqueImages.entries()) {
    try {
      const publicUrl = await uploadImageToR2(image.url);
      const filename = imageName(publicUrl, index, image.name);
      const mimeType = resolveMime(
        publicUrl,
        filename,
        image.mime || "image/webp",
      );
      const inlined = await inlineHttpFileAsDataUrl(publicUrl, mimeType);
      files.push({
        type: "file",
        mime: inlined.mime,
        filename,
        url: inlined.url,
      });
    } catch (error) {
      console.error("[tool-message] 图片附件准备失败:", error);
    }
  }

  const ordinaryFiles = allMedia.filter((item) =>
    ["file", "audio", "video", "record"].includes(
      String(item.Type || "").toLowerCase(),
    ),
  );
  const resolvedFiles = (
    await Promise.all(
      ordinaryFiles.map((item) => resolveFileContent(item, event)),
    )
  ).filter((item) => item !== null);
  const fallbackBlocks: string[] = [];
  for (const file of resolvedFiles) {
    if (file.url) {
      files.push({
        type: "file",
        mime: resolveMime(file.url, file.fileName),
        filename: file.fileName,
        url: file.url,
      });
    }
    if (!file.url || file.kind === "text" || file.error) {
      fallbackBlocks.push(formatFileBlock(file));
    }
  }

  if (fallbackBlocks.length) {
    text = [text, ...fallbackBlocks].filter(Boolean).join("\n\n");
  }
  if (!text && files.length) text = "请处理随消息发送的附件。";
  return { text, files };
};
