import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import path from 'path';
import mime from 'mime-types';
import sharp from 'sharp';
import { getAiChatConfigValue } from './config/app.js';
import { getOpenAIProxyFetch } from './api/openaiProxy.js';
import { isLikelyLocalImagePath } from './api/image-source.js';
import redisClient from './config.js';

const value = getAiChatConfigValue();
const R2_CONFIG = {
    accessKeyId: "f8f0d360d3156a1667c527c5ea4b18d7",
    secretAccessKey: "365f44cf6079054ad99923dd32966d0aba4e4d2d24726cadcd0102a7c2e7bc08",
    bucket: "images",
    publicDomain: "https://r2img.ccxk.top",
    endpoint: "https://b24a196dc2ee578845bb555d53812508.r2.cloudflarestorage.com",
};
const sanitizeR2FileName = (name) => name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "");
/** 生成唯一 object key 片段：时间戳 + 随机串，避免同名覆盖（如 download.webp） */
const randomObjectId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/**
 * 构建 R2 对象 key。
 * - 传入 key 时：使用自定义名（仍做安全化）
 * - 未传 key 时：始终用时间戳+随机，避免源文件名相同（如 CDN 的 /download）互相覆盖
 */
const buildR2ObjectKey = (key, _fallbackBaseName, extension) => {
    const normalizedExtension = extension.startsWith(".")
        ? extension
        : `.${extension}`;
    if (key?.trim()) {
        const parsed = path.parse(key.trim());
        const safeBaseName = sanitizeR2FileName(parsed.name || key.trim() || "file") || "file";
        return `${safeBaseName}${normalizedExtension}`;
    }
    return `${randomObjectId()}${normalizedExtension}`;
};
/**
 * 判断是否为动画图片并获取信息
 * @param buffer 图片buffer
 * @returns 动画信息和metadata
 */
const getImageAnimationInfo = async (buffer) => {
    try {
        const metadata = await sharp(buffer, { animated: true }).metadata();
        // 对于GIF，pages > 1 表示动画
        // 对于WebP，pages > 1 表示动画
        const isAnimated = (metadata.pages && metadata.pages > 1) || false;
        return {
            isAnimated,
            frameCount: metadata.pages,
            metadata,
        };
    }
    catch {
        return {
            isAnimated: false,
            metadata: {},
        };
    }
};
/**
 * 预处理图片：转换格式、压缩、处理动图
 * @param buffer 原始图片buffer
 * @param contentType 原始内容类型
 * @param options 处理选项
 * @returns 处理后的buffer和新的contentType
 */
const preprocessImage = async (buffer, contentType, options = {}) => {
    const { maxWidth = 1920, maxHeight = 1080, quality = 80, format = "webp", animatedBehavior = "first-frame", // 默认取第一帧
     } = options;
    // 检查是否为动画
    const { isAnimated, frameCount } = await getImageAnimationInfo(buffer);
    // 是否需要保留全部帧（动图）
    let preserveAnimation = false;
    // 处理动图
    if (isAnimated) {
        console.log(`检测到动图，共 ${frameCount} 帧，处理方式: ${animatedBehavior}`);
        if (animatedBehavior === "error") {
            throw new Error(`不支持上传动画图片 (共 ${frameCount} 帧)`);
        }
        if (animatedBehavior === "keep") {
            // 保持动图格式：后续 sharp 处理需要带上 animated，否则只会输出第一帧
            console.log("保持动图格式");
            preserveAnimation = true;
        }
        if (animatedBehavior === "first-frame") {
            // 取第一帧 - 使用 sharp 的提取功能
            console.log("提取第一帧作为静态图片");
            // 对于动图，提取第一帧
            const firstFrameBuffer = await sharp(buffer, {
                animated: true,
                pages: 1, // 只取第一页
            })
                .resize(maxWidth, maxHeight, {
                fit: "inside",
                withoutEnlargement: true,
            })
                .toBuffer();
            buffer = firstFrameBuffer;
        }
    }
    try {
        // 使用sharp处理图片；保留动图时必须开启 animated，否则只会输出第一帧
        let sharpInstance = sharp(buffer, preserveAnimation ? { animated: true } : {})
            .resize(maxWidth, maxHeight, {
            fit: "inside", // 保持宽高比
            withoutEnlargement: true, // 不放大图片
        });
        // 根据目标格式进行处理
        let processedBuffer;
        let finalContentType;
        switch (format) {
            case "webp":
                processedBuffer = await sharpInstance.webp({ quality }).toBuffer();
                finalContentType = "image/webp";
                break;
            case "png":
                processedBuffer = await sharpInstance
                    .png({
                    compressionLevel: 9,
                    quality: quality,
                })
                    .toBuffer();
                finalContentType = "image/png";
                break;
            case "jpeg":
            default:
                processedBuffer = await sharpInstance
                    .jpeg({ quality, mozjpeg: true })
                    .toBuffer();
                finalContentType = "image/jpeg";
        }
        return {
            buffer: processedBuffer,
            contentType: finalContentType,
            format,
            wasAnimated: isAnimated,
        };
    }
    catch (error) {
        console.error("图片处理失败:", error);
        throw new Error("图片格式不支持或处理失败");
    }
};
/**
 * 从各种源获取图片buffer
 */
const getImageBuffer = async (source) => {
    let buffer;
    let contentType;
    let fileName;
    const looksLikeLocalPath = isLikelyLocalImagePath(source);
    if (source.startsWith("http://") || source.startsWith("https://")) {
        // 远程 URL
        let url = source.replace("!/fwfh/368x238", "");
        const isXAIImage = url.startsWith("https://imgen.x.ai");
        if (isXAIImage && value.xaiImgProxy) {
            url = url.replace("https://imgen.x.ai", value.xaiImgProxy);
        }
        const grokConfig = isXAIImage
            ? await redisClient.getProviderAIConfig("grok")
            : null;
        const requestFetch = isXAIImage && !value.xaiImgProxy
            ? getOpenAIProxyFetch(value.httpProxy, await redisClient.isToolProxyEnabled(grokConfig)) || fetch
            : fetch;
        let response = await requestFetch(url);
        if (!response.ok) {
            if (url.startsWith("https://img.suancaixianyu.cn")) {
                url = url.replace("https://img.suancaixianyu.cn", "https://r2.scbbs.top");
                response = await fetch(url);
            }
            if (!response.ok)
                throw new Error(`下载图片失败: ${response.statusText}`);
        }
        buffer = Buffer.from(await response.arrayBuffer());
        contentType =
            response.headers.get("content-type") ||
                mime.lookup(source) ||
                "image/jpeg";
        fileName =
            path.basename(new URL(source).pathname) || `image-${Date.now()}.jpg`;
    }
    else if (source.startsWith("data:")) {
        // data URI base64
        const matches = source.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches)
            throw new Error("无效的 data URI 格式");
        contentType = matches[1];
        buffer = Buffer.from(matches[2], "base64");
        fileName = `image-${Date.now()}.${mime.extension(contentType) || "jpg"}`;
    }
    else if (looksLikeLocalPath) {
        // 本地路径
        buffer = await fs.readFile(source);
        contentType = mime.lookup(source) || "image/jpeg";
        fileName = path.basename(source);
    }
    else {
        // 纯 base64（无 data: 前缀）
        buffer = Buffer.from(source, "base64");
        contentType = "image/jpeg";
        fileName = `image-${Date.now()}.jpg`;
    }
    return { buffer, contentType, fileName };
};
/**
 * 上传图片到 Cloudflare R2，自动转换为静态WebP/PNG，智能处理动图
 * @param {string} source - 支持三种格式：
 *   1. 本地路径: "/path/to/image.jpg"
 *   2. base64 数据: "data:image/jpeg;base64,xxxx..." 或纯 base64 字符串
 *   3. 远程 URL: "https://example.com/image.png"
 * @param {string} [key] - 可选，自定义文件名（不含路径），默认用时间戳+随机
 * @param {ImageProcessOptions} [processOptions] - 图片处理选项
 * @returns {Promise<string>} 公共 URL
 */
const uploadImageToR2 = async (source, key, processOptions = {}) => {
    // 1. 获取原始图片数据
    const { buffer: originalBuffer, contentType: originalContentType, fileName: originalFileName, } = await getImageBuffer(source);
    // 2. 预处理图片（转换格式、压缩、处理动图）
    const { buffer: processedBuffer, contentType, format, wasAnimated, } = await preprocessImage(originalBuffer, originalContentType, processOptions);
    // 4. 创建S3客户端
    const s3Client = new S3Client({
        region: "auto",
        endpoint: R2_CONFIG.endpoint,
        credentials: {
            accessKeyId: R2_CONFIG.accessKeyId,
            secretAccessKey: R2_CONFIG.secretAccessKey,
        },
        maxAttempts: 3,
    });
    // 5. 生成对象key（使用新格式的扩展名）
    const extension = format; // webp/png/jpeg
    const baseFileName = originalFileName.replace(/\.[^/.]+$/, "");
    const objectKey = buildR2ObjectKey(key, baseFileName, extension);
    // 6. 上传
    const command = new PutObjectCommand({
        Bucket: R2_CONFIG.bucket,
        Key: objectKey,
        Body: processedBuffer,
        ContentType: contentType,
    });
    await s3Client.send(command);
    // 7. 返回公共URL
    const publicUrl = `${R2_CONFIG.publicDomain}/${objectKey}`;
    // 添加处理日志
    const animatedMessage = wasAnimated ? " (原为动图，已取第一帧)" : "";
    console.log(`上传成功: ${publicUrl} [原始: ${originalContentType}, 转换后: ${contentType}${animatedMessage}]`);
    return publicUrl;
};
/**
 * 上传音频或视频文件到 Cloudflare R2，支持本地路径和远程URL
 * @param {string} filePath - 本地文件路径
 * @param {string} [key] - 可选，自定义文件名（不含路径），默认用时间戳+随机
 */
const uploadMediaToR2 = async (filePath, key) => {
    // 1. 读取文件数据（支持本地路径和远程URL）
    let buffer;
    let contentType;
    let originalFileName;
    if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
        // 远程 URL
        const response = await fetch(filePath);
        if (!response.ok)
            throw new Error(`下载文件失败: ${response.statusText}`);
        buffer = Buffer.from(await response.arrayBuffer());
        contentType =
            response.headers.get("content-type") ||
                mime.lookup(filePath) ||
                "application/octet-stream";
        originalFileName =
            path.basename(new URL(filePath).pathname) || `media-${Date.now()}`;
    }
    else {
        // 本地路径
        buffer = await fs.readFile(filePath);
        contentType = mime.lookup(filePath) || "application/octet-stream";
        originalFileName = path.basename(filePath);
    }
    // 2. 创建S3客户端
    const s3Client = new S3Client({
        region: "auto",
        endpoint: R2_CONFIG.endpoint,
        credentials: {
            accessKeyId: R2_CONFIG.accessKeyId,
            secretAccessKey: R2_CONFIG.secretAccessKey,
        },
        maxAttempts: 3,
    });
    // 3. 生成对象key
    const extension = path.extname(originalFileName) || ".bin";
    const baseFileName = originalFileName.replace(/\.[^/.]+$/, "");
    const objectKey = buildR2ObjectKey(key, baseFileName, extension);
    // 4. 上传
    const command = new PutObjectCommand({
        Bucket: R2_CONFIG.bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: contentType,
    });
    await s3Client.send(command);
    // 5. 返回公共URL
    const publicUrl = `${R2_CONFIG.publicDomain}/${objectKey}`;
    console.log(`上传成功: ${publicUrl} (Content-Type: ${contentType})`);
    return publicUrl;
};
/**
 * 工具函数：设置默认图片处理选项
 */
const setImageProcessOptions = {
    /**
     * 转换为WebP格式（默认）
     */
    toWebP: (options) => ({
        format: "webp",
        ...options,
    }),
    /**
     * 转换为PNG格式
     */
    toPNG: (options) => ({
        format: "png",
        ...options,
    }),
    /**
     * 转换为JPEG格式
     */
    toJPEG: (options) => ({
        format: "jpeg",
        ...options,
    }),
    /**
     * 动图处理策略
     */
    animated: {
        /**
         * 取第一帧（默认）
         */
        firstFrame: (options) => ({
            animatedBehavior: "first-frame",
            ...options,
        }),
        /**
         * 报错
         */
        error: (options) => ({
            animatedBehavior: "error",
            ...options,
        }),
        /**
         * 保持原样
         */
        keep: (options) => ({
            animatedBehavior: "keep",
            ...options,
        }),
    },
};

export { getImageBuffer, setImageProcessOptions, uploadImageToR2, uploadMediaToR2 };
