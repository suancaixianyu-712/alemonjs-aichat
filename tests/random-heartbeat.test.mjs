import assert from "node:assert/strict";
import test from "node:test";

import {
  clampRandomRangeForAI,
  computeNextHeartbeatRunAt,
  computeRandomNextDeltaMs,
  computeRandomNextRunAt,
  formatDurationMs,
  formatHeartbeatStatus,
  parseDurationMs,
  parsePermissionMode,
  parseRandomRange,
  shouldRunHeartbeat,
  stripRandomHeartbeatFields,
} from "../lib/api/random-heartbeat.js";

test("解析时长 15m / 2h / 30分钟", () => {
  assert.equal(parseDurationMs("15m")?.ms, 15 * 60 * 1000);
  assert.equal(parseDurationMs("2h")?.ms, 2 * 60 * 60 * 1000);
  assert.equal(parseDurationMs("30分钟")?.ms, 30 * 60 * 1000);
  assert.equal(parseDurationMs("30s"), null); // < 1m
  assert.equal(parseDurationMs(""), null);
});

test("解析随机区间 15m-2h / 15m~2h", () => {
  const a = parseRandomRange("15m-2h");
  assert.ok(a);
  assert.equal(a.minMs, 15 * 60 * 1000);
  assert.equal(a.maxMs, 2 * 60 * 60 * 1000);

  const b = parseRandomRange("15m~2h");
  assert.ok(b);
  assert.equal(b.minMs, a.minMs);
  assert.equal(b.maxMs, a.maxMs);

  assert.equal(parseRandomRange("2h-15m"), null);
  assert.equal(parseRandomRange("15m"), null);
});

test("random next 夹 ceiling；ceiling < min 时用 ceiling", () => {
  const min = 10 * 60 * 1000;
  const max = 60 * 60 * 1000;
  // random always returns 1 → pick max end of range
  const high = computeRandomNextDeltaMs(min, max, 20 * 60 * 1000, () => 0.999);
  assert.equal(high, 20 * 60 * 1000);

  const low = computeRandomNextDeltaMs(min, max, 20 * 60 * 1000, () => 0);
  assert.equal(low, min);

  const clamped = computeRandomNextDeltaMs(min, max, 5 * 60 * 1000, () => 0.5);
  assert.equal(clamped, 5 * 60 * 1000);
});

test("enabled=false 的 random 不调度", () => {
  const now = 1_000_000;
  assert.equal(
    shouldRunHeartbeat(
      { mode: "random", enabled: false, nextRunAt: now - 1 },
      now,
    ),
    false,
  );
  assert.equal(
    shouldRunHeartbeat(
      { mode: "random", enabled: true, nextRunAt: now - 1 },
      now,
    ),
    true,
  );
  assert.equal(
    shouldRunHeartbeat(
      { mode: "interval", nextRunAt: now - 1 },
      now,
    ),
    true,
  );
  assert.equal(
    shouldRunHeartbeat(
      { mode: "random", enabled: true, nextRunAt: now + 1 },
      now,
    ),
    false,
  );
});

test("computeNextHeartbeatRunAt：daily / interval / random", () => {
  const now = 1_000_000;
  assert.equal(
    computeNextHeartbeatRunAt(
      {
        guid: "g",
        userID: "u",
        platform: "p",
        spaceId: "s",
        isPrivate: false,
        mode: "daily",
        value: "8:0",
        nextRunAt: now - 100,
        createdAt: now,
      },
      now,
    ),
    now - 100 + 24 * 60 * 60 * 1000,
  );

  assert.equal(
    computeNextHeartbeatRunAt(
      {
        guid: "g",
        userID: "u",
        platform: "p",
        spaceId: "s",
        isPrivate: false,
        mode: "interval",
        value: String(30 * 60 * 1000),
        nextRunAt: now - 100,
        createdAt: now,
      },
      now,
    ),
    now - 100 + 30 * 60 * 1000,
  );

  const randomNext = computeNextHeartbeatRunAt(
    {
      guid: "g",
      userID: "u",
      platform: "p",
      spaceId: "s",
      isPrivate: false,
      mode: "random",
      value: "x",
      minMs: 10 * 60 * 1000,
      maxMs: 20 * 60 * 1000,
      ceilingMs: 15 * 60 * 1000,
      nextRunAt: now - 100,
      createdAt: now,
      enabled: true,
    },
    now,
    () => 0.999,
  );
  assert.equal(randomNext, now + 15 * 60 * 1000);
});

test("ConfigureRandomHeartbeat 夹限：不可超出主人上下限与 ceiling", () => {
  const ok = clampRandomRangeForAI({
    requestedMinMs: 20 * 60 * 1000,
    requestedMaxMs: 40 * 60 * 1000,
    ownerMinMs: 15 * 60 * 1000,
    ownerMaxMs: 2 * 60 * 60 * 1000,
    ceilingMs: 60 * 60 * 1000,
  });
  assert.deepEqual(ok, {
    ok: true,
    minMs: 20 * 60 * 1000,
    maxMs: 40 * 60 * 1000,
  });

  const tooLow = clampRandomRangeForAI({
    requestedMinMs: 5 * 60 * 1000,
    requestedMaxMs: 40 * 60 * 1000,
    ownerMinMs: 15 * 60 * 1000,
    ownerMaxMs: 2 * 60 * 60 * 1000,
  });
  assert.equal(tooLow.ok, false);

  const overCeiling = clampRandomRangeForAI({
    requestedMinMs: 20 * 60 * 1000,
    requestedMaxMs: 90 * 60 * 1000,
    ownerMinMs: 15 * 60 * 1000,
    ownerMaxMs: 2 * 60 * 60 * 1000,
    ceilingMs: 60 * 60 * 1000,
  });
  assert.equal(overCeiling.ok, false);
});

test("权限档解析与状态文案", () => {
  assert.equal(parsePermissionMode("自动审核"), "auto");
  assert.equal(parsePermissionMode("full"), "full");
  assert.equal(parsePermissionMode("完全访问"), "full");
  assert.equal(parsePermissionMode("nope"), null);

  const status = formatHeartbeatStatus({
    guid: "g",
    userID: "u",
    platform: "p",
    spaceId: "s",
    isPrivate: false,
    mode: "random",
    value: "x",
    minMs: 15 * 60 * 1000,
    maxMs: 2 * 60 * 60 * 1000,
    ceilingMs: 6 * 60 * 60 * 1000,
    enabled: true,
    permissionMode: "auto",
    nextRunAt: Date.parse("2026-10-26T12:00:00+08:00"),
    createdAt: 0,
  });
  assert.match(status, /随机/);
  assert.match(status, /15m-2h/);
  assert.match(status, /开启/);
});

test("固定心跳写入时剥离 random 字段", () => {
  const stripped = stripRandomHeartbeatFields({
    guid: "g",
    mode: "interval",
    value: "60000",
    minMs: 1,
    maxMs: 2,
    ceilingMs: 3,
    enabled: true,
    permissionMode: "full",
    ownerMinMs: 1,
    ownerMaxMs: 2,
  });
  assert.equal("minMs" in stripped, false);
  assert.equal("enabled" in stripped, false);
  assert.equal(stripped.mode, "interval");
});

test("formatDurationMs 与 computeRandomNextRunAt", () => {
  assert.equal(formatDurationMs(15 * 60 * 1000), "15m");
  assert.equal(formatDurationMs(2 * 60 * 60 * 1000), "2h");
  const now = 1000;
  assert.equal(
    computeRandomNextRunAt(now, 10 * 60 * 1000, 10 * 60 * 1000, undefined, () => 0),
    now + 10 * 60 * 1000,
  );
});
