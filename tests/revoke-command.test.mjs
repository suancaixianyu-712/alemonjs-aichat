import assert from "node:assert/strict";
import { mock, test } from "node:test";

const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;
mock.module(moduleUrl("config"), { defaultExport: { redis: { get: async () => null } } });
mock.module(moduleUrl("redis"), { namedExports: { redis: {} } });
mock.module("@alemonjs/onebot", { namedExports: { API: class {} } });
globalThis.onSelects ??= (s) => s;
globalThis.onResponse ??= (_s, fn) => fn;
const { commandChildren } = await import(moduleUrl("routes/commands"));

const revoke = commandChildren.find((item) => item?.regular instanceof RegExp && item.regular.source.includes("撤回(消息)"));

test("#撤回 / #撤回消息 / /撤回 触发撤回指令，#撤回别的 不触发", () => {
  assert.ok(revoke, "未找到撤回指令路由");
  for (const text of ["#撤回", "#撤回消息", "/撤回", "/撤回消息"]) assert.equal(revoke.regular.test(text), true, text);
  for (const text of ["#撤回别的", "撤回", "#撤回消息了", "#工具提示撤回"]) assert.equal(revoke.regular.test(text), false, text);
});
