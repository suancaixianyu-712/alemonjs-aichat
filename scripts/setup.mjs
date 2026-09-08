import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(rootDir, "packages");
const pluginDir = join(packagesDir, "alemonjs-aichat");
const yarnLinkDir = join(rootDir, ".yarn-links");
const repositoryUrl = "https://gitee.com/suancaixianyu/alemonjs-aichat.git";

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

const check = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "ignore",
    shell: false,
  });

  if (result.error || result.status !== 0) {
    console.error(`未找到可用的 ${command}，请先按 README 安装运行环境。`);
    process.exit(1);
  }
};

// Yarn 注入自己的 JS 入口；直接交给 Node，避免 Windows .cmd 和路径转义问题。
const yarnCli = process.env.npm_execpath;
if (!yarnCli || !/^yarn\.(?:c?js)$/i.test(basename(yarnCli))) {
  console.error("请使用 Yarn 1.x 执行 yarn setup。");
  process.exit(1);
}

check("git", ["--version"]);
check(process.execPath, [yarnCli, "--version"]);

mkdirSync(packagesDir, { recursive: true });

if (existsSync(pluginDir)) {
  console.error(
    "packages/alemonjs-aichat 已存在，安装脚本不会覆盖它。请运行 yarn update:aichat 更新。",
  );
  process.exit(1);
}

console.log("正在从 release 分支拉取 Aichat 源码……");
run("git", [
  "clone",
  "-b",
  "release",
  "--single-branch",
  repositoryUrl,
  pluginDir,
]);

const exampleConfig = join(rootDir, "alemon.config.example.yaml");
const localConfig = join(rootDir, "alemon.config.yaml");
if (!existsSync(localConfig)) {
  copyFileSync(exampleConfig, localConfig);
  console.log("已创建 alemon.config.yaml，请在启动前填写 OneBot 和 Redis 配置。");
} else {
  console.log("检测到现有 alemon.config.yaml，已保留原配置。");
}

console.log("正在安装运行依赖……");
run(
  process.execPath,
  [yarnCli, "install", "--production=true", "--link-folder", yarnLinkDir],
);

console.log("安装完成。配置 alemon.config.yaml 后运行 yarn start。");
