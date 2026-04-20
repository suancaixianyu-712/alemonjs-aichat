import fs from "fs";
import path from "path";

const BASE = "./public/sandbox/workspaces";

export function getWorkspace(userId: string) {
  const dir = path.join(BASE, userId);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return dir;
}
