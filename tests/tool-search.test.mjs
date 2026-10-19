import assert from "node:assert/strict";
import { mock, test } from "node:test";

const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;
mock.module(moduleUrl("config"), { defaultExport: { redis: { get: async () => null } } });
mock.module(moduleUrl("redis"), { namedExports: { redis: {} } });
mock.module(moduleUrl("s3"), { namedExports: { uploadImageToR2: async () => "", uploadMediaToR2: async () => "" } });
mock.module("@alemonjs/onebot", { namedExports: { API: class {} } });
const { tools } = await import(moduleUrl("api/aitools"));
const ts = await import(moduleUrl("api/tool-search"));

const names = tools.map((tool) => tool.function.name);
const allNames = new Set(names);
const def = (name) => tools.find((tool) => tool.function.name === name);

/** 常见意图 → 期望出现在 top 结果中的工具（描述精简前后应一致） */
export const MATCH_CASES = [
  ["画图", ["GPTGenerateImage", "GrokGenerateImage"]],
  ["上传R2", ["AgentUploadFileToR2"]],
  ["定时", ["ScheduleAITask"]],
  ["运行命令", ["RunServerCommand"]],
  ["联网搜索最新新闻", ["LocalBrowser"]],
  ["生成语音", ["GenerateSpeech"]],
  ["识别图片里的文字", ["DescribeImage"]],
  ["克隆git仓库", ["AgentCloneRepository"]],
  ["记住我的生日", ["MemoryOperation"]],
  ["修改代码文件", ["AgentReplaceFileRange"]],
  ["玩扫雷", ["XianyuGame"]],
  ["让codex写代码", ["RunCodex"]],
  ["读取附件链接", ["ReadRemoteFile"]],
  ["解析压缩包", ["ReadChatFile"]],
  ["派一个后台子代理", ["SubAgent"]],
];

test("每个已注册工具都有 20 字以内的手写简介", () => {
  for (const name of names) {
    const summary = ts.TOOL_META[name]?.summary;
    assert.ok(summary, `${name} 缺少 summary`);
    assert.ok([...summary].length <= 20, `${name} summary 超过 20 字`);
  }
});

test("常见意图命中期望工具", () => {
  for (const [query, expected] of MATCH_CASES) {
    const result = ts.searchTools(tools, allNames, query);
    const hit = result.tools.map((t) => t.name);
    for (const name of expected) assert.ok(hit.includes(name), `${query} → ${hit.join(",")}`);
  }
});

test("别名命中：生图 → 图片工具；关闭的工具返回 available:false 且不加载", () => {
  const available = new Set(names.filter((n) => n !== "GrokGenerateImage"));
  const result = ts.searchTools(tools, available, "生图", new Set(["GrokGenerateImage"]));
  const grok = result.tools.find((t) => t.name === "GrokGenerateImage");
  assert.equal(grok.available, false);
  assert.equal(grok.reason, "当前已关闭，无法使用");
  assert.ok(!result.loadNames.includes("GrokGenerateImage"));
  assert.ok(result.loadNames.includes("GPTGenerateImage"));
  assert.ok(result.tools.length <= 5);
  for (const t of result.tools) assert.equal(t.parameters, undefined);
});

test("无关查询低于阈值不返回", () => {
  assert.equal(ts.searchTools(tools, allNames, "zzqqxx").tools.length, 0);
});

test("空/全部 列出所有工具简介，不加载 schema，关闭工具标记不可用", () => {
  for (const q of ["", "全部", "所有", "all"]) {
    const loaded = new Set();
    const run = ts.createSearchToolRunner({ allTools: tools, availableNames: new Set(["LocalBrowser"]), loadedToolNames: loaded });
    const res = run({ query: q });
    assert.equal(res.tools.length, names.length);
    assert.deepEqual(Object.keys(res.tools[0]).sort(), ["available", "brief", "name"]);
    assert.equal(res.tools.find((t) => t.name === "RunCodex").available, false);
    assert.equal(loaded.size, 0);
  }
});

test("search_tools 每轮最多 3 次，第 4 次直接拒绝", () => {
  const loaded = new Set();
  const run = ts.createSearchToolRunner({ allTools: tools, availableNames: allNames, loadedToolNames: loaded });
  for (let i = 0; i < 3; i++) assert.equal(run({ query: "定时" }).ok, true);
  const fourth = run({ query: "画图" });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.error, ts.SEARCH_LIMIT_MESSAGE);
  assert.ok(!loaded.has("GPTGenerateImage"));
  assert.ok(loaded.has("ScheduleAITask"));
});

test("getTurnTools: full 模式全量，dynamic 模式常驻 + 已加载，并与内部白名单取交集", () => {
  const available = tools.filter((t) => t.function.name !== "EvalCode");
  const full = ts.buildTurnTools({ mode: "full", availableTools: available });
  assert.equal(full.length, available.length);
  assert.ok(!full.some((t) => t.function.name === "search_tools"));

  const dyn = ts.buildTurnTools({ mode: "dynamic", availableTools: available, loadedToolNames: new Set(["ScheduleAITask"]) });
  assert.deepEqual(dyn.map((t) => t.function.name), ["search_tools", "LocalBrowser", "ReadChatFile", "RunServerCommand", "ScheduleAITask"]);
  assert.deepEqual(dyn[0], ts.searchToolDefinition);

  const noBrowser = available.filter((t) => t.function.name !== "LocalBrowser");
  assert.deepEqual(
    ts.buildTurnTools({ mode: "dynamic", availableTools: noBrowser }).map((t) => t.function.name),
    ["search_tools", "ReadChatFile", "RunServerCommand"],
  );
  const allowed = ts.buildTurnTools({ mode: "dynamic", availableTools: available, allowedToolNames: new Set(["LocalBrowser"]) });
  assert.deepEqual(allowed.map((t) => t.function.name), ["search_tools", "LocalBrowser"]);
  assert.equal(ts.buildTurnTools({ mode: "full", availableTools: available, allowedToolNames: new Set(["RunCodex"]) }).length, 1);
});

test("自动常驻：≥5 次、取前 3、排除固定常驻/search_tools/已关闭", () => {
  const usage = { RunCodex: 9, ScheduleAITask: 7, MemoryOperation: 6, XianyuGame: 5, SubAgent: 4, LocalBrowser: 50, search_tools: 99 };
  const available = new Set(names.filter((n) => n !== "RunCodex"));
  assert.deepEqual(ts.pickAutoAlwaysOnTools(usage, available), ["ScheduleAITask", "MemoryOperation", "XianyuGame"]);
  assert.deepEqual(ts.pickAutoAlwaysOnTools({ SubAgent: 4 }, allNames), []);
});

test("只有成功执行且非 search_tools 才计数", () => {
  assert.equal(ts.shouldCountToolUsage("RunCodex", { ok: true }), true);
  assert.equal(ts.shouldCountToolUsage("RunCodex", "文本结果"), true);
  assert.equal(ts.shouldCountToolUsage("RunCodex", { ok: false, error: "x" }), false);
  assert.equal(ts.shouldCountToolUsage("search_tools", { ok: true }), false);
});

test("常驻集合按名字稳定排序，按需加载只追加在后面", () => {
  const a = ts.buildTurnTools({ mode: "dynamic", availableTools: tools, autoToolNames: ["XianyuGame", "MemoryOperation"], loadedToolNames: ["SubAgent", "AgentWriteFile"] });
  const b = ts.buildTurnTools({ mode: "dynamic", availableTools: [...tools].reverse(), autoToolNames: ["MemoryOperation", "XianyuGame"], loadedToolNames: ["SubAgent", "AgentWriteFile"] });
  const order = ["search_tools", "LocalBrowser", "MemoryOperation", "ReadChatFile", "RunServerCommand", "XianyuGame", "SubAgent", "AgentWriteFile"];
  assert.deepEqual(a.map((t) => t.function.name), order);
  assert.deepEqual(b.map((t) => t.function.name), order);
});

test("缓存的自动常驻/已加载工具被关闭后，下一次请求立即剔除", () => {
  const cachedAuto = ["XianyuGame"];
  const cachedLoaded = ["SubAgent"];
  const before = ts.buildTurnTools({ mode: "dynamic", availableTools: tools, autoToolNames: cachedAuto, loadedToolNames: cachedLoaded });
  assert.ok(before.some((t) => t.function.name === "XianyuGame"));
  const live = tools.filter((t) => !["XianyuGame", "SubAgent"].includes(t.function.name));
  const after = ts.buildTurnTools({ mode: "dynamic", availableTools: live, autoToolNames: cachedAuto, loadedToolNames: cachedLoaded });
  assert.deepEqual(after.map((t) => t.function.name), ["search_tools", "LocalBrowser", "ReadChatFile", "RunServerCommand"]);
});

test("工具轮数：只调用 search_tools 不计轮；超限强制 tool_choice none", () => {
  assert.equal(ts.countsTowardToolRound([{ function: { name: "search_tools" } }]), false);
  assert.equal(ts.countsTowardToolRound([{ function: { name: "search_tools" } }, { function: { name: "RunCodex" } }]), true);
  const forced = ts.buildForcedFinalParams({ tools: [def("RunCodex")], tool_choice: "auto" });
  assert.equal(forced.tool_choice, "none");
  assert.equal(ts.buildForcedFinalParams({ tool_choice: "auto" }).tool_choice, undefined);
});

const fakeStore = (init = {}) => {
  const data = { loaded: init.loaded ?? [], auto: init.auto ?? null, usage: init.usage ?? {}, counted: [] };
  return {
    data,
    getLoadedToolNames: async () => data.loaded,
    setLoadedToolNames: async (_g, names) => { data.loaded = names; },
    getAutoToolNames: async () => data.auto,
    setAutoToolNames: async (_g, names) => { data.auto = names; },
    getToolUsage: async () => data.usage,
    incrementToolUsage: async (_g, name) => { data.counted.push(name); },
  };
};

test("共享回合状态（capi/res 共用）：搜索加载持久化、上限、兜底加入、成功计数", async () => {
  const store = fakeStore({ usage: { XianyuGame: 6 } });
  const live = tools.filter((t) => t.function.name !== "RunCodex");
  const state = await ts.createTurnToolState({
    guid: "g", store, mode: "dynamic", toolSwitch: "1",
    availableTools: live, allTools: tools, disabledToolNames: ["RunCodex"],
  });
  assert.deepEqual(state.getTurnTools().map((t) => t.function.name), ["search_tools", "LocalBrowser", "ReadChatFile", "RunServerCommand", "XianyuGame"]);
  assert.deepEqual(store.data.auto, ["XianyuGame"]);
  assert.equal(state.handles("search_tools"), true);
  const res = await state.runSearchTools({ query: "定时" });
  assert.equal(res.ok, true);
  assert.ok(store.data.loaded.includes("ScheduleAITask"));
  assert.equal(state.getTurnTools().at(-1).function.name, "ScheduleAITask");
  const codex = (await state.runSearchTools({ query: "codex" })).tools.find((t) => t.name === "RunCodex");
  assert.equal(codex.available, false);
  await state.runSearchTools({ query: "画图" });
  assert.equal((await state.runSearchTools({ query: "画图" })).error, ts.SEARCH_LIMIT_MESSAGE);
  await state.afterToolExecuted("SubAgent", { ok: true });
  await state.afterToolExecuted("MemoryOperation", { ok: false });
  assert.ok(store.data.loaded.includes("SubAgent"));
  assert.deepEqual(store.data.counted, ["SubAgent"]);

  const full = await ts.createTurnToolState({ guid: "g", store: fakeStore(), mode: "full", toolSwitch: "1", availableTools: live, allTools: tools });
  assert.equal(full.handles("search_tools"), false);
  assert.equal(full.getTurnTools().length, live.length);
});

test("工具轮数守卫（capi/res 共用）：search_tools 轮不计数，达上限强制 none 并丢弃工具调用", () => {
  const guard = ts.createToolRoundGuard(2);
  const search = [{ function: { name: "search_tools" } }];
  const real = [{ function: { name: "RunCodex" } }];
  const params = { tools: [def("RunCodex")], tool_choice: "auto" };
  assert.equal(guard.record(search), 0);
  assert.equal(guard.record(real), 1);
  assert.equal(guard.prepareParams(params).tool_choice, "auto");
  const normal = { choices: [{ message: { content: "", tool_calls: [{ id: "1" }] } }] };
  assert.equal(guard.finishResponse(normal), false);
  assert.equal(normal.choices[0].message.tool_calls.length, 1);
  guard.record(real);
  assert.equal(guard.reached, true);
  assert.equal(guard.prepareParams(params).tool_choice, "none");
  assert.equal(params.tool_choice, "auto");
  const final = { choices: [{ message: { content: "收尾", tool_calls: [{ id: "2" }] } }] };
  assert.equal(guard.finishResponse(final), true);
  assert.equal(final.choices[0].message.tool_calls, undefined);
  assert.equal(final.choices[0].message.content, "收尾");
  assert.equal(ts.createToolRoundGuard().prepareParams(params), params);
});

test("达上限的收尾回复为空/仅工具调用时使用兜底文本", () => {
  const guard = ts.createToolRoundGuard(1);
  guard.record([{ function: { name: "RunCodex" } }]);
  for (const message of [
    { content: "", tool_calls: [{ id: "1" }] },
    { content: "  \n\t ", tool_calls: [{ id: "2" }] },
    { content: null, tool_calls: [{ id: "3" }] },
    { tool_calls: [{ id: "4" }] },
  ]) {
    const res = { choices: [{ message }] };
    assert.equal(guard.finishResponse(res), true);
    assert.equal(res.choices[0].message.tool_calls, undefined);
    assert.equal(res.choices[0].message.content, ts.TOOL_ROUND_LIMIT_FALLBACK);
    assert.equal(res.choices[0].message.content, "已达工具轮次上限，请缩小问题后重试");
  }
  const kept = { choices: [{ message: { content: "好的，总结如下" } }] };
  guard.finishResponse(kept);
  assert.equal(kept.choices[0].message.content, "好的，总结如下");
});
