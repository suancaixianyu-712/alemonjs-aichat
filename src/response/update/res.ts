import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Text, useMessage } from "alemonjs";

export const selects = onSelects(["message.create", "private.message.create"]);

const runGitPull = (cwd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = exec("git pull", { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let output = "";
    const appendOutput = (data: Buffer) => {
      output += data.toString();
      if (output.length > 6000) {
        output = output.slice(-6000);
      }
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim() || "git pull 完成");
      else reject(new Error(`git pull 退出码 ${code}\n${output.trim()}`));
    });
  });
};

const runYarnAdd = (cwd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = exec("yarn add alemonjs-aichat", { cwd });
    let output = "";
    const appendOutput = (data: Buffer) => {
      output += data.toString();
      if (output.length > 6000) {
        output = output.slice(-6000);
      }
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim() || "yarn add alemonjs-aichat 完成");
      else reject(new Error(`yarn add alemonjs-aichat 退出码 ${code}\n${output.trim()}`));
    });
  });
};

const truncateOutput = (output: string, maxLength = 3000): string => {
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
};

export default onResponse(selects, async (e) => {
  const [message] = useMessage(e);

  if (!e.IsMaster) {
    await message.send(format(Text("该指令仅主人可用")));
    return;
  }

  await message.send(format(Text("正在检查 packages 目录中的 alemonjs-aichat 项目...")));

  const packagesDir = join(process.cwd(), "packages");
  const projectDir = join(packagesDir, "alemonjs-aichat");

  try {
    if (existsSync(join(projectDir, ".git"))) {
      await message.send(format(Text("检测到本地项目，正在执行 git pull...")));
      const result = await runGitPull(projectDir);
      await message.send(format(Text(truncateOutput(result))));
    } else {
      await message.send(format(Text("未检测到本地项目，正在执行 yarn add alemonjs-aichat...")));
      const result = await runYarnAdd(process.cwd());
      await message.send(format(Text(truncateOutput(result))));
    }
  } catch (error) {
    console.error("aichat 更新失败：", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    await message.send(format(Text(`更新失败：${truncateOutput(errorMessage)}`)));
  }
});
