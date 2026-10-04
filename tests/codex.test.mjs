import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { createCodexTestRedis } from "./helpers/codex-redis.mjs";

const config = {};
const redis = createCodexTestRedis();
const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;
mock.module(moduleUrl("config/app"), { namedExports: { getAiChatConfigValue: () => config } });
mock.module(moduleUrl("redis"), { namedExports: { redis } });

import {
  buildCodexExecArgs,
  abortCodexRuns,
  parseCodexJsonl,
  runCodex,
} from "../lib/api/codex.js";

test("RunCodex 新会话使用 JSONL、工作目录和安全写入参数", () => {
  assert.deepEqual(
    buildCodexExecArgs({
      prompt: "修复测试",
      projectPath: "D:\\repo",
      model: "gpt-test",
      autoApprove: true,
    }),
    [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-C",
      "D:\\repo",
      "--approve-for-me",
      "--model",
      "gpt-test",
      "--",
      "修复测试",
    ],
  );
});

const createFakeCli = async (t, source) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-session-test-"));
  const binary = path.join(directory, "fake-codex.js");
  const previousBinary = process.env.CODEX_TOOL_BINARY;
  const previousConfig = config.codexTool;
  await writeFile(binary, source, "utf8");
  process.env.CODEX_TOOL_BINARY = binary;
  config.codexTool = { projectPath: directory };
  t.after(async () => {
    if (previousBinary === undefined) delete process.env.CODEX_TOOL_BINARY;
    else process.env.CODEX_TOOL_BINARY = previousBinary;
    if (previousConfig === undefined) delete config.codexTool;
    else config.codexTool = previousConfig;
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
};

const fakeCli = `
const { randomUUID } = require("node:crypto");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const resume = args.indexOf("resume");
  const id = resume >= 0 ? args[resume + 1] : randomUUID();
  console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
  console.log(JSON.stringify({ type: "item.completed", item: {
    type: "agent_message", text: JSON.stringify({ prompt, args, cwd: process.cwd() })
  }}));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }));
});`;

test("工具自动续接、另起任务、切换旧任务，并通过 stdin 原样发送多行提示词", async (t) => {
  const directory = await createFakeCli(t, fakeCli);
  const scope = { guid: "multi-turn-group", userID: "owner" };
  const prompt = '修改中文文件\n保留 "引号"、`反引号`、$(表达式) 和 --last';
  const first = await runCodex({ ...scope, prompt, model: "custom" });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.resumed, false);
  const received = JSON.parse(first.output);
  assert.equal(received.prompt, prompt);
  assert.deepEqual(received.args.slice(-2), ["--", "-"]);
  assert.equal(received.cwd, directory);
  const second = await runCodex({ ...scope, prompt: "继续" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.resumed, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.model, "custom");
  assert.ok(JSON.parse(second.output).args.includes("resume"));
  const third = await runCodex({ ...scope, prompt: "新任务", newSession: true });
  assert.equal(third.resumed, false);
  assert.notEqual(third.sessionId, first.sessionId);
  const sessions = await runCodex({ ...scope, action: "listSessions" });
  assert.equal(sessions.sessions.length, 2);
  assert.equal(sessions.currentSessionId, third.sessionId);
  const switched = await runCodex({ ...scope, action: "switchSession", sessionId: first.sessionId });
  assert.equal(switched.ok, true, switched.error);
  const fourth = await runCodex({ ...scope, prompt: "恢复第一个任务" });
  assert.equal(fourth.sessionId, first.sessionId);
  const other = await runCodex({ ...scope, userID: "member", prompt: "接管", sessionId: first.sessionId });
  assert.equal(other.ok, false);
  assert.match(other.error, /未找到/);
  assert.equal((await runCodex({ ...scope, userID: "member", action: "listSessions" })).sessions.length, 0);
});

test("目录范围拒绝相邻目录、相对路径和通向外部的符号链接", async (t) => {
  const directory = await createFakeCli(t, fakeCli);
  const root = path.join(directory, "workspace");
  const outside = path.join(directory, "workspace-other");
  await mkdir(root);
  await mkdir(outside);
  config.codexTool.projectPath = root;
  for (const projectPath of [outside, "."]) {
    const result = await runCodex({ prompt: "修改", projectPath });
    assert.equal(result.ok, false);
    assert.match(result.error, /超出允许范围|绝对路径/);
  }
  const link = path.join(root, "external");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  const escaped = await runCodex({ prompt: "修改", projectPath: link });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error, /超出允许范围/);
  const valid = await runCodex({ prompt: "分析", projectPath: root, autoApprove: false });
  assert.equal(valid.ok, true, valid.error);
  assert.equal(valid.sandbox, "read-only");
});

const hangingCli = `
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }));
  setInterval(() => {}, 1000);
});`;

test("超时任务保留会话以便恢复，并释放执行锁", async (t) => {
  const directory = await createFakeCli(t, hangingCli);
  const scope = { guid: "timeout-group", userID: "owner" };
  const result = await runCodex({ ...scope, prompt: "长任务", timeoutSeconds: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  const sessions = await runCodex({ ...scope, action: "listSessions" });
  assert.equal(sessions.currentSessionId, result.sessionId);
  assert.equal(sessions.sessions[0].status, "failed");
  assert.equal((await runCodex({ ...scope, action: "switchSession", sessionId: result.sessionId })).ok, true);
  await writeFile(path.join(directory, "fake-codex.js"), fakeCli, "utf8");
  const resumed = await runCodex({ ...scope, prompt: "恢复任务" });
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(resumed.sessionId, result.sessionId);
  assert.equal(resumed.resumed, true);
});

test("中止只影响当前用户；执行中的新会话 ID 可查询，并发续接被拒绝", async (t) => {
  await createFakeCli(t, hangingCli);
  const scope = { guid: "stop-group", userID: "owner" };
  const running = runCodex({ ...scope, prompt: "长任务", timeoutSeconds: 10 });
  t.after(async () => { await abortCodexRuns(scope); await running; });
  let sessionId = null;
  for (let attempt = 0; attempt < 100 && !sessionId; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    sessionId = (await runCodex({ ...scope, action: "listSessions" })).currentSessionId;
  }
  assert.ok(sessionId);
  const duplicate = await runCodex({ ...scope, prompt: "继续" });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /正在执行/);
  assert.equal((await abortCodexRuns({ ...scope, userID: "other-user" })).aborted, 0);
  assert.equal((await abortCodexRuns({ ...scope, sessionId })).aborted, 1);
  const result = await running;
  assert.match(result.error, /已中止/);
  const sessions = await runCodex({ ...scope, action: "listSessions" });
  assert.equal(sessions.sessions[0].status, "stopped");
  assert.equal((await runCodex({ ...scope, action: "switchSession", sessionId })).ok, true);
});

test("CLI 不存在时返回安装提示，失败后允许再次执行", async (t) => {
  const directory = await createFakeCli(t, fakeCli);
  process.env.CODEX_TOOL_BINARY = path.join(directory, "missing-codex");
  const scope = { guid: "missing-cli-group", userID: "owner", prompt: "测试" };
  const missing = await runCodex(scope);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /未找到 Codex CLI/);
  process.env.CODEX_TOOL_BINARY = path.join(directory, "fake-codex.js");
  assert.equal((await runCodex(scope)).ok, true);
});

test("未配置目录时使用当前聊天工作区，其他聊天和目录不能混用", async (t) => {
  const directory = await createFakeCli(t, fakeCli);
  config.codexTool = {};
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const scope = { guid: "default-workspace", userID: "owner", prompt: "检查项目" };
    const result = await runCodex(scope);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.directory, path.join(directory, "public", scope.guid));
    const escaped = await runCodex({ ...scope, projectPath: directory });
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /超出允许范围/);
    const hijacked = await runCodex({ ...scope, guid: "other-group", sessionId: result.sessionId });
    assert.equal(hijacked.ok, false);
    assert.match(hijacked.error, /未找到/);
    assert.equal((await runCodex({ ...scope, guid: "../outside" })).ok, false);
  } finally {
    process.chdir(previousCwd);
  }
});

test("无任务完成事件的正常退出不能伪装执行成功", async (t) => {
  await createFakeCli(t, "process.stdin.resume();");
  const result = await runCodex({ guid: "empty-output-group", userID: "owner", prompt: "测试" });
  assert.equal(result.ok, false);
  assert.match(result.error, /未返回任务完成事件/);
});

test("RunCodex 可用 UUID 续接只读会话", () => {
  const sessionId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  assert.deepEqual(
    buildCodexExecArgs({
      prompt: "继续检查",
      sessionId,
      projectPath: "/repo",
      autoApprove: false,
    }),
    [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-C",
      "/repo",
      "--sandbox",
      "read-only",
      "resume",
      sessionId,
      "--",
      "继续检查",
    ],
  );
});

test("RunCodex 解析会话、活动、最终输出和用量", () => {
  const result = parseCodexJsonl(
    [
      '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","status":"completed","exit_code":0}}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"不应回传"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"测试已通过"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
    ].join("\n"),
  );

  assert.equal(result.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.equal(result.output, "测试已通过");
  assert.deepEqual(result.activity, [
    "执行命令（completed），退出码 0：npm test",
  ]);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 20 });
  assert.equal(result.error, null);
});

test("RunCodex 解析失败事件但忽略非 JSON 噪声", () => {
  const result = parseCodexJsonl(
    ["启动提示", '{"type":"turn.failed","error":{"message":"认证失败"}}'].join(
      "\n",
    ),
  );
  assert.equal(result.error, "认证失败");
  assert.equal(result.invalidLines, 1);
});

test("RunCodex 在启动进程前拒绝伪造的续接参数", async () => {
  const result = await runCodex({
    prompt: "继续任务",
    projectPath: process.cwd(),
    sessionId: "--last",
  });
  assert.deepEqual(result, {
    ok: false,
    error: "sessionId 不是有效的 Codex 会话 UUID",
  });
});

test("RunCodex 可启动 CLI 进程并回收 JSONL 结果", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "run-codex-test-"));
  const binary = path.join(directory, "fake-codex.js");
  const previousBinary = process.env.CODEX_TOOL_BINARY;
  await writeFile(
    binary,
    [
      'console.log(JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }));',
      'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "模拟执行完成" } }));',
      'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }));',
    ].join("\n"),
    "utf8",
  );
  process.env.CODEX_TOOL_BINARY = binary;
  t.after(async () => {
    if (previousBinary === undefined) delete process.env.CODEX_TOOL_BINARY;
    else process.env.CODEX_TOOL_BINARY = previousBinary;
    await rm(directory, { recursive: true, force: true });
  });

  const result = await runCodex({
    prompt: "模拟任务",
    projectPath: process.cwd(),
    autoApprove: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.equal(result.output, "模拟执行完成");
  assert.equal(result.sandbox, "read-only");
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2 });
});
