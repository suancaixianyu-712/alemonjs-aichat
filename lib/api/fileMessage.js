import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { API } from '@alemonjs/onebot';
import { useClient } from 'alemonjs';
import { uploadImageToR2 } from '../s3.js';
import { saveAttachment, cacheAttachmentBuffer, attachmentScope } from './attachment-store.js';

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
const textField = (...values) => {
    const value = values.find((value) => (typeof value === "string" && value.trim()) || typeof value === "number");
    return value == null ? undefined : String(value).trim();
};
const normalizeMedia = (item) => ({
    Type: String(item.Type || item.type || "file").toLowerCase(),
    FileId: textField(item.FileId, item.file_id, item.fileId, item.fid, item.id),
    FileName: textField(item.FileName, item.file_name, item.name, item.file),
    Url: textField(item.Url, item.url, item.download_url),
    FileSize: Number(item.FileSize ?? item.file_size ?? item.size) || undefined,
    MimeType: textField(item.MimeType, item.mime_type),
});
/** 框架媒体为准；保留原始文件 ID，框架字段不完整时从原始事件补齐。 */
const collectFileMedia = (event) => {
    const raw = event.value?.file;
    const candidates = [
        ...(Array.isArray(event.MessageMedia) ? event.MessageMedia : []).map(normalizeMedia),
        ...(raw && typeof raw === "object" ? [normalizeMedia(raw)] : []),
        ...extractFilesFromReplySegments(event.value?.message),
        ...extractFilesFromReplySegments(event.reply?.message),
    ].filter((item) => item && ["file", "audio", "record", "video"].includes(String(item.Type).toLowerCase()));
    const files = [];
    for (const item of candidates) {
        const existing = files.find((file) => (item.FileId && file.FileId === item.FileId) ||
            (item.Url && file.Url === item.Url) ||
            // 仅一个记录缺少 ID 时才以文件名合并，避免把两个同名附件吞掉。
            ((!item.FileId || !file.FileId) && item.FileName && file.FileName === item.FileName &&
                (!item.FileSize || !file.FileSize || file.FileSize === item.FileSize)));
        if (existing) {
            for (const key of Object.keys(item))
                if (!existing[key])
                    existing[key] = item[key];
        }
        else
            files.push({ ...item });
    }
    return files;
};
const formatFileSize = (size) => {
    if (!size || size <= 0)
        return "未知大小";
    const units = ["B", "KB", "MB", "GB"];
    let value = size;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index++;
    }
    return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
};
const getExtension = (fileName) => {
    const parsed = path.extname(fileName || "").replace(".", "").toLowerCase();
    return parsed;
};
const isTextLikeFile = (fileName) => {
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
const isImageFile = (fileName) => {
    return IMAGE_EXTENSIONS.has(getExtension(fileName));
};
const looksLikeBinary = (buffer) => {
    const sample = buffer.subarray(0, Math.min(BINARY_SNIFF_BYTES, buffer.length));
    return sample.includes(0);
};
/** 文件接口允许直出、OneBot envelope、框架 Result 数组及字符串地址。 */
const normalizeFileResponse = (raw) => {
    let data = raw;
    for (let i = 0; i < 8; i++) {
        if (Array.isArray(data)) {
            data = data[0];
            continue;
        }
        if (typeof data === "string") {
            const value = data.trim();
            return /^https?:\/\//i.test(value) ? { url: value } : value.startsWith("base64://") ? { base64: value.slice(9) } : { filePath: value };
        }
        if (!data || typeof data !== "object")
            return null;
        if (data.code >= 4000 || data.status === "failed" || (data.retcode != null && ![0, 1].includes(Number(data.retcode))))
            return null;
        if (data.data != null && ("code" in data || "retcode" in data || "status" in data || Object.keys(data).length === 1)) {
            data = data.data;
            continue;
        }
        const file = textField(data.file, data.file_path, data.path, data.local_path);
        const base64 = textField(data.base64, data.file_base64);
        const url = textField(data.url, data.download_url, data.downloadUrl);
        if (file?.startsWith("base64://"))
            return { base64: file.slice(9), url };
        if (file?.startsWith("data:") && file.includes(";base64,"))
            return { base64: file.split(";base64,")[1], url };
        return { filePath: file && !/^https?:\/\//i.test(file) ? file : url && !/^https?:\/\//i.test(url) ? url : undefined, base64,
            url: url || (file && /^https?:\/\//i.test(file) ? file : undefined) };
    }
    return null;
};
const downloadFile = async (url, diagnostics) => {
    const response = await fetch(url.trim(), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_FILE_SIZE) {
        diagnostics.push(!response.ok ? `HTTP ${response.status}` : "文件超过 50 MB");
        await response.body?.cancel();
        return null;
    }
    if (!response.body) {
        diagnostics.push("HTTP 响应没有文件内容");
        return null;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > MAX_FILE_SIZE) {
                diagnostics.push("文件超过 50 MB");
                await reader.cancel();
                return null;
            }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, size);
    }
    finally {
        reader.releaseLock();
    }
};
/** 获取真实字节；日志只记录阶段、状态、耗时，不打印链接、ID 和响应正文。 */
const fetchFileBuffer = async (item, e, diagnostics = []) => {
    const started = Date.now();
    const note = (stage, status) => {
        const message = `${stage}: ${status}`;
        diagnostics.push(message);
        console.log(`[fileMessage] ${message}`);
    };
    const readSource = async (source) => {
        if (!source)
            return null;
        if (source.base64) {
            if (source.base64.length > Math.ceil(MAX_FILE_SIZE / 3) * 4 + 4) {
                note("base64", "文件超过 50 MB");
                return null;
            }
            const buffer = Buffer.from(source.base64, "base64");
            if (buffer.length <= MAX_FILE_SIZE)
                return buffer;
        }
        if (source.url && /^https?:\/\//i.test(source.url)) {
            try {
                const buffer = await downloadFile(source.url, diagnostics);
                if (buffer)
                    return buffer;
                note("download", "未取得内容，继续尝试文件接口");
            }
            catch (error) {
                note("download", error?.name === "TimeoutError" ? "下载超时" : "网络连接失败");
            }
        }
        if (source.filePath) {
            try {
                const target = source.filePath.startsWith("file:") ? fileURLToPath(source.filePath) : source.filePath;
                if (!path.isAbsolute(target)) {
                    note("local", "接口返回非绝对本地路径");
                    return null;
                }
                if ((await fs.stat(target)).size > MAX_FILE_SIZE) {
                    note("local", "文件超过 50 MB");
                    return null;
                }
                const buffer = await fs.readFile(target);
                if (buffer.length <= MAX_FILE_SIZE)
                    return buffer;
            }
            catch {
                note("local", "本地路径不可读，可能不在同一容器");
            }
        }
        return null;
    };
    console.log(`[fileMessage] start platform=${String(e.Platform || "unknown").replace(/[^a-z0-9_-]/gi, "")} hasUrl=${Boolean(item.Url)} hasFileId=${Boolean(item.FileId)}`);
    // 消息中的 URL 只能走 HTTP；本地路径只接受机器人文件接口返回的结果。
    let buffer = await readSource(item.Url && /^https?:\/\//i.test(item.Url.trim()) ? { url: item.Url.trim() } : null);
    if (item.Url && !/^https?:\/\//i.test(item.Url.trim()))
        note("source", "消息链接不是 HTTP(S)，未读取本地路径");
    if (!buffer && e.Platform === "onebot" && item.FileId) {
        const [client] = useClient(e, API);
        const request = async (action, params) => {
            try {
                const raw = await client.send({ action, params });
                const data = normalizeFileResponse(raw);
                note(action, data && (data.url || data.base64 || data.filePath) ? "已返回文件来源" : "无有效文件来源／接口返回失败");
                return readSource(data);
            }
            catch {
                note(action, "接口调用失败");
                return null;
            }
        };
        // 先刷新文件直链，避免受一次性／过期的上报 URL 影响。
        buffer = await request(e.ChannelId ? "get_group_file_url" : "get_private_file_url", e.ChannelId
            ? { group_id: Number(e.ChannelId), file_id: item.FileId, busid: e.value?.file?.busid }
            : { user_id: Number(e.UserId), file_id: item.FileId });
        if (!buffer)
            buffer = await request("get_file", { file_id: item.FileId });
        if (!buffer && diagnostics.some((item) => item.startsWith("local:"))) {
            note("NapCat", "若 NapCat 在 Docker 中，请开启 OneBot 配置 enableLocalFile2Url，使 get_file 返回 base64，或正确共享文件目录");
        }
    }
    if (!buffer && !item.Url && !item.FileId)
        note("source", "事件没有下载链接或文件 ID");
    if (!buffer && e.Platform !== "onebot" && item.FileId)
        note("source", "当前平台尚未提供按 ID 下载接口");
    console.log(`[fileMessage] ${buffer ? "downloaded" : "failed"} bytes=${buffer?.length || 0} elapsedMs=${Date.now() - started}${buffer ? "" : ` stages=${diagnostics.join("; ")}`}`);
    return buffer;
};
/**
 * 提取文本内容（带二进制检测和截断）
 */
const extractTextContent = (buffer) => {
    if (looksLikeBinary(buffer))
        return null;
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
const resolveFileContent = async (item, e) => {
    const fileName = item.FileName || "未命名文件";
    const fileSize = item.FileSize;
    const baseInfo = {
        fileName,
        fileSize,
        kind: "binary",
    };
    try {
        baseInfo.attachmentId = await saveAttachment(e, item);
        if (fileSize && fileSize > MAX_FILE_SIZE) {
            return { ...baseInfo, error: "文件超过 50 MB 处理上限" };
        }
        const diagnostics = [];
        const buffer = await fetchFileBuffer(item, e, diagnostics);
        if (buffer) {
            await cacheAttachmentBuffer(attachmentScope(e), baseInfo.attachmentId, buffer);
            baseInfo.fileSize = buffer.length;
        }
        // 图片文件也必须解析 FileId；不能只告诉模型“已提供图片”。
        if (isImageFile(fileName) || item.MimeType?.startsWith("image/")) {
            if (!buffer)
                return { ...baseInfo, error: `无法获取图片文件内容：${diagnostics.join("；") || "没有可用文件来源"}` };
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
                error: `无法获取文件内容：${diagnostics.join("；") || "没有可用文件来源"}`,
            };
        }
        if (isTextLikeFile(fileName)) {
            const extracted = extractTextContent(buffer);
            if (extracted)
                return {
                    ...baseInfo, kind: "text", url: item.Url || undefined,
                    textContent: extracted.content, truncated: extracted.truncated,
                };
        }
        return { ...baseInfo, kind: "media", url: item.Url || undefined };
    }
    catch (error) {
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
const extractFilesFromReplySegments = (segments) => {
    if (!Array.isArray(segments))
        return [];
    const files = [];
    for (const segment of segments) {
        if (!segment || typeof segment !== "object")
            continue;
        if (["file", "record", "video"].includes(segment.type)) {
            const data = segment.data || {};
            files.push({
                Type: segment.type === "file" ? "file" : segment.type,
                Url: textField(data.url, data.download_url),
                FileId: textField(data.file_id, data.fileId, data.fid, data.id),
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
const formatFileBlock = (file) => {
    const lines = [];
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
    }
    else if (file.attachmentId) {
        lines.push("(正文尚未解析，请调用 ReadChatFile inspect；压缩包无需命令行即可查看目录与指定文件)");
    }
    else if (file.url) {
        lines.push("(无法直接读取该文件内容, 如需处理可调用 ReadRemoteFile 工具按下载链接获取)");
    }
    else {
        lines.push("(正文尚未解析，请调用 ReadChatFile inspect；压缩包无需命令行即可查看目录与指定文件)");
    }
    return lines.join("\n");
};

export { collectFileMedia, extractFilesFromReplySegments, fetchFileBuffer, formatFileBlock, formatFileSize, isImageFile, isTextLikeFile, normalizeFileResponse, resolveFileContent };
