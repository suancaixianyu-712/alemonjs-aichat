import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { API } from '@alemonjs/onebot';
import { useClient } from 'alemonjs';
import { uploadMediaToR2 } from '../s3.js';

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
/**
 * 通过 OneBot get_file API 获取文件信息（file_id）
 * 返回本地路径 / base64 / url
 */
const fetchOneBotFile = async (fileId, e) => {
    if (e?.Platform !== "onebot")
        return null;
    try {
        const [client] = useClient(e, API);
        const data = (await client.send({
            action: "get_file",
            params: { file_id: fileId },
        }));
        if (!data)
            return null;
        return {
            filePath: typeof data?.file === "string" ? data.file : undefined,
            base64: typeof data?.base64 === "string" ? data.base64 : undefined,
            url: typeof data?.url === "string" ? data.url : undefined,
        };
    }
    catch (error) {
        console.error("[fileMessage] get_file 失败:", error);
        return null;
    }
};
/**
 * 获取文件 Buffer，返回 null 表示无法获取
 */
const fetchFileBuffer = async (item, e) => {
    // 1. 直接 URL 下载
    if (item.Url && /^https?:\/\//.test(item.Url)) {
        try {
            const response = await fetch(item.Url);
            if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());
                if (buffer.length <= MAX_FILE_SIZE)
                    return buffer;
                console.error(`[fileMessage] 文件过大(${formatFileSize(buffer.length)}): ${item.FileName}`);
                return null;
            }
        }
        catch (error) {
            console.error("[fileMessage] URL 下载失败:", error);
        }
    }
    // 2. OneBot get_file
    if (item.FileId) {
        const oneBotFile = await fetchOneBotFile(item.FileId, e);
        if (oneBotFile?.base64) {
            const buffer = Buffer.from(oneBotFile.base64, "base64");
            if (buffer.length <= MAX_FILE_SIZE)
                return buffer;
        }
        if (oneBotFile?.filePath) {
            try {
                const buffer = await fs.readFile(oneBotFile.filePath);
                if (buffer.length <= MAX_FILE_SIZE)
                    return buffer;
            }
            catch (error) {
                console.error("[fileMessage] 读取本地文件失败:", error);
            }
        }
        if (oneBotFile?.url && /^https?:\/\//.test(oneBotFile.url)) {
            try {
                const response = await fetch(oneBotFile.url);
                if (response.ok) {
                    const buffer = Buffer.from(await response.arrayBuffer());
                    if (buffer.length <= MAX_FILE_SIZE)
                        return buffer;
                }
            }
            catch (error) {
                console.error("[fileMessage] get_file url 下载失败:", error);
            }
        }
    }
    return null;
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
/**
 * 将 Buffer 写入临时文件并返回路径
 */
const writeTempFile = async (buffer, fileName) => {
    const safeName = (fileName).replace(/[\\/:*?"<>|]+/g, "_");
    const tempDir = path.join(os.tmpdir(), "alemon-file-message");
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
    await fs.writeFile(tempPath, buffer);
    return tempPath;
};
const cleanupTempFile = async (tempPath) => {
    if (!tempPath)
        return;
    await fs.rm(tempPath, { force: true }).catch(() => { });
};
/**
 * 解析单个文件媒体项：
 * - 图片 → 上传 R2（走图片压缩管线）
 * - 文本类 → 提取内容 + 上传 R2
 * - 音视频/二进制 → 上传 R2 仅给元数据
 */
const resolveFileContent = async (item, e) => {
    const fileName = item.FileName || "未命名文件";
    const fileSize = item.FileSize;
    const baseInfo = {
        fileName,
        fileSize,
        kind: "binary",
    };
    try {
        // 图片：交给现有图片管线（复用 e.img 的处理方式）
        if (isImageFile(fileName)) {
            return {
                ...baseInfo,
                kind: "image",
                url: item.Url && /^https?:\/\//.test(item.Url) ? item.Url : undefined,
            };
        }
        const buffer = await fetchFileBuffer(item, e);
        if (!buffer) {
            // 无法获取内容：URL 可用时仅提供链接
            return {
                ...baseInfo,
                kind: item.Url ? "media" : "binary",
                url: item.Url && /^https?:\/\//.test(item.Url) ? item.Url : undefined,
                error: "无法获取文件内容",
            };
        }
        const tempPath = await writeTempFile(buffer, fileName);
        try {
            // 文本类文件：提取内容
            if (isTextLikeFile(fileName)) {
                const extracted = extractTextContent(buffer);
                if (extracted) {
                    const url = await uploadMediaToR2(tempPath, fileName).catch(() => null);
                    return {
                        ...baseInfo,
                        kind: "text",
                        url: url || undefined,
                        textContent: extracted.content,
                        truncated: extracted.truncated,
                    };
                }
            }
            // 其他文件：上传 R2 提供下载链接
            const url = await uploadMediaToR2(tempPath, fileName).catch(() => null);
            return {
                ...baseInfo,
                kind: "media",
                url: url || undefined,
            };
        }
        finally {
            await cleanupTempFile(tempPath);
        }
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
const formatFileBlock = (file) => {
    const lines = [];
    const sizeText = formatFileSize(file.fileSize);
    lines.push(`[文件] ${file.fileName} (${sizeText})`);
    if (file.url) {
        lines.push(`下载链接: ${file.url}`);
    }
    if (file.kind === "image") {
        lines.push("（图片文件，内容以图片形式提供）");
        return lines.join("\n");
    }
    if (file.kind === "text" && file.textContent) {
        lines.push("文件内容:");
        lines.push("```");
        lines.push(file.textContent);
        lines.push("```");
        if (file.truncated) {
            lines.push("(内容过长已截断，可通过 ReadRemoteFile 工具按下载链接获取完整内容)");
        }
        return lines.join("\n");
    }
    if (file.url) {
        lines.push("(无法直接读取该文件内容, 如需处理可调用 ReadRemoteFile 工具按下载链接获取)");
    }
    else if (file.error) {
        lines.push(`(文件内容不可用: ${file.error})`);
    }
    else {
        lines.push("(无法读取该文件内容)");
    }
    return lines.join("\n");
};

export { extractFilesFromReplySegments, formatFileBlock, formatFileSize, isImageFile, isTextLikeFile, resolveFileContent };
