import assert from "node:assert/strict";
import test from "node:test";
import { CodexSessionStore } from "../lib/api/codex-sessions.js";
import { createCodexTestRedis } from "./helpers/codex-redis.mjs";

const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const otherId = "0199a213-81c0-7800-8aa1-bbab2a035a54";
const save = (store, sessionId = id, prompt = "修复测试") => store.save({
  id: sessionId, prompt, model: null, status: "completed",
});

test("会话持久化后可由新的 Store 实例恢复、列出和切换", async () => {
  const redis = createCodexTestRedis();
  const store = new CodexSessionStore(redis, "group", "owner", "/repo");
  await save(store);
  await save(store, otherId, "另一个任务");
  const restored = new CodexSessionStore(redis, "group", "owner", "/repo");
  assert.equal((await restored.current()).id, otherId);
  assert.equal((await restored.list()).length, 2);
  await restored.select(id);
  assert.equal((await store.current()).id, id);
  const before = await restored.get(id);
  await restored.save({ id, prompt: "继续", model: "custom", status: "stopped" });
  const after = await restored.get(id);
  assert.equal(after.title, "修复测试");
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.model, "custom");
  assert.equal(after.status, "stopped");
});

test("会话按聊天、用户和目录隔离，不能恢复他人的 UUID", async () => {
  const redis = createCodexTestRedis();
  await save(new CodexSessionStore(redis, "group", "owner", "/repo"));
  for (const scope of [["other-group", "owner", "/repo"], ["group", "member", "/repo"], ["group", "owner", "/other"]]) {
    const store = new CodexSessionStore(redis, ...scope);
    assert.equal(await store.current(), null);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.select(id), /未找到/);
  }
});

test("并发调用被拒绝；过期锁的释放不能删除新持有者的锁", async () => {
  const redis = createCodexTestRedis();
  const store = new CodexSessionStore(redis, "group", "owner", "/repo");
  const release = await store.acquire(10);
  await assert.rejects(store.acquire(10), /正在执行/);
  const [key] = redis.values.keys();
  redis.values.set(key, "new-holder");
  await release();
  assert.equal(redis.values.get(key), "new-holder");
  redis.values.delete(key);
  const nextRelease = await store.acquire(10);
  await nextRelease();
  assert.equal(redis.values.size, 0);
});
