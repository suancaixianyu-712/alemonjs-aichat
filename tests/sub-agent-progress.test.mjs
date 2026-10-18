import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubAgentProgress } from "../lib/api/sub-agent-progress.js";

const create = (overrides = {}) => {
  const sent = [], logs = [], activity = [];
  const progress = createSubAgentProgress({
    id: "sub_123456abcdef", notify: true,
    send: async (text) => { sent.push(text); },
    log: (text) => logs.push(text), onActivity: (text) => activity.push(text),
    ...overrides,
  });
  return { progress, sent, logs, activity };
};

test("任务阶段实时记录终端，聊天合并进度，参数与结果原文不进入日志", async () => {
  const { progress, sent, logs, activity } = create();
  const secret = "private-token-123";
  progress.emit({ type: "started", task: secret });
  progress.emit({ type: "thinking", round: 1 });
  progress.emit({ type: "tool_start", round: 1, tool: "RunServerCommand", arguments: secret });
  progress.emit({ type: "tool_finish", round: 1, tool: "RunServerCommand", success: true, durationMs: 1234, result: secret });
  await progress.flush();
  assert.equal(sent.length, 2);
  assert.match(sent[0], /已启动/);
  assert.match(sent[1], /RunServerCommand 成功（1\.2秒）/);
  assert.equal(logs.length, 4);
  assert.equal(activity.length, 4);
  assert.equal(JSON.stringify({ sent, logs, activity }).includes(secret), false);
  await progress.finish("completed");
  assert.equal(sent.length, 3);
  assert.match(sent.at(-1), /已完成.*共 1 轮/);
});

test("长时间等待会主动报告仍在执行，完成后清理定时器", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { progress, sent, logs } = create();
  progress.emit({ type: "started" });
  progress.emit({ type: "thinking", round: 2 });
  await progress.flush();
  t.mock.timers.tick(30000);
  await progress.flush();
  assert.match(logs.at(-1), /仍在执行.*第 2 轮等待 AI.*30\.0秒/);
  assert.match(sent.at(-1), /仍在执行/);
  await progress.finish("cancelled");
  const count = logs.length;
  t.mock.timers.tick(60000);
  await progress.flush();
  assert.equal(logs.length, count);
  assert.match(sent.at(-1), /已取消/);
});

test("静默任务仍记录终端日志；进度投递失败不阻止任务或泄露异常", async () => {
  const quiet = create({ notify: false });
  quiet.progress.emit({ type: "started" });
  await quiet.progress.finish("failed");
  assert.equal(quiet.sent.length, 0);
  assert.match(quiet.logs.at(-1), /执行失败/);
  const failed = create({ send: async () => { throw new Error("password=do-not-log"); } });
  failed.progress.emit({ type: "started" });
  await failed.progress.finish("completed");
  assert.ok(failed.logs.some((line) => line.includes("进度消息发送失败")));
  assert.equal(JSON.stringify(failed.logs).includes("do-not-log"), false);
});
