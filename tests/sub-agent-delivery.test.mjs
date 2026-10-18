import assert from "node:assert/strict";
import { mock, test } from "node:test";

const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;

// ---------- CApiReply 集成用的 mock（同 tests/empty-at.test.mjs 思路） ----------
const state = { requests: [], history: [], lock: null };
const overrides = {
  getCurrentAI: async () => null,
  acquireAIToolLoop: async (guid, userID) => {
    if (state.lock) return false;
    state.lock = { guid, userID };
    return true;
  },
  releaseAIToolLoop: async () => { state.lock = null; return true; },
  getAIToolLoopState: async () => state.lock,
  addAIChatHistory: async (_g, m) => { state.history.push(m); },
  addAIChatHistoryBatch: async (_g, m) => { state.history.push(...m); },
  drainAIGuidanceMessages: async () => [],
  sanitizeChatMessages: (m) => m,
  isAIProxyEnabled: () => false,
  getLoadedToolNames: async () => [],
  getAutoToolNames: async () => [],
  getToolUsage: async () => ({}),
  getCAPIContextLimit: async () => 100000,
  getAIChatHistory: async () => [],
};
const redisClient = new Proxy(overrides, {
  get: (target, key) => (key in target ? target[key] : async () => null),
});
mock.module(moduleUrl("config"), { defaultExport: redisClient, namedExports: { DEFAULT_CAPI_CONTEXT_LIMIT: 0 } });
mock.module(moduleUrl("redis"), { namedExports: { redis: {} } });
mock.module(moduleUrl("s3"), { namedExports: { uploadImageToR2: async (u) => u, uploadMediaToR2: async () => "" } });
mock.module("@alemonjs/onebot", { namedExports: { API: class {} } });
const cfg = {
  config: { host: "http://x", key: "k", model: "m", systemPrompt: "" },
  toolConfig: { toolSwitch: "0", cApiToolList: [], allToolList: [], disabledToolNames: [], toolSearchMode: "dynamic" },
  historyMessages: [], systemPrompt: "", userPermissionPrompt: "", botIdentityPrompt: "", botName: "小咸鱼",
};
const realCfgModule = await import(moduleUrl("response/zreply/getChatConfig"));
mock.module(moduleUrl("response/zreply/getChatConfig"), { namedExports: {
  ...realCfgModule,
  getChatConfig: async () => cfg,
  shouldSkipAIReply: async () => false,
  buildUserMessage: async () => { throw new Error("内部报告回合不应构建用户消息"); },
} });
const { default: _realOpenAIDefault, ...realOpenAI } = await import("openai");
mock.module("openai", { namedExports: { ...realOpenAI }, defaultExport: class {
  constructor() {
    this.chat = { completions: { create: async (params) => {
      state.requests.push(params);
      return { choices: [{ message: { role: "assistant", content: "小咸鱼:查好了，结果是 42" } }] };
    } } };
  }
} });

const delivery = await import(moduleUrl("api/sub-agent-delivery"));
const { CApiReply } = await import(moduleUrl("response/zreply/capi"));

// ---------- 纯投递模块的 fake 依赖 ----------
const makeDeps = (opts = {}) => {
  const log = { turns: [], guidance: [], history: [], sent: [] };
  const deps = {
    debounceMs: 20,
    text: (v) => ({ type: "Text", value: v }),
    mention: (u) => ({ type: "Mention", value: u }),
    getActiveTurn: opts.getActiveTurn ?? (async () => null),
    addGuidance: async (guid, data, platform) => { log.guidance.push({ guid, data, platform }); },
    addHistory: async (guid, m) => { log.history.push({ guid, m }); },
    sendDirect: async (target, payload) => { log.sent.push({ target, payload }); },
    startTurn: opts.startTurn ?? (async (event, output) => {
      log.turns.push(event);
      await output.send([{ type: "Text", value: "AI 回复" }]);
      return { next: false };
    }),
  };
  return { deps, log };
};

const groupRecord = (extra = {}) => ({
  id: "sub_abcdef123456", guid: "group-A", platform: "onebot", spaceId: "A", userID: "u1", messageId: "m-100",
  isPrivate: false, isMaster: false, task: "查一下 README 里的版本号", status: "completed", notify: true,
  result: "版本号是 1.0.97。sub_abcdef123456 已完成，整理给主对话即可。", ...extra,
});
const privateRecord = (extra = {}) => groupRecord({ guid: "private-u2", spaceId: undefined, userID: "u2", isPrivate: true, ...extra });

test("空闲：启动一轮主 AI 回复，原始结果不直接发送；报告为 system 角色", async () => {
  const { deps, log } = makeDeps();
  const d = delivery.createSubAgentDelivery(deps);
  await d.deliver(groupRecord());
  assert.equal(log.turns.length, 1);
  assert.equal(log.sent.length, 1);
  assert.deepEqual(log.sent[0].payload.map((p) => p.value), ["u1", "AI 回复"]);
  assert.ok(!JSON.stringify(log.sent).includes("1.0.97"), "原始结果不应直接发送");
  const sys = log.turns[0].__internalSystemMessage;
  assert.equal(sys.role, "system");
  assert.match(sys.content, /版本号是 1\.0\.97/);
  assert.match(sys.content, /不是用户发言/);
});

test("内部措辞被去除：任务ID、整理给主对话即可、子任务报告", () => {
  const msg = delivery.buildSubAgentReportMessage([groupRecord({ result: "【后台子任务报告:sub_abcdef123456】结果 OK。请整理给主对话即可。(taskID: sub_abcdef123456)" })]);
  assert.ok(!/sub_[a-z0-9]+/i.test(msg.content));
  assert.ok(!msg.content.includes("整理给主对话即可"));
  assert.ok(!msg.content.includes("子任务报告"));
  assert.match(msg.content, /结果 OK/);
});

test("报告写入历史前截断到 ≤2000 字符（含截断标记），完整结果仍在记录里", () => {
  const full = "x".repeat(5000);
  const record = groupRecord({ result: full });
  const msg = delivery.buildSubAgentReportMessage([record]);
  const body = msg.content.slice(msg.content.indexOf("任务："));
  assert.ok(body.length <= 2000, String(body.length));
  assert.match(body, /报告过长已截断/);
  assert.equal(record.result.length, 5000);
  assert.ok(delivery.truncateReport(full).length <= 2000);
});

test("运行中：写入 guidance（system 角色），不额外起一轮", async () => {
  const { deps, log } = makeDeps({ getActiveTurn: async () => ({ userID: "u9" }) });
  await delivery.createSubAgentDelivery(deps).deliver(groupRecord());
  assert.equal(log.turns.length, 0);
  assert.equal(log.sent.length, 0);
  assert.equal(log.guidance.length, 1);
  assert.equal(log.guidance[0].guid, "group-A");
  assert.equal(log.guidance[0].data.capiMessage.role, "system");
});

test("失败 / 取消：notify 只发一行短通知，不起主 AI 回合", async () => {
  for (const status of ["failed", "cancelled"]) {
    const { deps, log } = makeDeps();
    await delivery.createSubAgentDelivery(deps).deliver(groupRecord({ status, result: undefined, error: "很长的错误堆栈\n".repeat(50) }));
    assert.equal(log.turns.length, 0);
    assert.equal(log.sent.length, 1);
    const texts = log.sent[0].payload.filter((p) => p.type === "Text").map((p) => p.value);
    assert.equal(texts.length, 1);
    assert.ok(!texts[0].includes("\n") && texts[0].length <= 60, texts[0]);
    assert.match(texts[0], status === "cancelled" ? /已取消/ : /失败/);
    assert.equal(log.history[0].m.role, "system");
  }
  const { deps, log } = makeDeps();
  await delivery.createSubAgentDelivery(deps).deliver(groupRecord({ status: "failed", notify: false, error: "x" }));
  assert.equal(log.sent.length, 0);
});

test("两个子agent几乎同时完成：只合并成一轮主 AI 回复", async () => {
  const { deps, log } = makeDeps();
  const d = delivery.createSubAgentDelivery(deps);
  await Promise.all([
    d.deliver(groupRecord({ id: "sub_111111111111", result: "结果甲" })),
    new Promise((r) => setTimeout(r, 5)).then(() => d.deliver(groupRecord({ id: "sub_222222222222", result: "结果乙" }))),
  ]);
  assert.equal(log.turns.length, 1);
  const content = log.turns[0].__internalSystemMessage.content;
  assert.match(content, /结果甲/);
  assert.match(content, /结果乙/);
  assert.equal(log.sent.length, 1);
});

test("回到发起会话：群聊引用原消息并 @ 发起人；私聊发给发起人；不使用当前活跃群", async () => {
  const { deps, log } = makeDeps();
  const d = delivery.createSubAgentDelivery(deps);
  await d.deliver(groupRecord());
  assert.deepEqual(log.sent[0].target, { isPrivate: false, userID: "u1", spaceId: "A", replyId: "m-100" });
  assert.equal(log.sent[0].payload[0].type, "Mention");
  assert.equal(log.turns[0].guid, "group-A");
  assert.equal(log.turns[0].SpaceId, "A");
  assert.equal(log.turns[0].UserId, "u1");
  assert.equal(log.turns[0].MessageId, "m-100");

  await d.deliver(privateRecord());
  assert.deepEqual(log.sent[1].target, { isPrivate: true, userID: "u2" });
  assert.ok(!log.sent[1].payload.some((p) => p.type === "Mention"));
  assert.equal(log.turns[1].name, "private.message.create");
  assert.equal(log.turns[1].guid, "private-u2");
  for (const s of log.sent) assert.notEqual(s.target.spaceId, "B");
});

test("用户消息与空闲回合竞争：抢锁失败时并入 guidance，不会双回复", async () => {
  // 空闲检查通过后，用户消息先拿到锁 → startTurn 返回 busy
  const { deps, log } = makeDeps({ startTurn: async (event) => { log.turns.push(event); return { busy: true }; } });
  await delivery.createSubAgentDelivery(deps).deliver(groupRecord());
  assert.equal(log.sent.length, 0);
  assert.equal(log.guidance.length, 1);
});

test("集成：真实 CApiReply + 共享 NX 锁，报告以 system 注入、回复回到发起群，竞争时只有一轮", async () => {
  const sent = [];
  const d = delivery.createSubAgentDelivery({
    debounceMs: 10,
    text: (v) => ({ type: "Text", value: v }),
    mention: (u) => ({ type: "Mention", value: u }),
    getActiveTurn: (g, p) => redisClient.getAIToolLoopState(g, p),
    addGuidance: async (guid, data) => { state.guidance = [...(state.guidance || []), data]; },
    addHistory: async () => undefined,
    sendDirect: async (target, payload) => { sent.push({ target, payload }); },
    startTurn: (event, output) => CApiReply(event, output),
  });
  state.requests = []; state.history = []; state.lock = null; state.guidance = [];
  await d.deliver(groupRecord());
  assert.equal(state.requests.length, 1);
  const last = state.requests[0].messages.at(-1);
  assert.equal(last.role, "system");
  assert.ok(!/sub_[a-z0-9]+|整理给主对话即可/.test(last.content));
  assert.ok(state.history.some((m) => m.role === "system") && !state.history.some((m) => m.role === "user"));
  assert.equal(sent.length >= 1, true);
  assert.equal(sent[0].target.spaceId, "A");
  assert.equal(sent[0].target.replyId, "m-100");
  assert.equal(state.lock, null);

  // 用户回合持有锁时完成 → 不另起回合
  state.requests = []; state.lock = { guid: "group-A", userID: "u7" };
  const before = sent.length;
  await d.deliver(groupRecord());
  assert.equal(state.requests.length, 0);
  assert.equal(sent.length, before);
  assert.equal(state.guidance.length, 1);
  state.lock = null;
});

test("SubAgent 工具派遣时记录发起来源（含原消息 ID）", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/api/sub-agent.ts", import.meta.url), "utf8");
  assert.match(src, /messageId: ctx\.messageId/);
  for (const f of ["capi", "res"]) {
    const s = (await import("node:fs")).readFileSync(new URL(`../src/response/zreply/${f}.ts`, import.meta.url), "utf8");
    assert.match(s, /functionArgs\.messageId = \(e as any\)\.MessageId/);
  }
});
