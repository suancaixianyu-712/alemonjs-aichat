import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';
import { resolveUpdatePackageManager } from '../../api/update-package-manager.js';

const selects = onSelects(["message.create", "private.message.create"]);
const runGitPull = (cwd) => {
    return new Promise((resolve, reject) => {
        const child = exec("git pull", {
            cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        let output = "";
        const appendOutput = (data) => {
            output += data.toString();
            if (output.length > 6000) {
                output = output.slice(-6e3);
            }
        };
        child.stdout?.on("data", appendOutput);
        child.stderr?.on("data", appendOutput);
        child.on("error", (error) => reject(error));
        child.on("close", (code) => {
            if (code === 0)
                resolve(output.trim() || "git pull 完成");
            else
                reject(new Error(`git pull 退出码 ${code}\n${output.trim()}`));
        });
    });
};
const runPackageInstall = (cwd, command) => {
    return new Promise((resolve, reject) => {
        const child = exec(command, { cwd });
        let output = "";
        const appendOutput = (data) => {
            output += data.toString();
            if (output.length > 6000) {
                output = output.slice(-6e3);
            }
        };
        child.stdout?.on("data", appendOutput);
        child.stderr?.on("data", appendOutput);
        child.on("error", (error) => reject(error));
        child.on("close", (code) => {
            if (code === 0)
                resolve(output.trim() || `${command} 完成`);
            else
                reject(new Error(`${command} 退出码 ${code}\n${output.trim()}`));
        });
    });
};
const truncateOutput = (output, maxLength = 3000) => {
    const trimmed = output.trim();
    if (trimmed.length <= maxLength)
        return trimmed;
    return `${trimmed.slice(0, maxLength)}...`;
};
var res = onResponse(selects, async (e) => {
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
        }
        else {
            // 安装 cwd 是宿主项目根目录（process.cwd），按该目录锁文件选包管理器
            const plan = resolveUpdatePackageManager(process.cwd());
            await message.send(format(Text(`未检测到本地项目，正在执行 ${plan.hint}...`)));
            const result = await runPackageInstall(process.cwd(), plan.command);
            await message.send(format(Text(truncateOutput(result))));
        }
    }
    catch (error) {
        console.error("aichat 更新失败：", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        await message.send(format(Text(`更新失败：${truncateOutput(errorMessage)}`)));
    }
});

export { res as default, selects };
