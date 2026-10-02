import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, test, mock } from "node:test";

const values = new Map();
const hashes = new Map();
const aiConfigs = new Map([
  ["openai/gpt-test", { host: "https://api.openai.com/v1", key: "secret-test-key", useProxy: true }],
  ["other/gpt-test", { host: "https://example.invalid/v1", key: "other-secret", useProxy: false }],
]);
const sent = [];
const writes = [];
mock.module("alemonjs", { namedExports: {
  Audio: (value) => ({ type: "Audio", value }),
  Text: (value) => ({ type: "Text", value }),
} });
const redis = {
  get: async (key) => values.get(key) ?? null,
  set: async (key, value, ...args) => { values.set(key, value); writes.push([key, value, ...args]); },
  del: async (...keys) => { for (const key of keys) values.delete(key); },
  hget: async (key, field) => hashes.get(key)?.get(field) ?? null,
  hset: async (key, field, value) => { if (!hashes.has(key)) hashes.set(key, new Map()); hashes.get(key).set(field, value); },
  hvals: async (key) => [...(hashes.get(key)?.values() ?? [])],
};
mock.module(new URL("../lib/config.js", import.meta.url).href, { defaultExport: {
  redis,
  getAIList: async () => [...aiConfigs.keys()],
  getAIDisplayNames: async (names) => names,
  getAIListConfig: async (name) => aiConfigs.get(name) ?? null,
  isAIProxyEnabled: (config) => config?.useProxy === true,
  getToolProxySwitch: async () => values.get("ai:tool_proxy:switch") || "0",
  isToolProxyEnabled: async (config) =>
    config?.useProxy === true || (values.get("ai:tool_proxy:switch") || "0") === "1",
} });
mock.module(new URL("../lib/config/app.js", import.meta.url).href, { namedExports: {
  getAiChatConfigValue: () => ({ httpProxy: "http://127.0.0.1:7897" }),
} });
mock.module(new URL("../lib/utils/command-message.js", import.meta.url).href, { namedExports: {
  useMessage: () => [{ send: async (payload) => sent.push(payload) }],
} });
let uploadedPath;
let uploadError = false;
mock.module(new URL("../lib/s3.js", import.meta.url).href, { namedExports: {
  uploadMediaToR2: async (file) => {
    uploadedPath = file;
    assert.equal((await readFile(file)).toString(), "ID3speech");
    if (uploadError) throw new Error("模拟上传失败");
    return "https://example.invalid/speech.mp3";
  },
} });
globalThis.onSelects = (values) => values;
globalThis.onResponse = (_, handler) => handler;
globalThis.format = (...items) => items;
const config = await import("../lib/api/speech-config.js");
const { handleSpeechMessage, getSpeechSessionKey } = await import("../lib/response/speech/res.js");
const { generateSpeech } = await import("../lib/api/speech-tool.js");
const event = { Platform: "onebot", guid: "group-1", UserId: "user-1" };
const command = (msg, overrides = {}) => handleSpeechMessage({ ...event, ...overrides, msg });
const latestText = () => sent.at(-1).map((item) => item.value).join("");

test("添加指令选择已有配置，隔离用户会话并设置十分钟过期", async () => {
  await command("#添加语音配置 gpt-4o-mini-tts");
  assert.match(latestText(), /openai\/gpt-test/);
  assert.deepEqual(writes.at(-1).slice(-2), ["EX", 600]);
  assert.equal(await command("1", { UserId: "another-user" }), false);
  await command("0");
  assert.match(latestText(), /选择无效/);
  await command("openai/gpt-test");
  assert.deepEqual(await config.getSpeechModel(), { model: "gpt-4o-mini-tts", aiName: "openai/gpt-test", voice: "alloy" });
  assert.equal(await redis.get(getSpeechSessionKey(event)), null);
  assert.doesNotMatch(JSON.stringify([...hashes.values()].map((hash) => [...hash.values()])), /secret-test-key/);
});

test("音色按模型保存，全局切换后恢复该模型音色，列表不暴露密钥", async () => {
  await command("#设置音色 nova", { guid: "group-2" });
  await command("#添加语音配置 tts-1");
  await command("2");
  assert.equal((await config.getSpeechModel()).voice, "alloy");
  await command("#设置音色 marin");
  assert.match(latestText(), /不支持音色/);
  assert.equal((await config.getSpeechModel()).voice, "alloy");
  await command("#切换语音模型 gpt-4o-mini-tts");
  assert.equal((await config.getSpeechModel()).voice, "nova");
  await command("#语音列表");
  assert.match(latestText(), /gpt-4o-mini-tts \[当前\]/);
  assert.match(latestText(), /tts-1/);
  assert.doesNotMatch(latestText(), /secret|https:/);
  await command("#切换语音模型 不存在");
  assert.match(latestText(), /未找到/);
  assert.equal((await config.getSpeechModel()).model, "gpt-4o-mini-tts");
});

test("取消和新指令退出选择流程，格式错误不修改全局配置", async () => {
  await command("#添加语音配置 tts-1-hd");
  await command("取消");
  assert.match(latestText(), /已取消/);
  assert.equal(await config.getSpeechModel("tts-1-hd"), null);
  await command("#添加语音配置 tts-1-hd");
  assert.equal(await command("#ai列表"), false);
  assert.equal(await redis.get(getSpeechSessionKey(event)), null);
  await command("#设置音色");
  assert.match(latestText(), /格式/);
  assert.equal((await config.getSpeechModel()).voice, "nova");
});

test("调用时读取最新 AI 密钥与代理开关，来源删除时返回可操作错误", async () => {
  aiConfigs.get("openai/gpt-test").key = "updated-test-key";
  const resolved = await config.resolveSpeechConfig();
  assert.equal(resolved.key, "updated-test-key");
  assert.equal(resolved.useProxy, true);
  assert.equal(resolved.httpProxy, "http://127.0.0.1:7897");
  const old = aiConfigs.get("openai/gpt-test");
  aiConfigs.delete("openai/gpt-test");
  await assert.rejects(config.resolveSpeechConfig(), /重新添加语音配置/);
  aiConfigs.set("openai/gpt-test", old);
});

test("工具代理开启后，语音配置即使所属 AI 直连也会走代理", async () => {
  const target = aiConfigs.get("openai/gpt-test");
  const original = target.useProxy;
  target.useProxy = false;
  values.set("ai:tool_proxy:switch", "1");
  try {
    const resolved = await config.resolveSpeechConfig();
    assert.equal(resolved.useProxy, true);
    assert.equal(resolved.httpProxy, "http://127.0.0.1:7897");
  } finally {
    target.useProxy = original;
    values.delete("ai:tool_proxy:switch");
  }
});

let status = 200;
const server = createServer((req, res) => {
  req.resume();
  if (status === 200) { res.writeHead(200, { "content-type": "audio/mpeg" }); res.end("ID3speech"); }
  else { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "key: updated-test-key" } })); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => { server.closeAllConnections(); server.close(); });

test("语音工具上传二进制音频，成功及上传失败都清理临时文件", async () => {
  Object.assign(aiConfigs.get("openai/gpt-test"), { host: `http://127.0.0.1:${server.address().port}/v1`, useProxy: false });
  const result = await generateSpeech({ text: "你好" });
  assert.deepEqual(result, { ok: true, type: "audio", url: "https://example.invalid/speech.mp3", model: "gpt-4o-mini-tts", voice: "nova" });
  await assert.rejects(access(uploadedPath));
  uploadError = true;
  const failed = await generateSpeech({ text: "你好" });
  assert.equal(failed.ok, false);
  await assert.rejects(access(uploadedPath));
  uploadError = false;
});

test("认证与额度错误转换为提示，不返回 SDK 原始密钥信息", async () => {
  for (const code of [401, 403, 404, 429, 400]) {
    status = code;
    const result = await generateSpeech({ text: "你好" });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /updated-test-key/);
  }
  status = 200;
});

test("中间件让语音配置与原有 AI 配置流程互斥，普通消息继续执行", async () => {
  mock.module(new URL("../lib/response/add-ai/res.js", import.meta.url).href, { namedExports: { handleAddAIMessage: async () => false } });
  mock.module(new URL("../lib/response/switch-ai/res.js", import.meta.url).href, { namedExports: { handleSwitchAIMessage: async () => false } });
  globalThis.onMiddleware = (_, handler) => handler;
  const { default: middleware } = await import("../lib/middleware/ai-config.js");
  const suffix = `${event.Platform}:${event.guid}:${event.UserId}`;
  values.set(`ai:add:session:${suffix}`, "pending");
  values.set(`ai:switch:session:${suffix}`, "pending");
  const request = { ...event, ChannelId: event.guid, MessageText: "#添加语音配置 tts-1-hd" };
  await middleware(request, () => assert.fail("配置指令不应继续进入 AI 聊天"));
  assert.equal(values.has(`ai:add:session:${suffix}`), false);
  assert.equal(values.has(`ai:switch:session:${suffix}`), false);
  assert.equal(request.Xianyu, false);
  let continued = false;
  await middleware({ ...event, ChannelId: event.guid, MessageText: "#切换AI" }, () => { continued = true; });
  assert.equal(values.has(getSpeechSessionKey(event)), false);
  assert.equal(continued, true);
});

test("连接失败时返回可排查的原因，而不是裸的 Connection error.", async () => {
    const target = aiConfigs.get("openai/gpt-test");
    const originalHost = target.host;
    Object.assign(target, { host: "http://127.0.0.1:1/v1", useProxy: false });
    try {
        const result = await generateSpeech({ text: "你好" });
        assert.equal(result.ok, false);
        assert.match(result.error, /连接失败或超时/);
        assert.match(result.error, /原因：/);
        assert.match(result.error, /ECONNREFUSED|fetch failed|connect/i);
        assert.notEqual(result.error, "Connection error.");
        assert.doesNotMatch(result.error, /^Connection error/);
    }
    finally {
        Object.assign(target, { host: originalHost });
    }
});