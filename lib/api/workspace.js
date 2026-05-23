import fs from 'fs';
import path from 'path';

// 👇 关键：用 __dirname 或 process.cwd() 转成绝对路径
const BASE = path.resolve(process.cwd(), "public/sandbox/workspaces");
function getWorkspace(userId) {
    const dir = path.join(BASE, userId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir; // 👈 现在返回的是绝对路径！
}

export { getWorkspace };
