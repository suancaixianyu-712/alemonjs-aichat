import assert from "node:assert/strict";
import test from "node:test";

import { parseOwnedAIToolLoopState } from "../lib/api/tool-loop-state.js";

const now = 1_000_000;
const state = (ownerId) =>
  JSON.stringify({
    processing: true,
    ownerId,
    userID: "user-1",
    startedAt: now - 1000,
    updatedAt: now - 500,
  });

test("同一进程可以恢复仍在执行的工具调用锁", () => {
  assert.equal(
    parseOwnedAIToolLoopState(state("current"), "current", 60_000, now)
      ?.userID,
    "user-1",
  );
});

test("重启后拒绝恢复旧进程和旧版工具调用锁", () => {
  assert.equal(
    parseOwnedAIToolLoopState(state("previous"), "current", 60_000, now),
    null,
  );
  assert.equal(parseOwnedAIToolLoopState("1", "current", 60_000, now), null);
});

test("超时和损坏的工具调用锁不会继续阻塞", () => {
  assert.equal(
    parseOwnedAIToolLoopState(state("current"), "current", 100, now),
    null,
  );
  assert.equal(
    parseOwnedAIToolLoopState("not-json", "current", 60_000, now),
    null,
  );
});
