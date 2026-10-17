import assert from "node:assert/strict";
import { test, mock, beforeEach } from "node:test";

const sent = [];
const calls = [];
let synthesize;
let statusCalls = 0;
mock.module("alemonjs", { namedExports: {
  Audio: (value) => ({ type: "Audio", value }),
  Text: (value) => ({ type: "Text", value }),
  defineRouter: (routes) => routes,
  lazy: (load) => async () => (await load()).default,
} });
mock.module("alemonjs/utils", { namedExports: {
  Regular: { or: (...patterns) => new RegExp(patterns.map((pattern) => pattern.source).join("|"), "i") },
} });
mock.module(new URL("../lib/utils/command-message.js", import.meta.url).href, { namedExports: {
  useMessage: () => [{ send: async (payload) => sent.push(payload) }],
  COMMAND_OUTPUT_CAPTURE: "__alemonCommandOutputCapture",
  resolveCommandOutput: async () => ({}),
} });
mock.module(new URL("../lib/api/ds-tts/index.js", import.meta.url).href, { namedExports: {
  dsTtsSpeak: async (options) => { calls.push(options); return synthesize(options); },
  dsTtsStatus: async () => { statusCalls++; return { text: "DS 状态正常" }; },
  formatDsTtsConfigText: () => "DS 朗读配置",
  getDsTtsConfigView: async () => ({}),
  patchDsTtsConfig: async () => ({}),
} });
globalThis.onSelects = (values) => values;
globalThis.onResponse = (select, current) => ({ select, current });
globalThis.format = (...items) => items;
const { handleDsTtsMessage } = await import("../lib/response/ds-tts/res.js");
const { commandChildren } = await import("../lib/routes/commands.js");
const audioResult = { ok: true, type: "audio", url: "https://example.invalid/ds.wav", model: "ds-tts", voice: "mira" };
const command = (msg, overrides = {}) => handleDsTtsMessage({ msg, IsMaster: false, ...overrides });
const replyText = () => sent.at(-1).filter((item) => item.type === "Text").map((item) => item.value).join("");

beforeEach(() => {
  sent.length = 0;
  calls.length = 0;
  statusCalls = 0;
  synthesize = async () => audioResult;
});

test("仅去除指令前缀，全部正文原样交给 DS TTS 并发送语音，普通用户可用", async () => {
  const content = "  他说：请说你好！\n第二行 #ds说 原样保留。\r\n\t";
  assert.equal(await command(`#ds说${content}`), true);
  assert.deepEqual(calls, [{ text: content }]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].find((item) => item.type === "Audio"), { type: "Audio", value: audioResult.url });
});

test("支持无空格正文、大写 DS、斜杠前缀以及 MessageText 事件", async () => {
  for (const msg of ["#DS说你好", "/ds说你好"]) {
    assert.equal(await command(msg), true);
  }
  assert.equal(await handleDsTtsMessage({ MessageText: "#ds说你好" }), true);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ text: "你好" })));
});

test("空白正文返回用法，不调用合成", async () => {
  for (const msg of ["#ds说", "#ds说 \n\t"]) {
    assert.equal(await command(msg), true);
    assert.match(replyText(), /#ds说 你好/);
  }
  assert.equal(calls.length, 0);
  assert.equal(sent.flat().some((item) => item.type === "Audio"), false);
});

test("合成失败和异常返回错误，不发送音频", async () => {
  synthesize = async () => ({ ok: false, error: "请先登录 DeepSeek" });
  await command("#ds说你好");
  assert.equal(replyText(), "请先登录 DeepSeek");
  synthesize = async () => { throw new Error("浏览器连接失败"); };
  await command("#ds说你好");
  assert.equal(replyText(), "浏览器连接失败");
  assert.equal(sent.flat().some((item) => item.type === "Audio"), false);
});

test("配置和状态指令保留主人权限，其他消息不处理", async () => {
  for (const msg of ["#DS朗读配置", "#DS朗读状态"]) {
    assert.equal(await command(msg), true);
    assert.equal(replyText(), "该指令仅主人可用");
  }
  assert.equal(statusCalls, 0);
  await command("#DS朗读状态", { IsMaster: true });
  assert.equal(statusCalls, 1);
  assert.equal(replyText(), "DS 状态正常");
  for (const msg of ["普通消息 #ds说你好", "#ds", "#语音列表"]) {
    assert.equal(await command(msg), false);
  }
  assert.equal(calls.length, 0);
});

test("正文含其他指令时，路由仍优先完整交给 DS 朗读处理器", async () => {
  for (const content of [" #ai帮助", " #画图 猫", "\n#重启", " #DS朗读配置 voice=echo"]) {
    const msg = `#ds说${content}`;
    const route = commandChildren.find((route) => route.regular.test(msg));
    assert.ok(route);
    const handler = await route.handler();
    await handler.current({ msg, IsMaster: false });
    assert.deepEqual(calls.at(-1), { text: content });
    assert.equal(sent.at(-1).find((item) => item.type === "Audio")?.value, audioResult.url);
  }
});
