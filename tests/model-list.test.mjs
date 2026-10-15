import assert from "node:assert/strict";
import { test, mock } from "node:test";

const {
  resolveModelsUrl,
  formatModelListMessage,
  fetchProviderModels,
  MODEL_LIST_FAIL_TEXT,
  MODEL_LIST_DISPLAY_LIMIT,
} = await import("../lib/api/fetch-models.js");

test("host normalization: strip trailing slash; keep single /v1", () => {
  assert.equal(
    resolveModelsUrl("https://api.openai.com/v1/"),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    resolveModelsUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    resolveModelsUrl("https://custom.example.com"),
    "https://custom.example.com/models",
  );
  assert.equal(
    resolveModelsUrl("https://custom.example.com/"),
    "https://custom.example.com/models",
  );
  // 不重复追加 /v1
  assert.doesNotMatch(
    resolveModelsUrl("https://api.openai.com/v1"),
    /\/v1\/v1\//,
  );
  assert.equal(
    resolveModelsUrl("https://api.x.ai/v1", {
      provider: "grok",
      modelsPath: "/language-models",
    }),
    "https://api.x.ai/v1/language-models",
  );
});

test("formatModelListMessage sorts caller list and truncates over 40", () => {
  const many = Array.from({ length: 45 }, (_, i) => `m${String(i).padStart(2, "0")}`);
  const text = formatModelListMessage(many, { title: "当前配置可用模型" });
  assert.match(text, /^当前配置可用模型：/);
  assert.match(text, /1\. m00/);
  assert.match(text, new RegExp(`${MODEL_LIST_DISPLAY_LIMIT}\\. m39`));
  assert.doesNotMatch(text, /m40/);
  assert.match(text, /共 45 个，已显示前 40 个/);
});

test("fetchProviderModels uses session host (not provider preset) and sorts ids", async () => {
  const urls = [];
  const models = await fetchProviderModels({
    host: "https://my-gateway.example/v1",
    key: "sk-test",
    provider: "openai",
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "zeta" },
            { id: "alpha" },
            { id: "text-embedding-3" },
            { id: "beta" },
          ],
        }),
      };
    },
  });
  assert.deepEqual(urls, ["https://my-gateway.example/v1/models"]);
  assert.deepEqual(models, ["alpha", "beta", "zeta"]);
});

test("fetchProviderModels empty host/key throws", async () => {
  await assert.rejects(
    () => fetchProviderModels({ host: "", key: "k" }),
    /missing host or key/,
  );
  await assert.rejects(
    () => fetchProviderModels({ host: "https://x", key: "" }),
    /missing host or key/,
  );
});

// ---- command handler tests ----
const sent = [];
const configs = new Map();
const fetchCalls = [];
let modelsResult = ["b-model", "a-model"];
let modelsError = null;

mock.module("alemonjs", {
  namedExports: {
    Text: (value) => ({ type: "Text", value }),
  },
});
mock.module(new URL("../lib/config.js", import.meta.url).href, {
  defaultExport: {
    getAIConfig: async (guid) =>
      configs.get(guid) || { host: "", key: "", model: "", provider: "other" },
    isAIProxyEnabled: (config) => config?.useProxy === true,
    getDeepThoughtEffort: async () => "none",
    setDeepThoughtEffort: async () => {},
    getDeepThoughtSwitch: async () => "0",
    setDeepThoughtSwitch: async () => {},
  },
});
mock.module(new URL("../lib/config/app.js", import.meta.url).href, {
  namedExports: {
    getAiChatConfigValue: () => ({ httpProxy: "http://127.0.0.1:7897" }),
  },
});
mock.module(new URL("../lib/api/ai-lock.js", import.meta.url).href, {
  namedExports: { getLockedAIMessage: () => "locked" },
});
mock.module(new URL("../lib/utils/command-message.js", import.meta.url).href, {
  namedExports: {
    useMessage: () => [
      {
        send: async (payload) => {
          sent.push(payload);
        },
      },
    ],
  },
});
mock.module(new URL("../lib/api/fetch-models.js", import.meta.url).href, {
  namedExports: {
    MODEL_LIST_FAIL_TEXT,
    formatModelListMessage,
    fetchProviderModels: async (options) => {
      fetchCalls.push(options);
      if (modelsError) throw modelsError;
      return modelsResult;
    },
  },
});
// deep-thought still needed by setting/res
mock.module(new URL("../lib/api/deep-thought.js", import.meta.url).href, {
  namedExports: {
    formatDeepThoughtDisplay: (e) => (e === "none" ? "关闭" : e),
    isDeepThoughtEffort: () => false,
    listDeepThoughtEffortsText: () => "none",
    normalizeDeepThoughtEffort: (e) => e,
  },
});

globalThis.onSelects = (values) => values;
globalThis.onResponse = (_selects, handler) => handler;
globalThis.format = (...items) => items;

const handleSetting = (await import("../lib/response/setting/res.js")).default;
const latestText = () =>
  sent
    .at(-1)
    .map((item) => item.value)
    .join("");

const run = async (msg, overrides = {}) => {
  sent.length = 0;
  fetchCalls.length = 0;
  await handleSetting(
    {
      guid: "g1",
      UserId: "u1",
      IsMaster: true,
      name: "message.create",
      msg,
      ...overrides,
    },
    () => {},
  );
};

test("#模型列表 owner-only", async () => {
  configs.set("g1", {
    host: "https://custom.example/v1",
    key: "sk",
    provider: "other",
  });
  await run("#模型列表", { IsMaster: false });
  assert.match(latestText(), /仅主人可用/);
  assert.equal(fetchCalls.length, 0);
});

test("#模型列表 missing host/key → 获取模型列表失败", async () => {
  configs.set("g1", { host: "", key: "sk", provider: "openai" });
  await run("#模型列表");
  assert.equal(latestText(), MODEL_LIST_FAIL_TEXT);
  assert.equal(fetchCalls.length, 0);

  configs.set("g1", { host: "https://x/v1", key: "", provider: "openai" });
  await run("#模型列表");
  assert.equal(latestText(), MODEL_LIST_FAIL_TEXT);
  assert.equal(fetchCalls.length, 0);
});

test("#模型列表 uses session host/key and lists models", async () => {
  modelsResult = ["zeta", "alpha"];
  modelsError = null;
  configs.set("g1", {
    host: "https://session-host.example/v1",
    key: "sk-session",
    provider: "openai",
    useProxy: true,
  });
  await run("#模型列表");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].host, "https://session-host.example/v1");
  assert.equal(fetchCalls[0].key, "sk-session");
  assert.equal(fetchCalls[0].provider, "openai");
  assert.equal(fetchCalls[0].useProxy, true);
  // 不得改用厂商预设 host
  assert.doesNotMatch(String(fetchCalls[0].host), /api\.openai\.com/);
  assert.match(latestText(), /当前配置可用模型/);
  assert.match(latestText(), /1\. zeta|1\. alpha/);
});

test("#模型列表 empty or thrown → 获取模型列表失败", async () => {
  configs.set("g1", {
    host: "https://session-host.example/v1",
    key: "sk",
    provider: "other",
  });
  modelsResult = [];
  modelsError = null;
  await run("#模型列表");
  assert.equal(latestText(), MODEL_LIST_FAIL_TEXT);

  modelsError = new Error("network");
  await run("#模型列表");
  assert.equal(latestText(), MODEL_LIST_FAIL_TEXT);
});

test("#模型列表 works in private chat", async () => {
  modelsResult = ["m1"];
  modelsError = null;
  configs.set("g1", {
    host: "https://p.example/v1",
    key: "sk",
    provider: "other",
  });
  await run("#模型列表", { name: "private.message.create" });
  assert.match(latestText(), /m1/);
});
