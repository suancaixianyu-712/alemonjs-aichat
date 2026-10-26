import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const skill = readFileSync("skills/napcat/SKILL.md", "utf8");

test("built-in napcat skill keeps placeholders and injection note", () => {
  assert.match(skill, /\{\{NAPCAT_BASE_URL\}\}/);
  assert.match(skill, /\{\{NAPCAT_TOKEN\}\}/);
  assert.match(skill, /运行时注入/);
  assert.doesNotMatch(skill, /1\.95\.85\.178/);
  assert.match(skill, /^name:\s*napcat/m);
});

test("placeholder replace leaves loopback default shape", () => {
  const base = "http://127.0.0.1:3005";
  const token = "test-token";
  const injected = skill
    .replaceAll("{{NAPCAT_BASE_URL}}", base)
    .replaceAll("{{NAPCAT_TOKEN}}", token);
  assert.match(injected, /http:\/\/127\.0\.0\.1:3005/);
  assert.match(injected, /Bearer test-token/);
  assert.doesNotMatch(injected, /\{\{NAPCAT_/);
});
