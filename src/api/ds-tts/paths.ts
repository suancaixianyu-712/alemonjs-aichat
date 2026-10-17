/**
 * aichat 内嵌 ds-tts 数据目录：进程 cwd 下 `data/ds-tts/{cache,browser,config.json,out}`。
 * 凭据不落盘，只活在浏览器 profile。
 */
import { join, resolve } from "node:path";

export const DS_TTS_DIR_NAME = "ds-tts";

/** 数据根：`{cwd}/data/ds-tts`。 */
export function dsTtsRoot(): string {
  return resolve(process.cwd(), "data", DS_TTS_DIR_NAME);
}

export function dsTtsPath(...segments: string[]): string {
  return join(dsTtsRoot(), ...segments);
}

export function configFilePath(): string {
  return dsTtsPath("config.json");
}

export function cacheDirPath(): string {
  return dsTtsPath("cache");
}

export function browserProfilePath(): string {
  return dsTtsPath("browser");
}

export function outDirPath(): string {
  return dsTtsPath("out");
}
