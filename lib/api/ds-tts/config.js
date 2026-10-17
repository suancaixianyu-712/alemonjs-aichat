import { stat, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configFilePath } from './paths.js';

/**
 * ds-tts 配置：默认值 ⊕ `data/ds-tts/config.json` 热读 ⊕ Redis `ai:ds_tts:config` 镜像。
 * 刻意不含任何凭据字段。
 */
const DS_TTS_REDIS_CONFIG_KEY = "ai:ds_tts:config";
const DS_TTS_VOICES = ["mira", "echo", "stella", "tide"];
/** 部署默认值（v1 固定 echo 投递）。 */
const DEFAULT_DS_TTS_CONFIG = {
    voice: "mira",
    format: "pcm",
    mode: "echo",
    maxChars: 2000,
    cdpUrl: "",
    cdpPort: 9222,
    browserPath: "",
    userDataDir: "",
    autoLaunch: true,
    chatSessionId: "",
    echoPrompt: "请原样输出下面这段文本，不要添加任何解释、标题、序号或 Markdown 格式，也不要翻译：\n\n{text}",
    echoVerify: true,
    timeoutMs: 120000,
    cacheEnabled: true,
    cacheKeepDays: 30,
    ffplayPath: "",
};
function normalizeFormat(value, fallback) {
    return value === "opus" || value === "pcm" ? value : fallback;
}
function normalizeMode(value, fallback) {
    // v1 固定 echo；文件里即便写了 auto/user 也压成 echo，避免白跑投递
    if (value === "echo" || value === "user" || value === "auto")
        return "echo";
    return fallback;
}
function isDsTtsVoiceId(value) {
    return typeof value === "string" && DS_TTS_VOICES.includes(value);
}
/** 把任意补丁规整成合法视图字段。 */
function normalizeConfigPatch(patch) {
    const out = {};
    if (typeof patch.voice === "string" && patch.voice.trim()) {
        const v = patch.voice.trim().toLowerCase();
        if (isDsTtsVoiceId(v))
            out.voice = v;
    }
    if (patch.format === "pcm" || patch.format === "opus")
        out.format = patch.format;
    // v1 不允许改 mode；始终 echo
    if (patch.mode !== undefined)
        out.mode = "echo";
    if (typeof patch.maxChars === "number" && Number.isFinite(patch.maxChars)) {
        out.maxChars = Math.min(20000, Math.max(50, Math.round(patch.maxChars)));
    }
    if (typeof patch.cdpUrl === "string")
        out.cdpUrl = patch.cdpUrl.trim();
    if (typeof patch.cdpPort === "number" && Number.isFinite(patch.cdpPort)) {
        out.cdpPort = Math.min(65535, Math.max(1, Math.round(patch.cdpPort)));
    }
    if (typeof patch.browserPath === "string")
        out.browserPath = patch.browserPath.trim();
    if (typeof patch.userDataDir === "string")
        out.userDataDir = patch.userDataDir.trim();
    if (typeof patch.autoLaunch === "boolean")
        out.autoLaunch = patch.autoLaunch;
    if (typeof patch.chatSessionId === "string")
        out.chatSessionId = patch.chatSessionId.trim();
    if (typeof patch.echoPrompt === "string" && patch.echoPrompt.includes("{text}")) {
        out.echoPrompt = patch.echoPrompt;
    }
    if (typeof patch.echoVerify === "boolean")
        out.echoVerify = patch.echoVerify;
    if (typeof patch.timeoutMs === "number" && Number.isFinite(patch.timeoutMs)) {
        out.timeoutMs = Math.min(600000, Math.max(5000, Math.round(patch.timeoutMs)));
    }
    if (typeof patch.cacheEnabled === "boolean")
        out.cacheEnabled = patch.cacheEnabled;
    if (typeof patch.cacheKeepDays === "number" && Number.isFinite(patch.cacheKeepDays)) {
        out.cacheKeepDays = Math.max(0, Math.round(patch.cacheKeepDays));
    }
    if (typeof patch.ffplayPath === "string")
        out.ffplayPath = patch.ffplayPath.trim();
    return out;
}
function applyDefaults(merged) {
    return {
        ...merged,
        voice: merged.voice || "mira",
        format: normalizeFormat(merged.format, "pcm"),
        mode: normalizeMode(merged.mode, "echo"),
        maxChars: Math.min(20000, Math.max(50, Math.round(merged.maxChars))),
        cdpPort: Math.min(65535, Math.max(1, Math.round(merged.cdpPort))),
        timeoutMs: Math.min(600000, Math.max(5000, Math.round(merged.timeoutMs))),
        cacheKeepDays: Math.max(0, Math.round(merged.cacheKeepDays)),
    };
}
/** 配置存储：本地 JSON 热读 + Redis 镜像（供指令查询）。 */
class ConfigStore {
    overlay = {};
    overlayMtimeMs = -1;
    loaded = false;
    get filePath() {
        return configFilePath();
    }
    get isLoaded() {
        return this.loaded;
    }
    async load() {
        await this.refresh();
        this.loaded = true;
    }
    async refresh() {
        let mtimeMs = -1;
        try {
            mtimeMs = (await stat(this.filePath)).mtimeMs;
        }
        catch {
            // missing
        }
        if (mtimeMs === this.overlayMtimeMs)
            return;
        this.overlayMtimeMs = mtimeMs;
        if (mtimeMs < 0) {
            this.overlay = {};
            return;
        }
        try {
            const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
            this.overlay = typeof parsed === "object" && parsed !== null ? parsed : {};
        }
        catch {
            this.overlay = {};
        }
    }
    applyOverlay() {
        return applyDefaults({ ...DEFAULT_DS_TTS_CONFIG, ...(this.overlay.config ?? {}) });
    }
    async view() {
        await this.refresh();
        return this.applyOverlay();
    }
    current() {
        return this.applyOverlay();
    }
    async patch(patch) {
        await this.refresh();
        const nextConfig = { ...(this.overlay.config ?? {}) };
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined)
                continue;
            nextConfig[key] = value;
        }
        await this.write({ ...this.overlay, config: nextConfig });
        await this.mirrorRedis(nextConfig);
        return this.applyOverlay();
    }
    async runtime() {
        await this.refresh();
        const r = this.overlay.runtime ?? {};
        return {
            userModeSupported: r.userModeSupported ?? null,
            chatSessionId: r.chatSessionId ?? "",
            lastProbe: r.lastProbe ?? null,
            voicesCache: r.voicesCache ?? null,
        };
    }
    async setRuntime(patch) {
        await this.refresh();
        await this.write({ ...this.overlay, runtime: { ...(this.overlay.runtime ?? {}), ...patch } });
    }
    async write(next) {
        const target = this.filePath;
        await mkdir(dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid.toString()}`;
        await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        await rename(tmp, target);
        this.overlay = next;
        try {
            this.overlayMtimeMs = (await stat(target)).mtimeMs;
        }
        catch {
            this.overlayMtimeMs = -1;
        }
    }
    /** Redis 只存用户可改字段镜像，不含 runtime / 凭据。懒加载，避免 import 时连 Redis。 */
    async mirrorRedis(config) {
        try {
            const { default: redisClient } = await import('../../config.js');
            const view = applyDefaults({ ...DEFAULT_DS_TTS_CONFIG, ...config });
            const publicView = {
                voice: view.voice,
                maxChars: view.maxChars,
                timeoutMs: view.timeoutMs,
                cdpPort: view.cdpPort,
                autoLaunch: view.autoLaunch,
                browserPath: view.browserPath,
                cdpUrl: view.cdpUrl,
                echoVerify: view.echoVerify,
                cacheEnabled: view.cacheEnabled,
                mode: view.mode,
            };
            await redisClient.redis.set(DS_TTS_REDIS_CONFIG_KEY, JSON.stringify(publicView));
        }
        catch {
            // Redis 不可用不阻断本地配置
        }
    }
}
let storeSingleton;
function getDsTtsConfigStore() {
    if (!storeSingleton)
        storeSingleton = new ConfigStore();
    return storeSingleton;
}
/** 测试用：重置单例。 */
function resetDsTtsConfigStoreForTests() {
    storeSingleton = undefined;
}

export { ConfigStore, DEFAULT_DS_TTS_CONFIG, DS_TTS_REDIS_CONFIG_KEY, DS_TTS_VOICES, getDsTtsConfigStore, isDsTtsVoiceId, normalizeConfigPatch, resetDsTtsConfigStoreForTests };
