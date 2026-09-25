import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRestartRecoveryTask,
  canConsumeRestartRecoveryTask,
  parseRestartRecoveryTask,
  RESTART_RECOVERY_TTL_SECONDS,
  formatRestartDuration,
} from "../lib/api/restart-recovery.js";

const input = {
  targetProcessId: "6",
  guid: "private-1",
  userID: "owner-1",
  platform: "onebot",
  spaceId: "private-1",
  isPrivate: true,
  isMaster: true,
  prompt: "重启完成后继续任务",
  resumeAI: true,
};

test("AI 触发重启时生成可持久化的单次恢复任务", () => {
  const task = buildRestartRecoveryTask(input, {
    id: "task-1",
    ownerId: "process-1",
    now: 1000,
  });
  assert.deepEqual(task, {
    ...input,
    id: "task-1",
    ownerId: "process-1",
    createdAt: 1000,
    restartRecovery: true,
  });
  assert.deepEqual(parseRestartRecoveryTask(JSON.stringify(task), 1001), task);
  assert.equal(canConsumeRestartRecoveryTask(task, "process-1", "6"), false);
  assert.equal(canConsumeRestartRecoveryTask(task, "process-2", "5"), false);
  assert.equal(canConsumeRestartRecoveryTask(task, "process-2", "6"), true);
});

test("重启耗时按秒保留两位小数", () => {
  assert.equal(formatRestartDuration(2534), "2.53 秒");
});

test("过期或损坏的重启恢复任务不会执行", () => {
  const task = buildRestartRecoveryTask(input, {
    id: "task-1",
    ownerId: "process-1",
    now: 1000,
  });
  assert.equal(
    parseRestartRecoveryTask(
      JSON.stringify(task),
      1000 + RESTART_RECOVERY_TTL_SECONDS * 1000 + 1,
    ),
    null,
  );
  assert.equal(parseRestartRecoveryTask("not-json", 1001), null);
});
