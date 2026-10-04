import assert from "node:assert/strict";
import { mock, test } from "node:test";

const values = new Map();
const rules = [];
const replies = [];
let approved = true;
let reviews = 0;
const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;
mock.module(moduleUrl("config"), { defaultExport: {
  redis: { get: async (key) => values.get(key), set: async (key, value) => values.set(key, value) },
  getAgentSwitch: async () => "0",
  getAIConfig: async () => ({ host: "https://example.invalid", key: "test", model: "test" }),
  isToolProxyEnabled: async () => false,
} });
mock.module(moduleUrl("config/app"), { namedExports: { getAiChatConfigValue: () => ({}) } });
mock.module(moduleUrl("api/tool-message-content"), { namedExports: {
  buildToolMessageContent: async () => ({ text: "测试", files: [] }),
  hasToolMessageAttachments: () => false,
} });
mock.module(moduleUrl("api/openaiProxy"), { namedExports: { getOpenAIProxyFetch: () => undefined } });
mock.module(moduleUrl("response/zreply/rapi"), { namedExports: { requestRapiCompletion: async () => ({}) } });
mock.module("openai", { defaultExport: class {
  chat = { completions: { create: async (params) => {
    reviews++;
    assert.match(params.messages[1].content, /仅主人可用/);
    return { choices: [{ message: { content: JSON.stringify({ allowed: approved }) } }] };
  } } };
} });
mock.module("node:fs", { defaultExport: {
  existsSync: () => true,
  realpathSync: { native: (path) => path },
} });
mock.module(moduleUrl("api/opencode"), { namedExports: {
  createOpencodeSession: async () => ({}),
  ensureInheritedOpencodeServer: async () => ({ url: "http://example.invalid", model: "test" }),
  listOpencodeModels: async () => [],
  listOpencodeSessions: async () => [],
  updateOpencodeSessionPermission: async (_url, _dir, _id, value) => rules.push(value),
  sendOpencodeSessionMessage: async ({ replyPermission }) => {
    const row = [];
    for (const command of ["rm -rf repo", "pm2 restart app", "git push origin main"]) {
      row.push(await replyPermission({ permission: "bash", patterns: [command], metadata: { command }, raw: { command } }));
    }
    replies.push(row);
    return { output: "完成" };
  },
} });
const { ToolSessionController } = await import(moduleUrl("api/tool-session-controller"));
const controller = new ToolSessionController();
const event = { guid: "test-full-group", name: "message.create", msg: "测试", UserId: "member", IsMaster: false };
values.set(`ai:third_party_tool:current:${event.guid}`, "opencode");
values.set(`ai:third_party_tool:permission:${event.guid}`, "full");
values.set(`ai:third_party_tool:session:opencode:${event.guid}`, "session-test");

test("同一群主人、群友交替调用时重新设置权限；群友禁止删除和重启，允许完整 Git", async () => {
  await controller.handleMessage({ ...event, IsMaster: true }, async () => {});
  assert.deepEqual(replies.at(-1), ["always", "always", "always"]);
  assert.deepEqual(rules.at(-1), [{ permission: "*", pattern: "*", action: "allow" }]);
  await controller.handleMessage(event, async () => {});
  assert.deepEqual(replies.at(-1), ["reject", "reject", "once"]);
  assert.equal(reviews, 1);
  assert.ok(rules.at(-1).some((rule) => rule.permission === "bash" && rule.action === "ask"));
  approved = false;
  await controller.handleMessage(event, async () => {});
  assert.deepEqual(replies.at(-1), ["reject", "reject", "reject"]);
  await controller.handleMessage({ ...event, IsMaster: true }, async () => {});
  assert.deepEqual(replies.at(-1), ["always", "always", "always"]);
});
