import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGPTImageResponsesRequest,
  extractGPTImageResponseBase64,
  formatGPTImageError,
  shouldFallbackGPTImageMode,
} from "../lib/api/gptImage.js";
import {
  createOpenAIProxyFetch,
  getOpenAIProxyFetch,
} from "../lib/api/openaiProxy.js";

test("未配置代理时沿用 SDK 默认网络，配置后创建代理 fetch", () => {
  assert.equal(createOpenAIProxyFetch(), undefined);
  assert.equal(
    typeof createOpenAIProxyFetch("http://127.0.0.1:7897"),
    "function",
  );
});

test("代理 fetch 只有在持久化开关开启时才创建", () => {
  const proxyUrl = "http://127.0.0.1:7897";
  assert.equal(getOpenAIProxyFetch(proxyUrl, false), undefined);
  assert.equal(getOpenAIProxyFetch(undefined, true), undefined);
  assert.equal(typeof getOpenAIProxyFetch(proxyUrl, true), "function");
});

test("Responses API 生成模式使用主模型和独立图片模型", () => {
  const request = buildGPTImageResponsesRequest({
    chatModel: "gpt-5",
    imageModel: "gpt-image-2.5-sunburst",
    prompt: "画一只猫",
    size: "1024x1536",
    quality: "low",
  });

  assert.equal(request.model, "gpt-5");
  assert.equal(request.input, "画一只猫");
  assert.deepEqual(request.tool_choice, { type: "image_generation" });
  assert.equal(request.tools[0].model, "gpt-image-2.5-sunburst");
  assert.equal(request.tools[0].action, "generate");
});

test("Responses API 编辑模式携带输入图片", () => {
  const request = buildGPTImageResponsesRequest({
    chatModel: "gpt-5",
    imageModel: "gpt-image-2.5-sunburst",
    prompt: "改成油画",
    sourceImageUrl: "https://example.com/source.png",
    size: "1024x1536",
    quality: "low",
  });

  assert.equal(request.tools[0].action, "edit");
  assert.equal(request.input[0].content[1].type, "input_image");
  assert.equal(
    request.input[0].content[1].image_url,
    "https://example.com/source.png",
  );
});

test("提取 Responses API 返回的图片 Base64", () => {
  assert.equal(
    extractGPTImageResponseBase64({
      output: [
        { type: "message", content: [] },
        { type: "image_generation_call", result: "aW1hZ2U=" },
      ],
    }),
    "aW1hZ2U=",
  );
});

test("只对协议端点错误回退，不对模型和组织权限错误重试", () => {
  assert.equal(
    shouldFallbackGPTImageMode({ status: 404, message: "Not Found" }),
    true,
  );
  assert.equal(
    shouldFallbackGPTImageMode({
      status: 400,
      message: "The model 'gpt-image-2' does not exist.",
    }),
    false,
  );
  assert.equal(
    shouldFallbackGPTImageMode({
      status: 403,
      message: "Your organization must be verified to use the model.",
    }),
    false,
  );
});

test("组织验证错误给出可执行提示", () => {
  const message = formatGPTImageError(
    { message: "Your organization must be verified to use the model." },
    "gpt-image-2.5-sunburst",
  );
  assert.match(message, /已被接口识别/);
  assert.match(message, /Verify Organization/);
});
