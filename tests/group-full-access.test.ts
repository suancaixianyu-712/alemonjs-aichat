import assert from "node:assert/strict";
import test from "node:test";
import { hasGroupFullAccess, isOwnerOnlyOperation } from "../src/api/group-full-access.ts";

test("完全访问只共享到当前群，私聊和其他模式不获得群授权", () => {
  assert.equal(hasGroupFullAccess({ name: "message.create" }, "full"), true);
  assert.equal(hasGroupFullAccess({ name: "message.create" }, "auto"), false);
  assert.equal(hasGroupFullAccess({ name: "private.message.create" }, "full"), false);
  assert.equal(hasGroupFullAccess({ Name: "private.message.create" }, "full"), false);
});

test("删除文件、仓库和服务管理的危险操作仅主人可用", () => {
  for (const command of ["rm -rf repo", "Remove-Item -LiteralPath repo", "git rm file.ts", "git -C repo clean -fd", "git reset --hard", "gh repo delete team/repo --yes", "git push origin --delete branch", "pm2 restart app", "systemctl stop app", "docker compose down", "taskkill /PID 123", "python -c 'import shutil; shutil.rmtree(\"repo\")'", "node -e 'fs.unlinkSync(\"a\")'", "node -e 'fs.promises.rm(\"a\")'", "删除git库", "重启服务"]) {
    assert.equal(isOwnerOnlyOperation(command), true, command);
    assert.equal(isOwnerOnlyOperation(JSON.stringify({ command })), true, command);
  }
});

test("其余常见读写、Git 和服务器查询操作仍允许", () => {
  for (const command of ["git status", "git commit -m update", "git push origin main", "git pull", "git merge feature", "git clone git@example.com:team/repo.git", "npm install", "npm run build", "pm2 logs app", "systemctl status app", "cat /etc/os-release", "mkdir project"]) {
    assert.equal(isOwnerOnlyOperation(command), false, command);
  }
});
