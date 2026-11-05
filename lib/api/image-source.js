/** 判断字符串是否应按本地文件路径读取，而不是按纯 Base64 解码。 */
const isLikelyLocalImagePath = (source) => source.length < 4096 &&
    /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(source);
/** Node fetch 默认 UA 为 "node"，QQ 图床会直接 400 Bad Request。 */
const BROWSER_IMAGE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const QQ_IMAGE_HOST_RE = /(?:^|\.)(?:nt\.qq\.com\.cn|qq\.com|qpic\.cn|qlogo\.cn)$/i;
const isQqImageHost = (hostname) => QQ_IMAGE_HOST_RE.test(String(hostname || "").toLowerCase());
/**
 * 规范化远程图片 URL：去缩略图后缀、还原 HTML 实体、去掉空白。
 */
const normalizeRemoteImageUrl = (source) => {
    let url = String(source || "").trim();
    if (!url)
        return "";
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
const buildRemoteImageFetchHeaders = (source) => {
    const headers = {
        "User-Agent": BROWSER_IMAGE_USER_AGENT,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    };
    try {
        const parsed = new URL(normalizeRemoteImageUrl(source));
        if (isQqImageHost(parsed.hostname)) {
            headers.Referer = `${parsed.protocol}//${parsed.hostname}/`;
        }
    }
    catch {
        // URL 非法时仍带浏览器 UA，避免裸 node UA
    }
    return headers;
};
/**
 * QQ multimedia HTTPS 在部分 TLS 环境下会失败；官方也常给 HTTP 可用链。
 * 仅对 multimedia.nt.qq.com.cn 做 https→http 回退。
 */
const qqMultimediaHttpFallbackUrl = (source) => {
    try {
        const parsed = new URL(normalizeRemoteImageUrl(source));
        if (parsed.protocol === "https:" &&
            parsed.hostname.toLowerCase() === "multimedia.nt.qq.com.cn") {
            parsed.protocol = "http:";
            return parsed.toString();
        }
    }
    catch {
        return null;
    }
    return null;
};
const formatImageDownloadError = (response, source) => {
    let host = "";
    try {
        host = new URL(normalizeRemoteImageUrl(source)).host;
    }
    catch {
        host = "";
    }
    const statusText = String(response.statusText || "").trim() || "Error";
    const where = host ? ` (${host})` : "";
    return `下载图片失败: HTTP ${response.status} ${statusText}${where}`;
};

export { BROWSER_IMAGE_USER_AGENT, buildRemoteImageFetchHeaders, formatImageDownloadError, isLikelyLocalImagePath, isQqImageHost, normalizeRemoteImageUrl, qqMultimediaHttpFallbackUrl };
