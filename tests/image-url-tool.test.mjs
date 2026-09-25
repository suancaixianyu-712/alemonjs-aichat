import assert from "node:assert/strict";
import test from "node:test";

import {
  convertToImageUrlContent,
  isImageUrlToolContent,
} from "../lib/api/image-url-tool.js";
import { convertCapiMessagesToRapiInput } from "../lib/response/zreply/rapi.js";

test("远程图片直链转换为 image_url 内容", async () => {
  const result = await convertToImageUrlContent("https://example.com/a.png");
  assert.deepEqual(result, [
    { type: "image_url", image_url: { url: "https://example.com/a.png" } },
  ]);
  assert.equal(isImageUrlToolContent(result), true);
});

test("拒绝读取 alémonjs 主工程外的相对路径", async () => {
  await assert.rejects(
    convertToImageUrlContent("../outside.png"),
    /超出 alémonjs 主工程范围/,
  );
});

test("主工程内相对图片转换为 Base64 Data URL", async () => {
  const result = await convertToImageUrlContent("src/assets/error.png");
  assert.match(result[0].image_url.url, /^data:image\/png;base64,/);
});

test("Responses API 将工具图片内容转换为实际图片输入", () => {
  const converted = convertCapiMessagesToRapiInput([
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    },
  ]);
  assert.equal(converted.input[0].type, "function_call_output");
  assert.deepEqual(converted.input[1], {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_image",
        detail: "auto",
        image_url: "https://example.com/a.png",
      },
    ],
  });
});
