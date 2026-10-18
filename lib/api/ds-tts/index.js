import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TtsEngine } from './engine.js';
import { isDsTtsVoiceId, DS_TTS_VOICES, getDsTtsConfigStore, normalizeConfigPatch } from './config.js';
export { DEFAULT_DS_TTS_CONFIG, DS_TTS_REDIS_CONFIG_KEY } from './config.js';
import { browserProfilePath, cacheDirPath, dsTtsRoot } from './paths.js';
export { configFilePath } from './paths.js';
import { readCache } from './audio/cache.js';
export { normalizeForSpeech } from './ds/text.js';
export { resolveAttemptOrder } from './ds/mode.js';
export { KNOWN_DS_VOICES } from './protocol.js';

/**
 * aichat 内嵌 DeepSeek 官方朗读：合成 → 缓存文件 → 上传 R2 → SpeechToolResult。
 * 与 GenerateSpeech / MiniMaxVoice 并列，失败不降级 OpenAI。
 */
let engineSingleton;
const log = (message, data) => {
    if (data === undefined)
        console.log(`[ds-tts] ${message}`);
    else
        console.log(`[ds-tts] ${message}`, data);
};
function getDsTtsEngine(config) {
    if (!engineSingleton) {
        engineSingleton = new TtsEngine({
            config: config ?? getDsTtsConfigStore(),
            log,
        });
    }
    return engineSingleton;
}
/** 测试用。 */
function resetDsTtsEngineForTests() {
    engineSingleton = undefined;
}
/**
 * 工具 DsTtsSpeak：合成并上传，返回与 GenerateSpeech 同形的 audio 结果。
 */
async function dsTtsSpeak(options) {
    const text = String(options.text ?? "");
    if (!text.trim()) {
        return { ok: false, error: "朗读文本不能为空", code: "NO_CONTENT" };
    }
    const voiceRaw = String(options.voice ?? "").trim().toLowerCase();
    if (voiceRaw && !isDsTtsVoiceId(voiceRaw)) {
        return {
            ok: false,
            error: `不支持的音色「${voiceRaw}」。可选：${DS_TTS_VOICES.join(" / ")}（mira贝壳 / echo白浪 / stella海星 / tide暗潮）`,
            code: "BAD_REQUEST",
        };
    }
    const store = getDsTtsConfigStore();
    await store.load();
    const engine = getDsTtsEngine(store);
    const result = await engine.synthesize({
        text,
        ...(voiceRaw ? { voice: voiceRaw } : {}),
        mode: "echo",
        ...(options.regenerate === true ? { regenerate: true } : {}),
    });
    if (!result.ok) {
        const hint = result.code === "NOT_LOGGED_IN"
            ? `\n请在专用浏览器窗口登录 chat.deepseek.com（profile：${browserProfilePath()}），登录后无需重启，再调一次即可。可用 #DS朗读状态 排查。`
            : result.code === "NO_BROWSER"
                ? `\n请确认本机已安装 Chrome/Edge，Linux 需用 #DS朗读配置 设置 browserPath。可用 #DS朗读状态 排查。`
                : result.detail
                    ? `\n${result.detail}`
                    : "";
        return {
            ok: false,
            error: `${result.error}${hint}`,
            code: result.code,
        };
    }
    const hit = await readCache(cacheDirPath(), result.id, [result.ext]);
    const audioPath = hit?.path;
    const ext = result.ext;
    if (!audioPath) {
        // 缓存未写时兜底：不应常态发生（默认 cacheEnabled）
        return {
            ok: false,
            error: "合成成功但未找到缓存音频文件，请开启缓存后重试",
            code: "CACHE_WRITE_FAILED",
        };
    }
    // 唯一对象路径避免 CDN 复用旧音频，不依赖查询参数是否参与缓存键。
    const fileName = `ds-tts-${result.id}-${randomUUID()}.${ext}`;
    let directory = "";
    try {
        const bytes = await readFile(audioPath);
        directory = await mkdtemp(join(tmpdir(), "aichat-ds-tts-"));
        const file = join(directory, fileName);
        await writeFile(file, bytes);
        const { uploadMediaToR2 } = await import('../../s3.js');
        const url = await uploadMediaToR2(file, fileName);
        return {
            ok: true,
            type: "audio",
            url,
            model: "ds-tts",
            voice: result.voice || voiceRaw || "mira",
        };
    }
    catch (error) {
        console.error("DS 朗读上传失败：", error);
        return {
            ok: false,
            error: error?.message
                ? `DS 朗读合成成功但上传失败：${error.message}`
                : "DS 朗读上传失败，请稍后重试",
            code: "INTERNAL",
        };
    }
    finally {
        if (directory) {
            const file = join(directory, fileName);
            await unlink(file).catch(() => undefined);
            await rmdir(directory).catch(() => undefined);
        }
    }
}
/**
 * 工具 / 指令共用的状态快照（中文友好）。
 */
async function dsTtsStatus() {
    const store = getDsTtsConfigStore();
    await store.load();
    const engine = getDsTtsEngine(store);
    const status = await engine.status();
    const lines = [
        `浏览器：${status.browser.connected ? `已连通（${status.browser.browserVersion || "-"}）` : "未连通"}`,
        `DS 页面：${status.ds.pageFound ? status.browser.pageUrl || "已打开" : "未打开（首次朗读会自动打开）"}`,
        `DS 登录：${status.ds.pageFound ? (status.ds.loggedIn ? "已登录" : "未登录") : "(需先打开页面)"}`,
        `账号放行：${status.ds.allowed === null ? "未探测" : status.ds.allowed ? "可用" : "不可用"}`,
        `队列：排队 ${status.queue.pending}${status.queue.active ? " · 正在合成" : ""}`,
        `缓存：${status.cache.files} 个 / ${(status.cache.bytes / 1024 / 1024).toFixed(1)} MB · 命中 ${status.cache.hits} / 未命中 ${status.cache.misses}`,
        `配置：voice=${status.config.voice} · timeoutMs=${status.config.timeoutMs} · cdpPort=${status.config.cdpPort} · autoLaunch=${status.config.autoLaunch ? "开" : "关"}`,
        `browserPath：${status.config.browserPath || "(空，Windows 可自动探测；Linux 请配置)"}`,
        `数据目录：${dsTtsRoot()}`,
    ];
    if (!status.ds.loggedIn) {
        lines.push(`未登录时请在专用浏览器窗口打开并登录 chat.deepseek.com（profile：${browserProfilePath()}），登录后不用重启。`);
    }
    if (status.browser.lastError) {
        lines.push(`最近错误：${status.browser.lastError}`);
    }
    return { ok: true, text: lines.join("\n"), raw: status };
}
/** 读生效配置（指令用）。 */
async function getDsTtsConfigView() {
    const store = getDsTtsConfigStore();
    await store.load();
    return store.view();
}
/** 写配置补丁（指令用）。 */
async function patchDsTtsConfig(raw) {
    const patch = normalizeConfigPatch(raw);
    if (Object.keys(patch).length === 0) {
        throw new Error("没有可识别的配置项。可改：voice / maxChars / timeoutMs / cdpPort / autoLaunch / browserPath / cdpUrl / echoVerify");
    }
    if (raw.voice !== undefined && !patch.voice) {
        throw new Error(`音色无效。可选：${DS_TTS_VOICES.join(" / ")}`);
    }
    const store = getDsTtsConfigStore();
    await store.load();
    return store.patch(patch);
}
function formatDsTtsConfigText(view) {
    return [
        "DS 朗读配置：",
        `voice：${view.voice}（mira贝壳 / echo白浪 / stella海星 / tide暗潮）`,
        `maxChars：${view.maxChars}`,
        `timeoutMs：${view.timeoutMs}`,
        `cdpPort：${view.cdpPort}`,
        `autoLaunch：${view.autoLaunch ? "true" : "false"}`,
        `browserPath：${view.browserPath || "(空)"}`,
        `cdpUrl：${view.cdpUrl || "(空)"}`,
        `echoVerify：${view.echoVerify ? "true" : "false"}`,
        `mode：${view.mode}（v1 固定 echo）`,
        `数据目录：${dsTtsRoot()}`,
        "",
        "改法：#DS朗读配置 voice=mira timeoutMs=120000 browserPath=/usr/bin/google-chrome",
        "状态：#DS朗读状态",
    ].join("\n");
}

export { DS_TTS_VOICES, browserProfilePath, cacheDirPath, dsTtsRoot, dsTtsSpeak, dsTtsStatus, formatDsTtsConfigText, getDsTtsConfigStore, getDsTtsConfigView, getDsTtsEngine, isDsTtsVoiceId, normalizeConfigPatch, patchDsTtsConfig, resetDsTtsEngineForTests };
