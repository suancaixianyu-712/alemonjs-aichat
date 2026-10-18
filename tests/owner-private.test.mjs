import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CredentialVault, redactCredentialValues } from "../lib/api/credential-vault.js";
import { bindOwnerPrivateToolCall, credentialOwnerFromEvent, toolCallForDisplay, redactSavedCredentialContext } from "../lib/api/owner-private.js";

const owner = { IsMaster: true, name: "private.message.create", UserId: "owner-1", Platform: "test", guid: "private-owner" };

test("凭据加密持久化、跨实例复用、身份隔离、替换及删除", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aichat-vault-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true });
  });
  const vault = new CredentialVault(directory);
  const identity = credentialOwnerFromEvent(owner);
  const token = "sensitive-token-中文-123456";
  const saved = vault.save(identity, "github", { username: "account-one", token });
  assert.equal(JSON.stringify(saved).includes(token), false);
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".enc"))) {
    const content = fs.readFileSync(path.join(directory, file), "utf8");
    assert.equal(content.includes(token), false);
    assert.equal(content.includes("account-one"), false);
  }
  const restarted = new CredentialVault(directory);
  assert.equal(restarted.resolveEnv(identity, { API_TOKEN: { name: "github", field: "token" } }).env.API_TOKEN, token);
  assert.deepEqual(restarted.list("another-owner"), []);
  assert.throws(() => restarted.resolveEnv("another-owner", { API_TOKEN: { name: "github", field: "token" } }), /不存在/);
  vault.save(identity, "github", { token: "updated-token" });
  assert.deepEqual(vault.list(identity)[0].fields, ["token"]);
  assert.throws(() => vault.save(identity, "../escape", { token }), /名称/);
  assert.throws(() => vault.save(identity, "__proto__", { token }), /名称/);
  assert.throws(() => vault.resolveEnv(identity, { "INVALID-VAR": { name: "github", field: "token" } }), /格式/);
  assert.equal(vault.delete(identity, "github").deleted, true);
  assert.deepEqual(vault.list(identity), []);
});

test("密文损坏和密钥丢失时停止，不覆盖旧凭据", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aichat-vault-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true });
  });
  const vault = new CredentialVault(directory);
  vault.save("owner", "service", { password: "very-secret" });
  const file = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith(".enc")));
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  envelope.tag = Buffer.alloc(16).toString("base64");
  fs.writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => vault.list("owner"), /损坏/);
  fs.unlinkSync(path.join(directory, "master.key"));
  assert.throws(() => vault.save("owner", "new", { token: "new-token" }), /密钥缺失/);
  assert.equal(fs.existsSync(path.join(directory, "master.key")), false);
});

test("真实私聊身份覆盖伪造参数，群聊和普通用户无法管理或使用凭据", async () => {
  for (const event of [{ ...owner, IsMaster: false }, { ...owner, name: "message.create" }]) {
    const args = { ownerPrivate: true, credentialOwner: "forged", isMaster: true };
    await assert.rejects(bindOwnerPrivateToolCall(event, "ManageCredentials", args), /仅主人私聊/);
    assert.equal(args.ownerPrivate, false);
    assert.equal(args.credentialOwner, "");
    await assert.rejects(bindOwnerPrivateToolCall(event, "RunServerCommand", { credentialEnv: {} }), /仅主人私聊/);
  }
  const args = { credentialOwner: "forged" };
  await bindOwnerPrivateToolCall(owner, "ManageCredentials", args);
  assert.equal(args.credentialOwner, credentialOwnerFromEvent(owner));
  assert.notEqual(credentialOwnerFromEvent(owner), credentialOwnerFromEvent({ ...owner, Platform: "another-platform" }));
});

test("主人完全访问及后台任务直接继承身份，不因否定措辞或参数改写要求确认", async () => {
  const task = "通过 SSH 连接社区服务器，只读取系统状态，不删除文件、不重启服务";
  const background = { ...owner, __background: true };
  for (const event of [owner, background]) {
    for (const [name, args] of [
      ["SubAgent", { action: "spawn", task }],
      ["SubAgent", { action: "spawn", task: task + "，汇总负载和磁盘使用率" }],
      ["RunCodex", { prompt: task }],
      ["RunOpencode", { prompt: task }],
      ["RunServerCommand", { command: "hostname" }],
      ["RunServerCommand", { command: "systemctl restart example" }],
      ["AgentDeleteFile", { filePath: "example.txt" }],
    ]) {
      await bindOwnerPrivateToolCall(event, name, args);
      assert.equal(args.ownerPrivate, true);
      assert.equal(args.isMaster, true);
      assert.equal(args.credentialOwner, credentialOwnerFromEvent(owner));
    }
  }
});

test("敏感工具参数、输出和保存后的聊天上下文隐藏凭据原文", async () => {
  const secret = "private-password-123";
  const call = { function: { name: "ManageCredentials", arguments: JSON.stringify({ action: "save", fields: { password: secret } }) } };
  assert.equal(toolCallForDisplay(call).includes(secret), false);
  assert.equal(redactCredentialValues(`value=${secret}`, [secret]).includes(secret), false);
  const objects = [{ content: `请保存 ${secret}`, tool_calls: [call] }];
  let history = [{ content: secret }];
  await redactSavedCredentialContext("ManageCredentials", { action: "save", fields: { password: secret } }, { success: true }, objects, {
    getAIChatHistory: async () => history,
    setAIChatHistory: async (_guid, messages) => { history = messages; },
  }, "private-owner");
  assert.equal(JSON.stringify(objects).includes(secret), false);
  assert.equal(JSON.stringify(history).includes(secret), false);
  const protocol = [{ role: "user", content: "user" }, { role: "assistant", tool_calls: [{ type: "function", id: "id", function: { name: "ManageCredentials", arguments: '{"username":"user"}' } }] }];
  await redactSavedCredentialContext("ManageCredentials", { action: "save", fields: { username: "user" } }, { success: true }, [protocol], {
    getAIChatHistory: async () => [], setAIChatHistory: async () => {},
  }, "private-owner");
  assert.equal(protocol[0].role, "user");
  assert.equal(protocol[0].content, "[凭据已隐藏]");
  assert.equal(protocol[1].tool_calls[0].function.name, "ManageCredentials");
});
