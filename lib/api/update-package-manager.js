import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 按项目根目录的锁文件选择包管理器（不看 yarn/npm 二进制是否存在）：
 * - 同时有 yarn.lock 与 package-lock.json → npm（AI/工具环境更稳妥）
 * - 仅有 yarn.lock → yarn
 * - 仅有 package-lock.json → npm
 * - 都没有 → 默认 npm
 */
const resolveUpdatePackageManager = (projectRoot, exists = existsSync) => {
    const hasYarnLock = exists(join(projectRoot, "yarn.lock"));
    const hasNpmLock = exists(join(projectRoot, "package-lock.json"));
    if (hasYarnLock && !hasNpmLock) {
        return {
            manager: "yarn",
            command: "yarn add alemonjs-aichat",
            hint: "yarn add alemonjs-aichat",
        };
    }
    return {
        manager: "npm",
        command: "npm install alemonjs-aichat",
        hint: "npm install alemonjs-aichat",
    };
};

export { resolveUpdatePackageManager };
