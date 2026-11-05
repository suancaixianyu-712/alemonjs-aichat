import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import mime from "mime-types";
import sharp from "sharp"; // 需要安装: npm install sharp
import { getAiChatConfigValue } from "./config/app";
import { getOpenAIProxyFetch } from "./api/openaiProxy";
import {
  buildRemoteImageFetchHeaders,
  formatImageDownloadError,
  isLikelyLocalImagePath,
  normalizeRemoteImageUrl,
  qqMultimediaHttpFallbackUrl,
} from "./api/image-source";
import redisClient from "./config";
const value = getAiChatConfigValue();

const R2_CONFIG = {
  accessKeyId: "f8f0d360d3156a1667c527c5ea4b18d7",
  secretAccessKey:
    "365f44cf6079054ad99923dd32966d0aba4e4d2d24726cadcd0102a7c2e7bc08",
  bucket: "images",
  publicDomain: "https://r2img.ccxk.top",
  endpoint: "https://b24a196dc2ee578845bb555d53812508.r2.cloudflarestorage.com",
};

const sanitizeR2FileName = (name: string) =>
  name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "");

/** 生成唯一 object key 片段：时间戳 + 随机串，避免同名覆盖（如 download.webp） */
const randomObjectId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 构建 R2 对象 key。
 * - 传入 key 时：使用自定义名（仍做安全化）
 * - 未传 key 时：始终用时间戳+随机，避免源文件名相同（如 CDN 的 /download）互相覆盖
 */
const buildR2ObjectKey = (
  key: string | undefined,
  _fallbackBaseName: string,
  extension: string,
) => {
  const normalizedExtension = extension.startsWith(".")
    ? extension
    : `.${extension}`;
  if (key?.trim()) {
    const parsed = path.parse(key.trim());
    const safeBaseName =
      sanitizeR2FileName(parsed.name || key.trim() || "file") || "file";
    return `${safeBaseName}${normalizedExtension}`;
  }
  return `${randomObjectId()}${normalizedExtension}`;
};

/**
 * 图片处理选项
 */
interface ImageProcessOptions {
  maxWidth?: number; // 最大宽度，默认 1920
  maxHeight?: number; // 最大高度，默认 1080
  quality?: number; // 质量，默认 80 (1-100)
  format?: "webp" | "png" | "jpeg"; // 输出格式，默认 webp
  animatedBehavior?: "error" | "first-frame" | "keep"; // 动图处理方式：报错/取第一帧/保持原样（默认取第一帧）
}

/**
 * 判断是否为动画图片并获取信息
 * @param buffer 图片buffer
 * @returns 动画信息和metadata
 */
const getImageAnimationInfo = async (
  buffer: Buffer,
): Promise<{
  isAnimated: boolean;
  frameCount?: number;
  metadata: sharp.Metadata;
}> => {
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
  } catch {
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
const preprocessImage = async (
  buffer: Buffer,
  contentType: string,
  options: ImageProcessOptions = {},
): Promise<{
  buffer: Buffer;
  contentType: string;
  format: string;
  wasAnimated: boolean;
}> => {
  const {
    maxWidth = 1920,
    maxHeight = 1080,
    quality = 80,
    format = "webp",
    animatedBehavior = "first-frame", // 默认取第一帧
  } = options;

  // 检查是否为动画
  const { isAnimated, frameCount } = await getImageAnimationInfo(buffer);

  // 是否需要保留全部帧（动图）
  let preserveAnimation = false;

  // 处理动图
  if (isAnimated) {
    console.log(
      `检测到动图，共 ${frameCount} 帧，处理方式: ${animatedBehavior}`,
    );

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
    let processedBuffer: Buffer;
    let finalContentType: string;

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
  } catch (error) {
    console.error("图片处理失败:", error);
    throw new Error("图片格式不支持或处理失败");
  }
};

/**
 * 从各种源获取图片buffer
 */
export const getImageBuffer = async (
  source: string,
): Promise<{
  buffer: Buffer;
  contentType: string;
  fileName: string;
}> => {
  let buffer: Buffer;
  let contentType: string;
  let fileName: string;
  const looksLikeLocalPath = isLikelyLocalImagePath(source);

  if (source.startsWith("http://") || source.startsWith("https://")) {
    // 远程 URL（QQ 图床等需要浏览器 UA，裸 node UA 常直接 400）
    let url = normalizeRemoteImageUrl(source);

    const isXAIImage = url.startsWith("https://imgen.x.ai");
    if (isXAIImage && value.xaiImgProxy) {
      url = url.replace("https://imgen.x.ai", value.xaiImgProxy);
    }

    const grokConfig = isXAIImage
      ? await redisClient.getProviderAIConfig("grok")
      : null;
    const requestFetch =
      isXAIImage && !value.xaiImgProxy
        ? getOpenAIProxyFetch(
            value.httpProxy,
            await redisClient.isToolProxyEnabled(grokConfig),
          ) || fetch
        : fetch;

    const fetchImage = (target: string) =>
      requestFetch(target, { headers: buildRemoteImageFetchHeaders(target) });

    let response = await fetchImage(url);
    if (!response.ok) {
      if (url.startsWith("https://img.suancaixianyu.cn")) {
        url = url.replace(
          "https://img.suancaixianyu.cn",
          "https://r2.scbbs.top",
        );
        response = await fetchImage(url);
      }
    }
    if (!response.ok) {
      const httpFallback = qqMultimediaHttpFallbackUrl(url);
      if (httpFallback && httpFallback !== url) {
        const fallbackResponse = await fetchImage(httpFallback);
        if (fallbackResponse.ok) {
          response = fallbackResponse;
          url = httpFallback;
        }
      }
    }
    if (!response.ok) {
      throw new Error(formatImageDownloadError(response, url));
    }

    buffer = Buffer.from(await response.arrayBuffer());
    contentType =
      response.headers.get("content-type") ||
      mime.lookup(source) ||
      "image/jpeg";
    fileName =
      path.basename(new URL(url).pathname) || `image-${Date.now()}.jpg`;
  } else if (source.startsWith("data:")) {
    // data URI base64
    const matches = source.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches) throw new Error("无效的 data URI 格式");

    contentType = matches[1];
    buffer = Buffer.from(matches[2], "base64");
    fileName = `image-${Date.now()}.${mime.extension(contentType) || "jpg"}`;
  } else if (looksLikeLocalPath) {
    // 本地路径
    buffer = await fs.readFile(source);
    contentType = mime.lookup(source) || "image/jpeg";
    fileName = path.basename(source);
  } else {
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
export const uploadImageToR2 = async (
  source: string,
  key?: string,
  processOptions: ImageProcessOptions = {},
): Promise<string> => {
  // 1. 获取原始图片数据
  const {
    buffer: originalBuffer,
    contentType: originalContentType,
    fileName: originalFileName,
  } = await getImageBuffer(source);

  // 2. 预处理图片（转换格式、压缩、处理动图）
  const {
    buffer: processedBuffer,
    contentType,
    format,
    wasAnimated,
  } = await preprocessImage(
    originalBuffer,
    originalContentType,
    processOptions,
  );

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
  console.log(
    `上传成功: ${publicUrl} [原始: ${originalContentType}, 转换后: ${contentType}${animatedMessage}]`,
  );

  return publicUrl;
};

/**
 * 上传音频或视频文件到 Cloudflare R2，支持本地路径和远程URL
 * @param {string} filePath - 本地文件路径
 * @param {string} [key] - 可选，自定义文件名（不含路径），默认用时间戳+随机
 */
export const uploadMediaToR2 = async (
  filePath: string,
  key?: string,
): Promise<string> => {
  // 1. 读取文件数据（支持本地路径和远程URL）
  let buffer: Buffer;
  let contentType: string;
  let originalFileName: string;

  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    // 远程 URL（与图片下载一致，避免 QQ CDN 拒 node UA）
    let url = normalizeRemoteImageUrl(filePath);
    let response = await fetch(url, {
      headers: buildRemoteImageFetchHeaders(url),
    });
    if (!response.ok) {
      const httpFallback = qqMultimediaHttpFallbackUrl(url);
      if (httpFallback && httpFallback !== url) {
        const fallbackResponse = await fetch(httpFallback, {
          headers: buildRemoteImageFetchHeaders(httpFallback),
        });
        if (fallbackResponse.ok) {
          response = fallbackResponse;
          url = httpFallback;
        }
      }
    }
    if (!response.ok) {
      throw new Error(
        formatImageDownloadError(response, url).replace(
          "下载图片失败",
          "下载文件失败",
        ),
      );
    }

    buffer = Buffer.from(await response.arrayBuffer());
    contentType =
      response.headers.get("content-type") ||
      mime.lookup(filePath) ||
      "application/octet-stream";
    originalFileName =
      path.basename(new URL(url).pathname) || `media-${Date.now()}`;
  } else {
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
export const setImageProcessOptions = {
  /**
   * 转换为WebP格式（默认）
   */
  toWebP: (
    options?: Omit<ImageProcessOptions, "format">,
  ): ImageProcessOptions => ({
    format: "webp",
    ...options,
  }),

  /**
   * 转换为PNG格式
   */
  toPNG: (
    options?: Omit<ImageProcessOptions, "format">,
  ): ImageProcessOptions => ({
    format: "png",
    ...options,
  }),

  /**
   * 转换为JPEG格式
   */
  toJPEG: (
    options?: Omit<ImageProcessOptions, "format">,
  ): ImageProcessOptions => ({
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
    firstFrame: (
      options?: Omit<ImageProcessOptions, "animatedBehavior">,
    ): ImageProcessOptions => ({
      animatedBehavior: "first-frame",
      ...options,
    }),

    /**
     * 报错
     */
    error: (
      options?: Omit<ImageProcessOptions, "animatedBehavior">,
    ): ImageProcessOptions => ({
      animatedBehavior: "error",
      ...options,
    }),

    /**
     * 保持原样
     */
    keep: (
      options?: Omit<ImageProcessOptions, "animatedBehavior">,
    ): ImageProcessOptions => ({
      animatedBehavior: "keep",
      ...options,
    }),
  },
};
