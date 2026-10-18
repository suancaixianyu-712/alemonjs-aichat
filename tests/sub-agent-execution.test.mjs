import assert from "node:assert/strict";
import { mock, test } from "node:test";
const url = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;
const store = new Map(), notices = [], delivered = [], requests = [];
let mode = "capi", resolveDelivery;
let acknowledgeFirst = false;
const secret = "private-secret-do-not-log";
const complete = async (params) => {
  requests.push(params);
  const second = params.messages.some((message) => message.role === "tool");
  if (acknowledgeFirst && !params.messages.some((message) => String(message.content || "").includes("你就是负责执行任务的子agent"))) {
    return { choices: [{ message: { content: "已派后台执行，稍后通知。" } }] };
  }
  return { choices: [{ message: second ? { content: "已检查，磁盘剩余 42 GB。" } : {
    content: "", tool_calls: [{ id: "tool-1", function: { name: "RunServerCommand", arguments: JSON.stringify({ command: `echo ${secret}` }) } }],
    _rapiOutput: [{ type: "reasoning", encrypted_content: "opaque-reasoning" }],
  } }] };
};
mock.module("openai", { defaultExport: class { chat = { completions: { create: complete } }; } });
mock.module("alemonjs", { namedExports: {
  ResultCode: { Ok: 2000 }, Text: (value) => ({ type: "Text", value }), Mention: (value) => ({ type: "Mention", value }),
  MessageDirect: { create: () => ({
    sendToUser: async (payload) => { notices.push(payload); return [{ code: 2000 }]; },
    sendToChannel: async () => { throw new Error("不应投递到其他群"); },
  }) },
} });
const redisClient = {
  redis: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value), zadd: async () => {}, expire: async () => {}, zremrangebyrank: async () => {} },
  getAIConfig: async () => ({ host: "http://test.invalid", key: secret, model: "gpt-5", apiMode: mode }),
  getAgentSwitch: async () => "0", getToolStatus: async () => "0", isToolProxyEnabled: async () => false,
  getDeepThoughtEffort: async () => "high",
};
mock.module(url("config"), { defaultExport: redisClient });
mock.module(url("config/app"), { namedExports: { getAiChatConfigValue: () => ({}) } });
mock.module(url("api/openaiProxy"), { namedExports: { getOpenAIProxyFetch: () => undefined } });
mock.module(url("api/runtime-instance"), { namedExports: { PROCESS_INSTANCE_ID: "test-instance" } });
mock.module(url("response/zreply/rapi"), { namedExports: { requestRapiCompletion: async ({ params }) => complete(params) } });
mock.module(url("api/aitools"), { namedExports: {
  tools: [{ type: "function", function: { name: "RunServerCommand" } }],
  availableTools: { RunServerCommand: async (args) => {
    assert.equal(args.ownerPrivate, true);
    assert.equal(args.isMaster, true);
    return { success: true, output: `token=${secret}` };
  } },
  assertAgentToolAccess: async (_name, guid) => guid,
  assertGroupFullToolAccess: async () => false,
  removePublicIpFromToolArguments: () => {}, removePublicIpFromOutput: (text) => text,
} });
const actualDelivery = await import(url("api/sub-agent-delivery"));
mock.module(url("api/sub-agent-delivery"), { namedExports: { ...actualDelivery,
  createSubAgentDelivery: () => ({ deliver: async (record) => { delivered.push(record); resolveDelivery(record); } }),
} });
const { spawnSubAgent } = await import(url("api/sub-agent"));

test("真实子任务循环自动记录进度、发送通知并继承思考参数，不输出任务/工具原文", { timeout: 3000 }, async (t) => {
  const logs = [];
  t.mock.method(console, "info", (...parts) => logs.push(parts.join(" ")));
  for (mode of ["capi", "rapi"]) {
    requests.length = 0;
    const done = new Promise((resolve) => { resolveDelivery = resolve; });
    await spawnSubAgent({ guid: `private-${mode}`, userID: "owner", platform: "onebot", isPrivate: true, isMaster: true }, { task: `检查系统，参考信息 ${secret}` });
    const record = await done;
    assert.equal(record.status, "completed");
    assert.match(record.result, /磁盘剩余 42 GB/);
    assert.ok(record.activity.some((line) => /RunServerCommand 成功/.test(line)));
    assert.equal(JSON.stringify(record.activity).includes(secret), false);
    assert.deepEqual(requests[0][mode === "rapi" ? "reasoning" : "reasoning_effort"], mode === "rapi" ? { effort: "high" } : "medium");
    assert.ok(requests[1].messages.some((message) => message._rapiOutput?.[0]?.encrypted_content === "opaque-reasoning"));
  }
  assert.ok(logs.some((line) => /开始 RunServerCommand/.test(line)));
  assert.ok(notices.some((item) => JSON.stringify(item).includes("已启动")));
  assert.ok(notices.some((item) => JSON.stringify(item).includes("已完成")));
  assert.equal(JSON.stringify({ logs, notices }).includes(secret), false);
  assert.equal(delivered.length, 2);
});

test("子任务只回复已派后台时会被要求实际执行，不能假完成", { timeout: 3000 }, async (t) => {
  t.mock.method(console, "info", () => {});
  acknowledgeFirst = true;
  requests.length = 0;
  try {
    const done = new Promise((resolve) => { resolveDelivery = resolve; });
    await spawnSubAgent({ guid: "private-nudge", userID: "owner", platform: "onebot", isPrivate: true, isMaster: true }, { task: "检查系统状态" });
    const record = await done;
    assert.equal(record.status, "completed");
    assert.match(record.result, /磁盘剩余 42 GB/);
    assert.equal(record.rounds, 3);
    assert.ok(record.activity.some((line) => /开始 RunServerCommand/.test(line)));
  } finally { acknowledgeFirst = false; }
});
