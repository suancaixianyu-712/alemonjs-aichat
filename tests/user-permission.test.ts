import assert from "node:assert/strict";
import test from "node:test";
import {
  annotatePermissionBoundary,
  buildUserPermissionPrompt,
  type UserPermissionInput,
} from "../src/api/user-permission.ts";

const base = (
  overrides: Partial<UserPermissionInput> = {},
): UserPermissionInput => ({
  isMaster: false,
  isAdmin: false,
  isPrivate: false,
  agentEnabled: false,
  opencodeActive: false,
  opencodePermission: "readonly",
  ...overrides,
});

test("普通用户在 agent 关闭时只能读取，并且知道审核拒绝后不能绕过", () => {
  const prompt = buildUserPermissionPrompt(base());
  assert.match(prompt, /身份：普通用户/);
  assert.match(prompt, /群身份：普通成员/);
  assert.match(prompt, /会话 agent：未开启/);
  assert.match(prompt, /列出、搜索、读取/);
  assert.match(prompt, /#开启agent/);
  assert.match(prompt, /不要改写命令、更换工具/);
  assert.doesNotMatch(prompt, /执行任意 Shell/);
});

test("主人开启 agent 后才能使用任意 Shell 和完整 Git", () => {
  const prompt = buildUserPermissionPrompt(
    base({ isMaster: true, isAdmin: true, agentEnabled: true }),
  );
  assert.match(prompt, /身份：框架主人/);
  assert.match(prompt, /群身份：群管理员或群主/);
  assert.match(prompt, /会话 agent：已开启/);
  assert.match(prompt, /任意目录执行 Shell/);
  assert.match(prompt, /完整 Git/);
  assert.match(prompt, /主人也不能绕过/);
});

test("普通用户开启 agent 后仍然受审核限制", () => {
  const prompt = buildUserPermissionPrompt(base({ agentEnabled: true }));
  assert.match(prompt, /AI 审核明确允许/);
  assert.match(prompt, /scope=root/);
  assert.match(prompt, /跳过命令审核/);
  assert.doesNotMatch(prompt, /任意目录执行 Shell/);
});

test("主人私聊无需 agent 即可管理服务器并保存和使用凭据", () => {
  const prompt = buildUserPermissionPrompt(base({ isMaster: true, isPrivate: true }));
  assert.match(prompt, /无需 #开启agent/);
  assert.match(prompt, /ManageCredentials/);
  assert.match(prompt, /credentialEnv/);
  assert.match(prompt, /不额外索要确认或确认码/);
  assert.doesNotMatch(prompt, /回复确认执行|相同的工具和参数调用/);
  assert.doesNotMatch(prompt, /这些要等主人发送/);
});

test("OpenCode 自动审核会写明拒绝后不能换操作重试", () => {
  const prompt = buildUserPermissionPrompt(
    base({
      isPrivate: true,
      opencodeActive: true,
      opencodePermission: "auto",
    }),
  );
  assert.match(prompt, /群身份：私聊，不区分群管理员/);
  assert.match(prompt, /权限是「自动审核」/);
  assert.match(prompt, /换一条命令、换一个工具或拆开步骤再试/);
});

test("群完全访问允许普通群友使用服务器和完整 Git，但危险操作仍仅主人可用", () => {
  const prompt = buildUserPermissionPrompt(base({ opencodePermission: "full" }));
  assert.match(prompt, /身份：普通用户/);
  assert.match(prompt, /完整 Git（提交、推送、拉取、合并）/);
  assert.match(prompt, /scope=root/);
  assert.match(prompt, /删除文件、目录或 Git 仓库/);
  assert.match(prompt, /重启或停止服务和进程仅主人可用/);
  assert.doesNotMatch(prompt, /Git 只限受限/);
  assert.doesNotMatch(prompt, /这些要等主人发送/);
  const privatePrompt = buildUserPermissionPrompt(base({ isPrivate: true, opencodePermission: "full" }));
  assert.match(privatePrompt, /#开启agent/);
});

test("审核拒绝会标记为不可重试，普通执行失败保持原样", () => {
  const reviewed = annotatePermissionBoundary({
    success: false,
    error: "命令未通过安全审查",
    review: { allowed: false, localReview: { reasons: ["git 仅允许受限子命令"] } },
  });
  assert.equal(reviewed.permissionDenied, true);
  assert.equal(reviewed.doNotRetry, true);
  assert.match(reviewed.instruction, /最终拒绝/);

  const spreadReview = annotatePermissionBoundary({
    success: true,
    allowed: false,
    localReview: { reasons: ["命令不能为空"] },
  });
  assert.equal(spreadReview.doNotRetry, true);

  const disabled = annotatePermissionBoundary({
    ok: false,
    error: "工具被禁用：RunServerCommand",
  });
  assert.equal(disabled.permissionDenied, true);

  const executionFailure = annotatePermissionBoundary({
    success: false,
    error: "项目命令执行失败",
    exitCode: 1,
  });
  assert.equal(executionFailure.doNotRetry, undefined);
  assert.equal(
    (executionFailure as { permissionDenied?: boolean }).permissionDenied,
    undefined,
  );
});
