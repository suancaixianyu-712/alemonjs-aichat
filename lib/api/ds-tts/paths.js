import { resolve, join } from 'node:path';

/**
 * aichat 内嵌 ds-tts 数据目录：进程 cwd 下 `data/ds-tts/{cache,browser,config.json,out}`。
 * 凭据不落盘，只活在浏览器 profile。
 */
const DS_TTS_DIR_NAME = "ds-tts";
/** 数据根：`{cwd}/data/ds-tts`。 */
function dsTtsRoot() {
    return resolve(process.cwd(), "data", DS_TTS_DIR_NAME);
}
function dsTtsPath(...segments) {
    return join(dsTtsRoot(), ...segments);
}
function configFilePath() {
    return dsTtsPath("config.json");
}
function cacheDirPath() {
    return dsTtsPath("cache");
}
function browserProfilePath() {
    return dsTtsPath("browser");
}
function outDirPath() {
    return dsTtsPath("out");
}

export { DS_TTS_DIR_NAME, browserProfilePath, cacheDirPath, configFilePath, dsTtsPath, dsTtsRoot, outDirPath };
