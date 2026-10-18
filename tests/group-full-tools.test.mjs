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
const { assertGroupFullToolAccess, assertAgentToolAccess, availableTools } = await import(moduleUrl("api/aitools"));
const { credentialVault } = await import(moduleUrl("api/credential-vault"));
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

test("主人私聊 agent 关闭时可管理服务器，群聊和非主人仍受原开关限制", async () => {
  assert.equal(await assertAgentToolAccess("AgentWriteFile", "private-owner", "root", true, false, true), "__server_root__");
  assert.equal(await assertAgentToolAccess("RunServerCommand", "private-owner", undefined, true, false, true), "private-owner");
  await assert.rejects(assertAgentToolAccess("AgentWriteFile", "private-owner", "root", true, false, false), /agent 未开启/);
  await assert.rejects(assertAgentToolAccess("RunServerCommand", "private-owner", undefined, false, false, true), /agent 未开启/);
  for (const identity of [{ isMaster: false, ownerPrivate: true }, { isMaster: true, ownerPrivate: false }]) {
    const result = await availableTools.ManageCredentials({ action: "list", credentialOwner: "forged", ...identity });
    assert.equal(result.success, false);
    assert.match(result.error, /仅主人私聊/);
  }
});

test("服务器命令可使用凭据环境变量，输出隐藏原文且不污染后续进程环境", async () => {
  const secret = "vault-integration-secret-456";
  const originalResolve = credentialVault.resolveEnv;
  credentialVault.resolveEnv = () => ({ env: { AICHAT_TEST_SECRET: secret }, secrets: [secret] });
  try {
    const result = await availableTools.RunServerCommand({
      command: 'node -e "process.stdout.write(process.env.AICHAT_TEST_SECRET)"',
      reviewGuid: "private-owner", isMaster: true, ownerPrivate: true,
      credentialOwner: "test-owner", credentialEnv: { AICHAT_TEST_SECRET: { name: "example", field: "token" } },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.output, "[凭据已隐藏]");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(process.env.AICHAT_TEST_SECRET, undefined);
  } finally { credentialVault.resolveEnv = originalResolve; }
});
