import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import mime from "mime-types";

// ======== 配置 ========
// 请替换成你真实的 R2 API Token 凭证
// const R2_CONFIG = {
//   accessKeyId: "f8f0d360d3156a1667c527c5ea4b18d7", // ← 必须替换！从 R2 API Tokens 获取
//   secretAccessKey:
//     "365f44cf6079054ad99923dd32966d0aba4e4d2d24726cadcd0102a7c2e7bc08", // ← 确认这是 Secret Access Key
//   bucket: "images",
//   publicDomain: "https://r2img.ccxk.top", // ← 改成你的公共域名（推荐）
//   endpoint: "https://b24a196dc2ee578845bb555d53812508.r2.cloudflarestorage.com", // R2 固定格式
// };

const R2_CONFIG = {
  accessKeyId: "pCLV51yDLbntzsfUkgBSjo5fJSor3nr5", // ← 必须替换！从 R2 API Tokens 获取
  secretAccessKey: "5672e62135be31808f1afbd35862839e", // ← 确认这是 Secret Access Key
  bucket: "schub-image",
  publicDomain: "https://s3img.suancaixianyu.cn", // ← 改成你的公共域名（推荐）
  endpoint: "https://s3.api.upyun.com", // R2 固定格式
};

const s3Client = new S3Client({
  region: "auto", // R2 固定用 auto
  endpoint: R2_CONFIG.endpoint,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
  maxAttempts: 3, // 自动重试
});

/**
 * 上传图片到 Cloudflare R2，返回公共访问 URL
 * @param {string} source - 支持三种格式：
 *   1. 本地路径: "/path/to/image.jpg"
 *   2. base64 数据: "data:image/jpeg;base64,xxxx..." 或纯 base64 字符串
 *   3. 远程 URL: "https://example.com/image.png"
 * @param {string} [key] - 可选，自定义文件名（不含路径），默认用时间戳+随机
 * @returns {Promise<string>} 公共 URL
 */
export const uploadImageToR2 = async (
  source: string,
  key?: string,
): Promise<string> => {
  let buffer;
  let contentType = "image/jpeg"; // 默认
  let fileName;

  // 1. 处理不同来源 → 统一得到 Buffer + contentType + fileName
  if (source.startsWith("http://") || source.startsWith("https://")) {
    // 远程 URL
    const response = await fetch(source);
    if (!response.ok) throw new Error(`下载图片失败: ${response.statusText}`);

    buffer = Buffer.from(await response.arrayBuffer());
    contentType =
      response.headers.get("content-type") ||
      mime.lookup(source) ||
      "image/jpeg";
    fileName =
      path.basename(new URL(source).pathname) || `image-${Date.now()}.jpg`;
  } else if (source.startsWith("data:")) {
    // data URI base64
    const matches = source.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches) throw new Error("无效的 data URI 格式");

    contentType = matches[1];
    buffer = Buffer.from(matches[2], "base64");
    fileName = `image-${Date.now()}.${mime.extension(contentType) || "jpg"}`;
  } else if (source.includes("/") || source.includes("\\")) {
    // 本地路径
    buffer = await fs.readFile(source);
    contentType = mime.lookup(source) || "image/jpeg";
    fileName = path.basename(source);
  } else {
    // 纯 base64（无 data: 前缀）
    buffer = Buffer.from(source, "base64");
    fileName = `image-${Date.now()}.jpg`;
  }

  // 2. 生成对象 key（文件名）
  const objectKey =
    key ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${mime.extension(contentType) || "jpg"}`;

  // 3. 上传
  const command = new PutObjectCommand({
    Bucket: R2_CONFIG.bucket,
    Key: objectKey,
    Body: buffer, // 或 Readable.from(buffer) 如果是大文件
    ContentType: contentType,
    // 如果 bucket 已设为 public-read，可加：
    // ACL: "public-read",          // 但 R2 更推荐用 bucket 设置 + 自定义域名
  });

  await s3Client.send(command);

  // 4. 返回公共 URL
  // 推荐方式：用自定义域名或 r2.dev 公共域名（需在 R2 设置允许 public access）
  const publicUrl = `${R2_CONFIG.publicDomain}/${objectKey}`;

  console.log(`上传成功: ${publicUrl}`);
  return publicUrl;
};
