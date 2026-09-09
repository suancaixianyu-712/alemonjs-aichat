const OPENCODE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * OpenCode 不接受 http(s) 附件地址，只接受它能直接读取的 file:/data: URL。
 */
export const inlineHttpFileAsDataUrl = async (
  url: string,
  fallbackMime: string,
) => {
  if (!/^https?:\/\//i.test(url)) {
    return { url, mime: fallbackMime };
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载 OpenCode 附件失败: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > OPENCODE_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `OpenCode 附件超过 20 MiB 限制: ${(buffer.length / 1024 / 1024).toFixed(1)} MiB`,
    );
  }
  const mimeType =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
    fallbackMime;
  return {
    url: `data:${mimeType};base64,${buffer.toString("base64")}`,
    mime: mimeType,
  };
};
