import assert from "node:assert/strict";
import { mock, test } from "node:test";

const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;

const state = { sent: [], modelCalls: 0, subscriptions: 0 };
const overrides = {
  getAIConfig: async () => ({ host: "http://x", key: "k", model: "m", systemPrompt: "" }),
  getAIChatHistory: async () => [],
  getAffectionLevelAll: async () => ({}),
  getRelevantMemoryContext: async () => "",
  getAvailableTools: async () => [],
  getAllToolStatus: async () => ({}),
  getLoadedToolNames: async () => [],
  getAutoToolNames: async () => [],
  getToolUsage: async () => ({}),
  getToolSearchMode: async () => "dynamic",
  getToolSwitch: async () => "0",
  sanitizeChatMessages: (m) => m,
  isAIProxyEnabled: () => false,
  subscribeNextUserMessage: async () => { state.subscriptions += 1; },
};
const redisClient = new Proxy(overrides, {
  get: (target, key) => (key in target ? target[key] : async () => null),
});
mock.module(moduleUrl("config"), { defaultExport: redisClient, namedExports: { DEFAULT_CAPI_CONTEXT_LIMIT: 0 } });
mock.module(moduleUrl("redis"), { namedExports: { redis: {} } });
mock.module(moduleUrl("s3"), { namedExports: { uploadImageToR2: async (u) => u, uploadMediaToR2: async () => "" } });
mock.module(moduleUrl("api/tool-session-controller"), { namedExports: { toolSessionController: { getCurrentTool: async () => null, getPermission: async () => null } } });
mock.module("@alemonjs/onebot", { namedExports: { API: class {} } });
const realOpenAI = await import("openai");
mock.module("openai", { namedExports: { ...realOpenAI }, defaultExport: class {
  constructor() {
    this.chat = { completions: { create: async () => { state.modelCalls += 1; throw new Error("stop"); } } };
  }
} });
const realAlemon = await import("alemonjs");
mock.module("alemonjs", { namedExports: {
  ...realAlemon,
  useMessage: () => [{ send: async (m) => { state.sent.push(m); return []; } }],
} });
globalThis.onResponse = (_s, fn) => fn;
globalThis.onSelects = (s) => s;
globalThis.format = (...a) => a;

const { isEmptyAtBotMessage } = await import(moduleUrl("api/empty-at"));
const { default: zreply } = await import(moduleUrl("response/zreply/res"));
const { CApiReply } = await import(moduleUrl("response/zreply/capi"));

const groupAt = (extra = {}) => ({
  name: "message.create", Name: "message.create",
  guid: "g1", UserId: "u1", Platform: "onebot",
  atBot: true, at: true,
  bot: { nickname: "小咸鱼", user_id: "bot" },
  msg: "", value: { raw_message: "[CQ:at,qq=123]" },
  MessageMedia: [],
  ...extra,
});

const run = async (e) => {
  state.sent = []; state.modelCalls = 0; state.subscriptions = 0;
  let nextCalls = 0;
  await zreply(e, () => { nextCalls += 1; });
  return { ...state, sent: state.sent.length, nextCalls };
};

test("纯 @ / @+空格 / @+表情：静默跳过，不发消息、不请求模型、不订阅、调用 next()", async () => {
  for (const extra of [
    {},
    { msg: "   ", value: { raw_message: "[CQ:at,qq=123]   \n " } },
    { msg: "😀👍🏻", value: { raw_message: "[CQ:at,qq=123] 😀👍🏻" } },
    { value: { raw_message: "[CQ:at,qq=123][CQ:face,id=14,raw=x]" } },
    { msg: "@小咸鱼 ", value: { raw_message: "" } },
  ]) {
    assert.equal(isEmptyAtBotMessage(groupAt(extra)), true, JSON.stringify(extra));
    const r = await run(groupAt(extra));
    assert.deepEqual(
      { sent: r.sent, modelCalls: r.modelCalls, subscriptions: r.subscriptions, nextCalls: r.nextCalls },
      { sent: 0, modelCalls: 0, subscriptions: 0, nextCalls: 1 },
      JSON.stringify(extra),
    );
  }
});

test("@ + 图片：正常请求模型", async () => {
  const e = groupAt({ value: { raw_message: "[CQ:at,qq=123][CQ:image,file=a.jpg,url=http://x/a.jpg]" } });
  assert.equal(isEmptyAtBotMessage(e), false);
  assert.equal(isEmptyAtBotMessage(groupAt({ MessageMedia: [{ Type: "image" }] })), false);
  const r = await run(e);
  assert.equal(r.modelCalls, 1);
  assert.equal(r.subscriptions, 0);
});

test("@ + 引用回复：正常请求模型", async () => {
  const e = groupAt({ reply: { message: [{ type: "text", data: { text: "原消息" } }] } });
  assert.equal(isEmptyAtBotMessage(e), false);
  assert.equal(isEmptyAtBotMessage(groupAt({ value: { raw_message: "[CQ:reply,id=1][CQ:at,qq=123]" } })), false);
  const r = await run(e);
  assert.equal(r.modelCalls, 1);
});

test("@ + 文字：正常请求模型；未 @ 或私聊不按空 @ 处理", async () => {
  const e = groupAt({ msg: "你好", value: { raw_message: "[CQ:at,qq=123] 你好" } });
  assert.equal(isEmptyAtBotMessage(e), false);
  const r = await run(e);
  assert.equal(r.modelCalls, 1);
  assert.equal(isEmptyAtBotMessage(groupAt({ atBot: false })), false);
  assert.equal(isEmptyAtBotMessage(groupAt({ name: "private.message.create", Name: "private.message.create" })), false);
});

test("capi 路径：空 @ 返回 next:true（调用方随后 next()），不发消息、不请求模型、不订阅", async () => {
  for (const extra of [{}, { msg: " 😀 ", value: { raw_message: "[CQ:at,qq=123] 😀 " } }]) {
    state.sent = []; state.modelCalls = 0; state.subscriptions = 0;
    const result = await CApiReply(groupAt(extra));
    assert.deepEqual(result, { next: true });
    assert.deepEqual([state.sent.length, state.modelCalls, state.subscriptions], [0, 0, 0]);
  }
});
