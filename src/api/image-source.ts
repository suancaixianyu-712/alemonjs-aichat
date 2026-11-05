/** 判断字符串是否应按本地文件路径读取，而不是按纯 Base64 解码。 */
export const isLikelyLocalImagePath = (source: string) =>
  source.length < 4096 &&
  /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(source);

/** Node fetch 默认 UA 为 "node"，QQ 图床会直接 400 Bad Request。 */
export const BROWSER_IMAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const QQ_IMAGE_HOST_RE =
  /(?:^|\.)(?:nt\.qq\.com\.cn|qq\.com|qpic\.cn|qlogo\.cn)$/i;

export const isQqImageHost = (hostname: string) =>
  QQ_IMAGE_HOST_RE.test(String(hostname || "").toLowerCase());

/**
 * 规范化远程图片 URL：去缩略图后缀、还原 HTML 实体、去掉空白。
 */
export const normalizeRemoteImageUrl = (source: string): string => {
  let url = String(source || "").trim();
  if (!url) return "";
  url = url
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/!\/fwfh\/\d+x\d+/g, "");
  return url;
};

/**
 * 为远程图片下载构造请求头。QQ multimedia / qpic 对缺 UA/Referer 的请求常返回 400。
 */
export const buildRemoteImageFetchHeaders = (
  source: string,
): Record<string, string> => {
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_IMAGE_USER_AGENT,
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  };

  try {
    const parsed = new URL(normalizeRemoteImageUrl(source));
    if (isQqImageHost(parsed.hostname)) {
      headers.Referer = `${parsed.protocol}//${parsed.hostname}/`;
    }
  } catch {
    // URL 非法时仍带浏览器 UA，避免裸 node UA
  }

  return headers;
};

/**
 * QQ multimedia HTTPS 在部分 TLS 环境下会失败；官方也常给 HTTP 可用链。
 * 仅对 multimedia.nt.qq.com.cn 做 https→http 回退。
 */
export const qqMultimediaHttpFallbackUrl = (source: string): string | null => {
  try {
    const parsed = new URL(normalizeRemoteImageUrl(source));
    if (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "multimedia.nt.qq.com.cn"
    ) {
      parsed.protocol = "http:";
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
};

export const formatImageDownloadError = (
  response: { status: number; statusText: string },
  source: string,
): string => {
  let host = "";
  try {
    host = new URL(normalizeRemoteImageUrl(source)).host;
  } catch {
    host = "";
  }
  const statusText = String(response.statusText || "").trim() || "Error";
  const where = host ? ` (${host})` : "";
  return `下载图片失败: HTTP ${response.status} ${statusText}${where}`;
};
