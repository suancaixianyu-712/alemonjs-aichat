import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexExecArgs,
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
