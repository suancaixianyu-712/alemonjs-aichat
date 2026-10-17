import OpenAi from 'openai';
import { Text, Audio } from 'alemonjs';
import { getOpenAIProxyFetch } from './openaiProxy.js';

const DEFAULT_SPEECH_VOICE = "alloy";
/**
 * OpenAI SDK `audio.speech` 支持的一键 TTS 模型（openai@6 SpeechModel）。
 * 不含 Realtime（gpt-4o-*-realtime-*）：那是 WebSocket 双工会话，不能直接产出
 * 可上传到 QQ/群聊的整段 mp3，故 GenerateSpeech 不接入。
 * 最自然的一键朗读：gpt-4o-mini-tts（支持 instructions）。
 */
const OPENAI_SPEECH_MODELS = [
    "tts-1",
    "tts-1-hd",
    "gpt-4o-mini-tts",
    "gpt-4o-mini-tts-2025-12-15",
];
const DEFAULT_OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
const listOpenAISpeechModelsText = () => OPENAI_SPEECH_MODELS.join(" | ");
const isOpenAISpeechModel = (value) => typeof value === "string" &&
    OPENAI_SPEECH_MODELS.includes(value.trim());
const validateSpeechModel = (model) => {
    const id = String(model || "").trim();
    if (!isOpenAISpeechModel(id)) {
        throw new Error(`不支持的语音模型「${id || "(空)"}」。可用：${listOpenAISpeechModelsText()}`);
    }
    return id;
};
/** gpt-4o-mini-tts* 支持 instructions；tts-1 / tts-1-hd 不支持 */
const speechModelSupportsInstructions = (model) => !/^tts-1(?:-hd)?$/.test(String(model || "").trim());
const VOICES = [
    "alloy", "ash", "ballad", "coral", "echo", "fable", "nova",
    "onyx", "sage", "shimmer", "verse", "marin", "cedar",
];
const LEGACY_VOICES = [
    "alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer",
];
const getSpeechVoices = (model) => [...(/^tts-1(?:-hd)?$/.test(model) ? LEGACY_VOICES : VOICES)];
const validateSpeechVoice = (model, voice) => {
    if (!getSpeechVoices(model).includes(voice)) {
        throw new Error(`模型 ${model} 不支持音色 ${voice}。可用音色：${getSpeechVoices(model).join("、")}`);
    }
};
const createSpeechAudio = async (options) => {
    const input = typeof options.text === "string" ? options.text.trim() : "";
    if (!input)
        throw new Error("语音合成内容不能为空。");
    if (Array.from(input).length > 4096) {
        throw new Error("语音合成内容不能超过 4096 个字符，请分段生成。");
    }
    const model = validateSpeechModel(options.model);
    validateSpeechVoice(model, options.voice);
    const client = new OpenAi({
        baseURL: options.host,
        apiKey: options.key,
        timeout: 120000,
        maxRetries: 0,
        fetch: getOpenAIProxyFetch(options.httpProxy, options.useProxy === true),
    });
    const request = {
        model,
        voice: options.voice,
        input,
        response_format: "mp3",
    };
    if (typeof options.instructions === "string" &&
        options.instructions.trim() &&
        speechModelSupportsInstructions(model)) {
        request.instructions = options.instructions.trim();
    }
    if (typeof options.speed === "number" && Number.isFinite(options.speed)) {
        if (options.speed < 0.25 || options.speed > 4) {
            throw new Error("语速 speed 需在 0.25 到 4.0 之间。");
        }
        request.speed = options.speed;
    }
    const response = await client.audio.speech.create(request);
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length)
        throw new Error("语音接口返回了空音频。");
    return audio;
};
const isSpeechToolResult = (value) => value?.ok === true && value?.type === "audio" &&
    typeof value.url === "string" && /^https?:\/\//.test(value.url);
const sendSpeechToolResult = async (message, result) => {
    if (!isSpeechToolResult(result))
        return;
    await message.send(format(Text("AI 合成语音"), Audio(result.url)));
};

export { DEFAULT_OPENAI_SPEECH_MODEL, DEFAULT_SPEECH_VOICE, OPENAI_SPEECH_MODELS, createSpeechAudio, getSpeechVoices, isOpenAISpeechModel, isSpeechToolResult, listOpenAISpeechModelsText, sendSpeechToolResult, speechModelSupportsInstructions, validateSpeechModel, validateSpeechVoice };
