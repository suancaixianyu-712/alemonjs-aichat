import assert from "node:assert/strict";
import { mock, test } from "node:test";

const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;
mock.module(moduleUrl("config"), {
  defaultExport: { redis: { get: async () => null }, getAgentSwitch: async () => "0" },
});
mock.module(moduleUrl("redis"), { namedExports: { redis: {} } });
mock.module(moduleUrl("s3"), {
  namedExports: { uploadImageToR2: async () => "", uploadMediaToR2: async () => "" },
});
mock.module(moduleUrl("response/zreply/getChatConfig"), {
  namedExports: { isNonVisionModel: () => false },
});
mock.module(moduleUrl("api/xianyu-game"), {
  namedExports: { useXianyuGameTool: async () => ({}) },
});
mock.module(moduleUrl("api/speech-tool"), {
  namedExports: { generateSpeech: async () => ({}) },
});
mock.module("@alemonjs/onebot", { namedExports: { API: class {} } });

const {
  ALLOWED_PROJECT_COMMAND_BASES,
  buildProjectCommandReview,
  tools,
} = await import(moduleUrl("api/aitools"));

test("yarn / yarn.cmd 不在项目命令允许列表中", () => {
  assert.equal(ALLOWED_PROJECT_COMMAND_BASES.has("yarn"), false);
  assert.equal(ALLOWED_PROJECT_COMMAND_BASES.has("yarn.cmd"), false);
  assert.equal(ALLOWED_PROJECT_COMMAND_BASES.has("npm"), true);
  assert.equal(ALLOWED_PROJECT_COMMAND_BASES.has("npx"), true);
});

test("拦截 yarn 命令时提示请改用 npm/npx", () => {
  for (const command of ["yarn add lodash", "yarn.cmd install", "YARN run build"]) {
    const review = buildProjectCommandReview(command);
    assert.equal(review.allowed, false, command);
    assert.equal(review.risk, "blocked", command);
    const reason = review.reasons.join(" ");
    assert.match(reason, /本环境请用 npm\/npx/, command);
    assert.match(reason, /请改用 npm\/npx/, command);
  }
  const npm = buildProjectCommandReview("npm install lodash");
  assert.equal(npm.allowed, true);
});

test("AgentProjectCommand 描述引导使用 npm/npx、不要调用 yarn", () => {
  const tool = tools.find((item) => item?.function?.name === "AgentProjectCommand");
  assert.ok(tool);
  assert.match(tool.function.description, /本环境请用 npm\/npx/);
  assert.match(tool.function.description, /不要调用 yarn/);
  assert.match(tool.function.parameters.properties.command.description, /不要用 yarn/);
});
