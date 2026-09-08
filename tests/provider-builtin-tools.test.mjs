import assert from "node:assert/strict";
import test from "node:test";

import {
  detectNativeProvider,
  getProviderBuiltinToolParams,
  isBuiltinToolEnabled,
  resolveBuiltinToolName,
  shouldDisableLocalSearchTool,
} from "../lib/response/zreply/provider-tools.js";
import {
  buildRapiRequest,
  convertRapiResponseToCapi,
} from "../lib/response/zreply/rapi.js";

const base = {
  host: "https://api.openai.com/v1",
  key: "test",
  model: "gpt-5",
  temperature: 0.7,
  max_tokens: 100,
  systemPrompt: "",
};

test("旧配置默认开启，单项覆盖优先", () => {
  assert.equal(isBuiltinToolEnabled(base, "web_search"), true);
  assert.equal(
    isBuiltinToolEnabled(
      { ...base, builtinTools: { enabled: true, overrides: { web_search: false } } },
      "web_search",
    ),
    false,
  );
  assert.equal(resolveBuiltinToolName(" 网页搜索 "), "web_search");
});

test("按 API 平台识别厂商，Qwen CAPI 注入 enable_search", () => {
  const config = {
    ...base,
    provider: "deepseek",
    host: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "deepseek-v3.2",
    apiMode: "capi",
  };
  assert.equal(detectNativeProvider(config), "qwen");
  assert.deepEqual(getProviderBuiltinToolParams(config).capiParams, {
    enable_search: true,
  });
  assert.equal(shouldDisableLocalSearchTool(config), true);
  assert.equal(
    shouldDisableLocalSearchTool({
      ...config,
      builtinTools: { overrides: { web_search: false } },
    }),
    false,
  );
});

test("RAPI 合并本地函数和厂商工具并请求搜索来源", () => {
  const request = buildRapiRequest({
    model: "gpt-5",
    messages: [{ role: "user", content: "今天有什么新闻" }],
    tools: [
      {
        type: "function",
        function: { name: "LocalTool", parameters: { type: "object" } },
      },
    ],
    builtinTools: [{ type: "web_search" }],
    builtinIncludes: ["web_search_call.action.sources"],
  });
  assert.deepEqual(
    request.tools.map((tool) => tool.type),
    ["function", "web_search"],
  );
  assert.ok(request.include.includes("web_search_call.action.sources"));
});

test("RAPI 搜索来源会补到最终文本且去重", () => {
  const converted = convertRapiResponseToCapi({
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "结果如下" }],
      },
      {
        type: "web_search_call",
        action: {
          sources: [
            { title: "示例", url: "https://example.com/a" },
            { title: "重复", url: "https://example.com/a" },
          ],
        },
      },
    ],
  });
  const content = converted.choices[0].message.content;
  assert.match(content, /参考来源/);
  assert.equal(content.match(/https:\/\/example\.com\/a/g)?.length, 1);
});
