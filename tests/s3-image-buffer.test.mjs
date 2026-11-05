import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_IMAGE_USER_AGENT,
  buildRemoteImageFetchHeaders,
  formatImageDownloadError,
  isLikelyLocalImagePath,
  isQqImageHost,
  normalizeRemoteImageUrl,
  qqMultimediaHttpFallbackUrl,
} from "../lib/api/image-source.js";

test("R2 上传把不带点前缀的相对图片识别为本地路径", () => {
  assert.equal(
    isLikelyLocalImagePath("public/image_out/generated-image.png"),
    true,
  );
  assert.equal(isLikelyLocalImagePath("generated-image.jpg"), true);
  assert.equal(isLikelyLocalImagePath("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"), false);
  assert.equal(isLikelyLocalImagePath("/9j/4AAQSkZJRgABAQAAAQABAAD="), false);
});

test("normalizeRemoteImageUrl 还原 HTML 实体并去掉缩略图后缀", () => {
  assert.equal(
    normalizeRemoteImageUrl(
      "https://multimedia.nt.qq.com.cn/download?appid=1&amp;fileid=abc!/fwfh/368x238",
    ),
    "https://multimedia.nt.qq.com.cn/download?appid=1&fileid=abc",
  );
});

test("QQ 图床请求头带浏览器 UA 和 Referer", () => {
  const headers = buildRemoteImageFetchHeaders(
    "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=x",
  );
  assert.equal(headers["User-Agent"], BROWSER_IMAGE_USER_AGENT);
  assert.equal(headers.Referer, "https://multimedia.nt.qq.com.cn/");
  assert.match(headers.Accept, /image\//);

  const other = buildRemoteImageFetchHeaders("https://r2img.ccxk.top/a.webp");
  assert.equal(other["User-Agent"], BROWSER_IMAGE_USER_AGENT);
  assert.equal(other.Referer, undefined);
});

test("isQqImageHost 识别常见 QQ 图床域名", () => {
  assert.equal(isQqImageHost("multimedia.nt.qq.com.cn"), true);
  assert.equal(isQqImageHost("gchat.qpic.cn"), true);
  assert.equal(isQqImageHost("r2img.ccxk.top"), false);
});

test("qqMultimediaHttpFallbackUrl 仅对 multimedia https 回退 http", () => {
  assert.equal(
    qqMultimediaHttpFallbackUrl(
      "https://multimedia.nt.qq.com.cn/download?appid=1&fileid=x",
    ),
    "http://multimedia.nt.qq.com.cn/download?appid=1&fileid=x",
  );
  assert.equal(
    qqMultimediaHttpFallbackUrl("https://gchat.qpic.cn/foo.jpg"),
    null,
  );
});

test("formatImageDownloadError 带上 HTTP 状态与 host", () => {
  assert.equal(
    formatImageDownloadError(
      { status: 400, statusText: "Bad Request" },
      "https://multimedia.nt.qq.com.cn/download?appid=1",
    ),
    "下载图片失败: HTTP 400 Bad Request (multimedia.nt.qq.com.cn)",
  );
});
