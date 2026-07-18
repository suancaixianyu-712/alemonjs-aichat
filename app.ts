import { start } from "alemonjs";
import { createServer } from "jsxp";

const isJSXP = process.argv.includes("--jsxp");

if (isJSXP) {
  // 修复 Windows 下 process.cwd() 大小写不一致导致图片 403 的问题
  const _cwd = process.cwd;
  process.cwd = () => _cwd().toLowerCase();

  // jsxp 图片预览模式：tsx watch 会在文件变化时重启进程，
  // createServer 生成新 KEY → 浏览器轮询检测到变化 → 自动刷新
  void createServer();
} else {
  start("src/index.ts");
}
