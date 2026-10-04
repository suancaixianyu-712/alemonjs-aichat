import assert from "node:assert/strict";
import { mock, test } from "node:test";

const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;
const modes = new Map([["full-group", "full"]]);
mock.module(moduleUrl("config"), { defaultExport: {
  redis: { get: async (key) => modes.get(key.split(":").at(-1)) },
  getAgentSwitch: async () => "0",
} });
mock.module(moduleUrl("config/app"), { namedExports: { getAiChatConfigValue: () => ({}) } });
mock.module(moduleUrl("redis"), { namedExports: { redis: {} } });
mock.module(moduleUrl("s3"), { namedExports: {
  uploadImageToR2: async () => "", uploadMediaToR2: async () => "",
} });
mock.module(moduleUrl("response/zreply/getChatConfig"), { namedExports: { isNonVisionModel: () => false } });
mock.module(moduleUrl("api/xianyu-game"), { namedExports: { useXianyuGameTool: async () => ({}) } });
mock.module(moduleUrl("api/speech-tool"), { namedExports: { generateSpeech: async () => ({}) } });
const { assertGroupFullToolAccess, assertAgentToolAccess } = await import(moduleUrl("api/aitools"));
const member = { name: "message.create", guid: "full-group", IsMaster: false };

test("完全访问群成员获得 root 和公共目录写入权限，删除文件和危险命令在执行前拒绝", async () => {
  const full = await assertGroupFullToolAccess(member, "AgentWriteFile", {});
  assert.equal(full, true);
  assert.equal(await assertAgentToolAccess("AgentWriteFile", member.guid, "root", false, full), "__server_root__");
  assert.equal(await assertAgentToolAccess("AgentWriteFile", member.guid, "public", false, full), "knowledge");
  await assert.rejects(assertGroupFullToolAccess(member, "AgentDeleteFile", {}), /仅主人/);
  for (const command of ["rm -rf repo", "systemctl restart app", "git rm file"]) {
    await assert.rejects(assertGroupFullToolAccess(member, "RunServerCommand", { command }), /仅主人/);
  }
  assert.equal(await assertGroupFullToolAccess(member, "AgentProjectCommand", { command: "git push origin main" }), true);
  assert.equal(member.IsMaster, false);
});

test("其他群和私聊不能继承当前群授权，模型提供的字段不会获得群权限", async () => {
  assert.equal(await assertGroupFullToolAccess({ ...member, guid: "other-group" }, "AgentWriteFile", { groupFullAccess: true, isMaster: true }), false);
  assert.equal(await assertGroupFullToolAccess({ ...member, name: "private.message.create" }, "AgentWriteFile", {}), false);
  await assert.rejects(assertAgentToolAccess("AgentWriteFile", "other-group", "root", false, false), /仅主人/);
});

test("主人仍可删除，普通群友的独立 CLI 子代理强制只读", async () => {
  assert.equal(await assertGroupFullToolAccess({ ...member, IsMaster: true }, "AgentDeleteFile", {}), true);
  for (const tool of ["RunCodex", "RunOpencode"]) {
    const args = { autoApprove: true, prompt: "分析代码" };
    await assertGroupFullToolAccess(member, tool, args);
    assert.equal(args.autoApprove, false);
    assert.match(args.prompt, /仅主人可用/);
  }
});
