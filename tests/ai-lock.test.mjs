import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAIListWithLocks,
  getLockedAIMessage,
  resolveAISelection,
} from "../lib/api/ai-lock.js";

const aiList = [
  "deepseek/deepseek-chat",
  "openai/gpt-5",
  "other/local model",
  "other/qwen",
];

test("批量序号、逗号和范围解析为去重后的AI名称", () => {
  assert.deepEqual(resolveAISelection("1 2，2,4", aiList), {
    ok: true,
    names: [
      "deepseek/deepseek-chat",
      "openai/gpt-5",
      "other/qwen",
    ],
  });
  assert.deepEqual(resolveAISelection("2-4", aiList), {
    ok: true,
    names: ["openai/gpt-5", "other/local model", "other/qwen"],
  });
});

test("完整名称支持空格，无效项使批量操作整体失败", () => {
  assert.deepEqual(resolveAISelection("other/local model", aiList), {
    ok: true,
    names: ["other/local model"],
  });
  assert.deepEqual(resolveAISelection("1 9", aiList), {
    ok: false,
    invalid: ["9"],
  });
  assert.deepEqual(resolveAISelection("4-2", aiList), {
    ok: false,
    invalid: ["4-2"],
  });
});

test("AI列表标记锁定项并生成普通用户拒绝提示", () => {
  assert.deepEqual(formatAIListWithLocks(aiList, ["openai/gpt-5"]), [
    "1. deepseek/deepseek-chat",
    "2. 🔒 openai/gpt-5",
    "3. other/local model",
    "4. other/qwen",
  ]);
  assert.match(getLockedAIMessage("openai/gpt-5"), /普通用户无法使用/);
});

test("AI列表显示别名但仍按内部名称判断锁定状态", () => {
  assert.deepEqual(
    formatAIListWithLocks(
      ["other/relay-a", "other/relay-b"],
      ["other/relay-b"],
      ["other/中转站A（gpt-5）", "other/中转站B（gpt-5）"],
    ),
    ["1. other/中转站A（gpt-5）", "2. 🔒 other/中转站B（gpt-5）"],
  );
});

test("删除AI按#ai列表序号/范围解析为配置名（delete-by-index）", () => {
  assert.deepEqual(resolveAISelection("1", aiList), {
    ok: true,
    names: ["deepseek/deepseek-chat"],
  });
  assert.deepEqual(resolveAISelection("1 3", aiList), {
    ok: true,
    names: ["deepseek/deepseek-chat", "other/local model"],
  });
  assert.deepEqual(resolveAISelection("1-3", aiList), {
    ok: true,
    names: [
      "deepseek/deepseek-chat",
      "openai/gpt-5",
      "other/local model",
    ],
  });
  // 名称删除能力保留
  assert.deepEqual(resolveAISelection("openai/gpt-5", aiList), {
    ok: true,
    names: ["openai/gpt-5"],
  });
  // 任一无效序号整体失败，避免只删一部分
  assert.deepEqual(resolveAISelection("2 99", aiList), {
    ok: false,
    invalid: ["99"],
  });
});
