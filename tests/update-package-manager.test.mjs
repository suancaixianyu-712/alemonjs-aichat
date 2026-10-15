import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

const { resolveUpdatePackageManager } = await import(
  new URL("../lib/api/update-package-manager.js", import.meta.url).href
);

const withLocks = (locks) => {
  const set = new Set(locks.map((name) => join("/project", name)));
  return (path) => set.has(path);
};

test("仅有 yarn.lock → 使用 yarn add", () => {
  const plan = resolveUpdatePackageManager("/project", withLocks(["yarn.lock"]));
  assert.equal(plan.manager, "yarn");
  assert.equal(plan.command, "yarn add alemonjs-aichat");
  assert.equal(plan.hint, "yarn add alemonjs-aichat");
});

test("只有 package-lock.json（无 yarn.lock）→ 使用 npm install", () => {
  const plan = resolveUpdatePackageManager(
    "/project",
    withLocks(["package-lock.json"]),
  );
  assert.equal(plan.manager, "npm");
  assert.equal(plan.command, "npm install alemonjs-aichat");
  assert.equal(plan.hint, "npm install alemonjs-aichat");
});

test("两种锁文件都没有 → 默认 npm", () => {
  const plan = resolveUpdatePackageManager("/project", withLocks([]));
  assert.equal(plan.manager, "npm");
  assert.equal(plan.command, "npm install alemonjs-aichat");
  assert.equal(plan.hint, "npm install alemonjs-aichat");
});

test("同时有 yarn.lock 和 package-lock.json → 使用 npm", () => {
  const plan = resolveUpdatePackageManager(
    "/project",
    withLocks(["yarn.lock", "package-lock.json"]),
  );
  assert.equal(plan.manager, "npm");
  assert.equal(plan.command, "npm install alemonjs-aichat");
  assert.equal(plan.hint, "npm install alemonjs-aichat");
});
