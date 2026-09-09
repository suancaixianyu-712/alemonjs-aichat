import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { inlineHttpFileAsDataUrl } from "../lib/api/opencode-attachment.js";

test("OpenCode 的 HTTP 图片附件会转换成带真实 MIME 的 data URL", async (t) => {
  const image = Buffer.from("test-image-bytes");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/png; charset=binary" });
    response.end(image);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await inlineHttpFileAsDataUrl(
    `http://127.0.0.1:${address.port}/image`,
    "image/webp",
  );

  assert.equal(result.mime, "image/png");
  assert.equal(
    result.url,
    `data:image/png;base64,${image.toString("base64")}`,
  );
});

test("已经可由 OpenCode 读取的附件 URL 不重复转换", async () => {
  const source = "data:image/webp;base64,YQ==";
  assert.deepEqual(await inlineHttpFileAsDataUrl(source, "image/webp"), {
    url: source,
    mime: "image/webp",
  });
});
