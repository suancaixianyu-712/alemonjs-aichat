import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { createSpeechAudio } from './speech.js';
import { resolveSpeechRuntimeConfig } from './speech-config.js';
import { uploadMediaToR2 } from '../s3.js';

const CONNECTION_ERROR_PATTERN = /connection error|fetch failed|socket hang up|timed? ?out|ECONN(?:REFUSED|RESET|ABORTED)|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPROTO|EPIPE|UND_ERR|CONNECT_TIMEOUT/i;
const GENERIC_CAUSE_PATTERN = /^(connection error|request timed out)\.?$/i;
/**
 * openai v6 的 APIConnectionError / APIConnectionTimeoutError 不会设置 error.name，
 * 消息也只有一个笼统的 Connection error.，真实原因（DNS、拒绝连接、代理不可用等）藏在 cause 链里。
 * 这里改用 instanceof 判断，并保留按错误消息匹配的兜底。
 */
const isConnectionError = (error) => error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    CONNECTION_ERROR_PATTERN.test(String(error?.message || ""));
/** 展开 error.cause 链，取出最具体的失败原因，例如 fetch failed / connect ECONNREFUSED 127.0.0.1:7890。 */
const extractErrorCause = (error) => {
    const parts = [];
    const seen = new Set();
    let current = error;
    for (let depth = 0; current && depth < 6 && !seen.has(current); depth += 1) {
        seen.add(current);
        const detail = [current.code, current.message]
            .filter((item) => typeof item === "string" && item.trim())
            .join(" ");
        if (detail && !GENERIC_CAUSE_PATTERN.test(detail) && !parts.includes(detail))
            parts.push(detail);
        current = current.cause;
    }
    return parts.join(" / ");
};
/** 模型只能看到文字结果，回传前先抹掉密钥，避免通过报错外泄。 */
const redactSecrets = (value, apiKey) => {
    const key = String(apiKey || "").trim();
    const masked = key ? value.split(key).join("******") : value;
    return masked.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-******");
};
const generateSpeech = async ({ text, model, voice, instructions, speed, }) => {
    let apiKey = "";
    let useProxy = false;
    let httpProxy = "";
    let keySource = "ai-config";
    try {
        const config = await resolveSpeechRuntimeConfig({ model, voice });
        apiKey = config.key;
        useProxy = config.useProxy;
        httpProxy = config.httpProxy || "";
        keySource = config.keySource;
        const audio = await createSpeechAudio({
            host: config.host,
            key: config.key,
            model: config.model,
            voice: config.voice,
            text,
            instructions,
            speed,
            useProxy: config.useProxy,
            httpProxy: config.httpProxy,
        });
        const directory = await mkdtemp(path.join(tmpdir(), "aichat-speech-"));
        const file = path.join(directory, "speech.mp3");
        try {
            await writeFile(file, audio);
            const url = await uploadMediaToR2(file);
            return { ok: true, type: "audio", url, model: config.model, voice: config.voice };
        }
        finally {
            await unlink(file).catch(() => undefined);
            await rmdir(directory).catch(() => undefined);
        }
    }
    catch (error) {
        // 完整错误只写日志；回传给模型的内容需要脱敏。
        console.error("语音合成失败：", error);
        const status = Number(error?.status || 0);
        const cause = redactSecrets(extractErrorCause(error), apiKey).trim().slice(0, 200);
        // 已开启代理却没配置全局 httpProxy 时，SDK 会静默退回直连，是连接失败最常见的诱因。
        const proxyHint = useProxy && !httpProxy.trim() ? "（已开启代理但未配置全局 httpProxy，当前为直连）" : "";
        const authHint = keySource === "env"
            ? "请检查环境变量 OPENAI_TTS_API_KEY（及可选 OPENAI_TTS_BASE_URL）。"
            : "请检查所选 AI 配置的密钥。";
        const errorMessage = status === 401 ? `语音接口认证失败，${authHint}`
            : status === 403 ? "语音接口拒绝访问（可能是密钥权限、模型未开通或地区限制）。"
                : status === 404 ? "语音模型或 /audio/speech 接口不存在，请检查模型 ID 与接口地址。"
                    : status === 429 ? "语音接口额度不足或请求过于频繁，请稍后重试。"
                        : status ? "语音接口调用失败（HTTP " + status + "），请检查模型、音色和接口权限。"
                            : isConnectionError(error)
                                ? "语音接口连接失败或超时" + proxyHint + "，请检查网络、接口地址和代理配置。" + (cause ? "原因：" + cause : "")
                                : error instanceof Error
                                    ? "语音合成失败：" + error.message + (cause && cause !== error.message ? "（原因：" + cause + "）" : "")
                                    : "语音合成失败，请检查配置后重试。";
        return { ok: false, error: errorMessage };
    }
};

export { generateSpeech };
