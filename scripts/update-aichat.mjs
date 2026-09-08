import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(rootDir, "packages", "alemonjs-aichat");
const yarnLinkDir = join(rootDir, ".yarn-links");

const capture = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });

  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(`无法执行 ${command} ${args.join(" ")}`);
    process.exit(1);
  }

  return result.stdout.trim();
};

const run = (command, args, cwd = rootDir) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    console.error(`无法执行 ${command}：${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const yarnCli = process.env.npm_execpath;
if (!yarnCli || !/^yarn\.(?:c?js)$/i.test(basename(yarnCli))) {
  console.error("请使用 Yarn 1.x 执行 yarn update:aichat。");
  process.exit(1);
}

if (!existsSync(join(pluginDir, ".git"))) {
  console.error(
    "未找到 packages/alemonjs-aichat 的 Git 仓库，请先运行 yarn setup。",
  );
  process.exit(1);
}

const branch = capture("git", ["branch", "--show-current"], pluginDir);
if (branch !== "release") {
  console.error(`插件当前位于 ${branch || "未知"} 分支，更新脚本只允许更新 release 分支。`);
  process.exit(1);
}

// release 不一定携带 .gitignore，Yarn 可能在工作区内生成 node_modules。
// 已跟踪文件的修改仍全部检查，仅从未跟踪文件中排除依赖目录。
const trackedChanges = capture(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  pluginDir,
);
const untrackedFiles = capture(
  "git",
  ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude)node_modules"],
  pluginDir,
);
const changes = [trackedChanges, untrackedFiles].filter(Boolean).join("\n");
if (changes) {
  console.error("插件源码中存在未提交修改，已停止更新：");
  console.error(changes);
  process.exit(1);
}

console.log("正在更新 release 分支……");
run("git", ["pull", "--ff-only", "origin", "release"], pluginDir);

console.log("正在同步依赖……");
run(
  process.execPath,
  [yarnCli, "install", "--production=true", "--link-folder", yarnLinkDir],
);

console.log("Aichat 更新完成。");
