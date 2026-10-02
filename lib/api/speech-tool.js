import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSpeechAudio } from './speech.js';
import { resolveSpeechConfig } from './speech-config.js';
import { uploadMediaToR2 } from '../s3.js';

const generateSpeech = async ({ text, model, instructions }) => {
    try {
        const config = await resolveSpeechConfig(model);
        const audio = await createSpeechAudio({ ...config, text, instructions });
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
        // SDK 错误可能附带请求信息，不将原始错误或密钥返回给模型。
        const status = Number(error?.status || 0);
        const errorMessage = status === 401 ? "语音接口认证失败，请检查所选 AI 配置的密钥。"
            : status === 403 ? "当前 AI 配置没有语音模型的访问权限。"
                : status === 404 ? "语音模型或 /audio/speech 接口不存在，请检查模型 ID 与接口地址。"
                    : status === 429 ? "语音接口额度不足或请求过于频繁，请稍后重试。"
                        : status ? `语音接口调用失败（HTTP ${status}），请检查模型、音色和接口权限。`
                            : error?.name === "APIConnectionError" || error?.name === "APIConnectionTimeoutError"
                                ? "语音接口连接失败或超时，请检查网络和代理配置。"
                                : error instanceof Error ? error.message : "语音合成失败，请检查配置后重试。";
        return { ok: false, error: errorMessage };
    }
};

export { generateSpeech };
