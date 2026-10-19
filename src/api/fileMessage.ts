import fs from "fs/promises";
import path from "path";
import { API } from "@alemonjs/onebot";
import { useClient } from "alemonjs";
import { uploadImageToR2 } from "@src/s3";
import { unwrapOneBotData } from "@src/api/onebot-result";
import { attachmentScope, cacheAttachmentBuffer, saveAttachment } from "@src/api/attachment-store";

/** 文件大小上限（超过则拒绝下载处理） */
const MAX_FILE_SIZE = 50 * 1024 * 1024;
/** 文本内容注入长度上限（字符） */
const MAX_TEXT_CHARS = 8000;
/** 二进制检测：前 8KB 内出现 NUL 字节视为二进制 */
const BINARY_SNIFF_BYTES = 8192;

const TEXT_LIKE_EXTENSIONS = new Set([
  "txt", "md", "markdown", "log", "json", "jsonl", "csv", "tsv",
  "yaml", "yml", "toml", "ini", "conf", "cfg", "env", "properties",
  "xml", "html", "htm", "css", "scss", "less",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "svelte",
  "py", "java", "c", "h", "cpp", "hpp", "cc", "cs", "go", "rs",
  "rb", "php", "sh", "bash", "zsh", "bat", "cmd", "ps1", "psm1",
  "sql", "lua", "r", "swift", "kt", "kts", "dart", "scala", "pl",
  "srt", "vtt", "ass", "ssa", "lrc",
  "gitignore", "gitattributes", "dockerignore", "editorconfig",
]);

const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "tiff", "avif",
]);

export type ResolvedFileKind = "image" | "text" | "media" | "binary";

export type ResolvedFile = {
  fileName: string;
  fileSize?: number;
  kind: ResolvedFileKind;
  /** 上传 R2 后的公网链接（图片/音视频/二进制），可能为空 */
  url?: string;
  /** 文本类文件提取到的内容（已截断） */
  textContent?: string;
  truncated?: boolean;
  error?: string;
  attachmentId?: string;
};

export type FileMediaItem = {
  Type?: string;
  Url?: string;
  FileId?: string;
  FileName?: string;
  FileSize?: number;
  MimeType?: string;
};

/** 框架媒体为准，兼容旧适配器消息段及引用附件。 */
export const collectFileMedia = (event: any): FileMediaItem[] => {
  const candidates = [
    ...(Array.isArray(event.MessageMedia) ? event.MessageMedia : []).map((item: FileMediaItem) => {
      const rawFile = event.value?.file;
      if (item.Type !== "file" || !rawFile || (rawFile.name && rawFile.name !== item.FileName)) return item;
      return { ...item, FileId: item.FileId || rawFile.id || rawFile.file_id, Url: item.Url || rawFile.url };
    }),
    ...extractFilesFromReplySegments(event.value?.message),
    ...extractFilesFromReplySegments(event.reply?.message),
  ].filter((item) => item && ["file", "audio", "record", "video"].includes(String(item.Type).toLowerCase()));
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = item.FileId ? `id:${item.FileId}` : item.Url ? `url:${item.Url}` : `name:${item.FileName}:${item.FileSize}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const formatFileSize = (size?: number): string => {
  if (!size || size <= 0) return "未知大小";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
};

const getExtension = (fileName: string): string => {
  const parsed = path.extname(fileName || "").replace(".", "").toLowerCase();
  return parsed;
};

export const isTextLikeFile = (fileName: string): boolean => {
  const ext = getExtension(fileName);
  if (!ext) {
    // 无扩展名的常见文本文件名
    const base = path.basename(fileName || "").toLowerCase();
    return [
      "dockerfile", "makefile", "license", "readme", "changelog",
    ].includes(base);
  }
  return TEXT_LIKE_EXTENSIONS.has(ext);
};

export const isImageFile = (fileName: string): boolean => {
  return IMAGE_EXTENSIONS.has(getExtension(fileName));
};

const looksLikeBinary = (buffer: Buffer): boolean => {
  const sample = buffer.subarray(0, Math.min(BINARY_SNIFF_BYTES, buffer.length));
  return sample.includes(0);
};

/**
 * 通过 OneBot get_file API 获取文件信息（file_id）
 * 返回本地路径 / base64 / url
 */
const fetchOneBotFile = async (
  fileId: string,
  e: any,
  urlOnly = false,
): Promise<{ filePath?: string; base64?: string; url?: string } | null> => {
  if (e?.Platform !== "onebot") return null;
  try {
    const [client] = useClient(e, API);
    let data = urlOnly ? null : unwrapOneBotData<any>(await client.send({
      action: "get_file",
      params: { file_id: fileId },
    }).catch(() => null));
    if (!data?.file && !data?.base64 && !data?.url) {
      data = unwrapOneBotData<any>(await client.send({
        action: e.ChannelId ? "get_group_file_url" : "get_private_file_url",
        params: e.ChannelId
          ? { group_id: Number(e.ChannelId), file_id: fileId, busid: e.value?.file?.busid }
          : { user_id: Number(e.UserId), file_id: fileId },
      }));
    }
    if (!data) return null;
    return {
      filePath: typeof data?.file === "string" ? data.file : undefined,
      base64: typeof data?.base64 === "string" ? data.base64 : undefined,
      url: typeof data?.url === "string" ? data.url : undefined,
    };
  } catch (error) {
    console.error("[fileMessage] 获取文件失败");
    return null;
  }
};

const downloadFile = async (url: string): Promise<Buffer | null> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_FILE_SIZE) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FILE_SIZE) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
};

/** 获取文件 Buffer，返回 null 表示无法获取。 */
export const fetchFileBuffer = async (
  item: FileMediaItem,
  e: any,
): Promise<Buffer | null> => {
  // 1. 直接 URL 下载
  if (item.Url && /^https?:\/\//.test(item.Url)) {
    try {
      const buffer = await downloadFile(item.Url);
      if (buffer) return buffer;
    } catch (error) {
      console.error("[fileMessage] URL 下载失败");
    }
  }

  // 2. OneBot get_file
  if (item.FileId) {
    const oneBotFile = await fetchOneBotFile(item.FileId, e);
    if (oneBotFile?.base64) {
      const buffer = Buffer.from(oneBotFile.base64, "base64");
      if (buffer.length <= MAX_FILE_SIZE) return buffer;
    }
    if (oneBotFile?.filePath) {
      try {
        if ((await fs.stat(oneBotFile.filePath)).size > MAX_FILE_SIZE) return null;
        const buffer = await fs.readFile(oneBotFile.filePath);
        if (buffer.length <= MAX_FILE_SIZE) return buffer;
      } catch (error) {
        console.error("[fileMessage] 读取本地文件失败");
      }
    }
    if (oneBotFile?.url && /^https?:\/\//.test(oneBotFile.url)) {
      try {
        const buffer = await downloadFile(oneBotFile.url);
        if (buffer) return buffer;
      } catch (error) {
        console.error("[fileMessage] get_file url 下载失败");
      }
    }
    // OneBot 可能在另一台机器或容器中，get_file 返回的本地路径不能直接读取。
    if (!oneBotFile?.url) {
      const remote = await fetchOneBotFile(item.FileId, e, true);
      if (remote?.url && /^https?:\/\//.test(remote.url)) {
        const buffer = await downloadFile(remote.url).catch(() => null);
        if (buffer) return buffer;
      }
    }
  }

  return null;
};

/**
 * 提取文本内容（带二进制检测和截断）
 */
const extractTextContent = (
  buffer: Buffer,
): { content: string; truncated: boolean } | null => {
  if (looksLikeBinary(buffer)) return null;
  const text = buffer.toString("utf-8").replace(/^\uFEFF/, "");
  if (text.length > MAX_TEXT_CHARS) {
    return {
      content: text.slice(0, MAX_TEXT_CHARS),
      truncated: true,
    };
  }
  return { content: text, truncated: false };
};

/** 解析附件并缓存原始内容，后续通过 ReadChatFile 继续读取。 */
export const resolveFileContent = async (
  item: FileMediaItem,
  e: any,
): Promise<ResolvedFile | null> => {
  const fileName = item.FileName || "未命名文件";
  const fileSize = item.FileSize;
  const baseInfo: ResolvedFile = {
    fileName,
    fileSize,
    kind: "binary",
  };

  try {
    baseInfo.attachmentId = await saveAttachment(e, item);
    if (fileSize && fileSize > MAX_FILE_SIZE) {
      return { ...baseInfo, error: "文件超过 50 MB 处理上限" };
    }
    const buffer = await fetchFileBuffer(item, e);
    if (buffer) {
      await cacheAttachmentBuffer(attachmentScope(e), baseInfo.attachmentId, buffer);
      baseInfo.fileSize = buffer.length;
    }
    // 图片文件也必须解析 FileId；不能只告诉模型“已提供图片”。
    if (isImageFile(fileName) || item.MimeType?.startsWith("image/")) {
      if (!buffer) return { ...baseInfo, error: "无法获取图片文件内容" };
      const source = `data:${item.MimeType || "image/" + (getExtension(fileName) === "jpg" ? "jpeg" : getExtension(fileName))};base64,${buffer.toString("base64")}`;
      const url = await uploadImageToR2(source).catch(() => source);
      return {
        ...baseInfo,
        kind: "image",
        url,
      };
    }

    if (!buffer) {
      // 无法获取内容：URL 可用时仅提供链接
      return {
        ...baseInfo,
        kind: item.Url ? "media" : "binary",
        url: item.Url && /^https?:\/\//.test(item.Url) ? item.Url : undefined,
        error: "无法获取文件内容",
      };
    }

    if (isTextLikeFile(fileName)) {
      const extracted = extractTextContent(buffer);
      if (extracted) return {
        ...baseInfo, kind: "text", url: item.Url || undefined,
        textContent: extracted.content, truncated: extracted.truncated,
      };
    }
    return { ...baseInfo, kind: "media", url: item.Url || undefined };
  } catch (error: any) {
    console.error(`[fileMessage] 处理文件失败: ${fileName}`, error);
    return {
      ...baseInfo,
      error: error?.message || String(error) || "文件处理失败",
    };
  }
};

/**
 * 从引用消息段中提取文件媒体项
 */
export const extractFilesFromReplySegments = (segments: any[]): FileMediaItem[] => {
  if (!Array.isArray(segments)) return [];
  const files: FileMediaItem[] = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") continue;
    if (["file", "record", "video"].includes(segment.type)) {
      const data = segment.data || {};
      files.push({
        Type: segment.type === "file" ? "file" : segment.type,
        Url: data.url,
        FileId: data.file_id,
        FileName: data.file_name || data.file,
        FileSize: data.file_size ? Number(data.file_size) : undefined,
      });
    }
  }
  return files;
};

/**
 * 格式化单个文件的注入块
 */
export const formatFileBlock = (file: ResolvedFile): string => {
  const lines: string[] = [];
  const sizeText = formatFileSize(file.fileSize);
  lines.push(`[文件] ${file.fileName} (${sizeText})`);
  if (file.attachmentId) {
    lines.push(`附件 ID: ${file.attachmentId}。使用 ReadChatFile 的 inspect 查看内容／压缩包目录，read 配合 entryPath 读取包内指定文件；list 可查当前会话附件。不要只凭文件名判断内容。`);
  }
  if (file.url && !file.url.startsWith("data:")) {
    lines.push(`下载链接: ${file.url}`);
  }
  if (file.kind === "image" && file.url) {
    lines.push("（图片文件，内容以图片形式提供）");
    return lines.join("\n");
  }
  if (file.kind === "text" && typeof file.textContent === "string") {
    lines.push("文件内容:");
    lines.push("```");
    lines.push(file.textContent);
    lines.push("```");
    if (file.truncated) {
      lines.push("(内容过长已截断，可用 ReadChatFile 的 read、offset、maxChars 继续读取)");
    }
    return lines.join("\n");
  }
  if (file.error) {
    lines.push(`(文件内容不可用: ${file.error})`);
  } else if (file.attachmentId) {
    lines.push("(正文尚未解析，请调用 ReadChatFile inspect；压缩包无需命令行即可查看目录与指定文件)");
  } else if (file.url) {
    lines.push(
      "(无法直接读取该文件内容, 如需处理可调用 ReadRemoteFile 工具按下载链接获取)",
    );
  } else {
    lines.push("(正文尚未解析，请调用 ReadChatFile inspect；压缩包无需命令行即可查看目录与指定文件)");
  }
  return lines.join("\n");
};
