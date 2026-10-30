import assert from "node:assert/strict";
import { mock, test } from "node:test";

/** 最小 Redis 替身：只实现聊天记录用到的 get/set/lrange/pipeline 命令 */
const createRedisMock = () => {
  const values = new Map();
  const lists = new Map();
  const slice = (list, start, end) => {
    const from = start < 0 ? Math.max(0, list.length + start) : start;
    const to = end < 0 ? list.length + end : end;
    return list.slice(from, to + 1);
  };
  const chain = () => {
    const ops = [];
    const api = {
      rpush(key, value) {
        ops.push(() => {
          if (!lists.has(key)) lists.set(key, []);
          lists.get(key).push(String(value));
        });
        return api;
      },
      ltrim(key, start, end) {
        ops.push(() => {
          lists.set(key, slice(lists.get(key) || [], start, end));
        });
        return api;
      },
      expire() {
        return api;
      },
      async exec() {
        for (const op of ops.splice(0)) op();
        return [];
      },
    };
    return api;
  };
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, String(value));
      return "OK";
    },
    async lrange(key, start, end) {
      return slice(lists.get(key) || [], start, end);
    },
    pipeline: chain,
  };
};

const redis = createRedisMock();
mock.module(new URL("../lib/redis.js", import.meta.url).href, {
  namedExports: { redis },
});
const { default: db } = await import("../lib/config.js");

const add = (guid, index, extra = {}) =>
  db.appendChatContext(guid, "onebot", {
    userID: `u${index}`,
    name: `用户${index}`,
    text: `消息${index}`,
    mid: `m${index}`,
    ...extra,
  });

test("redis 未设置时默认携带 3 条，并不会被当成 0（关闭）", async () => {
  assert.equal(await db.getChatContextCount("g-default"), 3);
  await add("g-default", 1);
  assert.deepEqual(
    (await db.getChatContext("g-default", "onebot")).map((item) => item.text),
    ["消息1"],
  );
});

test("设置为 0 后不再记录，最大只接受 20", async () => {
  assert.equal(await db.setChatContextCount("g-off", 0), 0);
  await add("g-off", 1);
  assert.deepEqual(await db.getChatContext("g-off", "onebot"), []);

  assert.equal(await db.setChatContextCount("g-max", 99), 20);
  assert.equal(await db.getChatContextCount("g-max"), 20);
});

test("只取最近 N 条，并能按消息 ID 排除当前这条", async () => {
  await db.setChatContextCount("g-keep", 3);
  for (let i = 1; i <= 5; i += 1) await add("g-keep", i);

  assert.deepEqual(
    (await db.getChatContext("g-keep", "onebot")).map((item) => item.text),
    ["消息3", "消息4", "消息5"],
  );
  assert.deepEqual(
    (await db.getChatContext("g-keep", "onebot", undefined, "m5")).map(
      (item) => item.text,
    ),
    ["消息2", "消息3", "消息4"],
  );
});

test("私聊内容不写入群聊上下文", async () => {
  await add("g-private", 1, { isPrivate: true });
  assert.deepEqual(await db.getChatContext("g-private", "onebot"), []);
});

test("不同群、不同平台互不串记录", async () => {
  await add("g-a", 1);
  await add("g-b", 2);
  assert.deepEqual(
    (await db.getChatContext("g-a", "onebot")).map((item) => item.text),
    ["消息1"],
  );
  assert.deepEqual(
    (await db.getChatContext("g-b", "onebot")).map((item) => item.text),
    ["消息2"],
  );
  assert.deepEqual(await db.getChatContext("g-a", "kook"), []);
});
