import OpenAi from 'openai';
import { Text, Audio } from 'alemonjs';
import { getOpenAIProxyFetch } from './openaiProxy.js';

const DEFAULT_SPEECH_VOICE = "alloy";
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
    validateSpeechVoice(options.model, options.voice);
    const client = new OpenAi({
        baseURL: options.host,
        apiKey: options.key,
        timeout: 120000,
        maxRetries: 0,
        fetch: getOpenAIProxyFetch(options.httpProxy, options.useProxy === true),
    });
    const request = {
        model: options.model,
        voice: options.voice,
        input,
        response_format: "mp3",
    };
    if (typeof options.instructions === "string" && options.instructions.trim() && !/^tts-1(?:-hd)?$/.test(options.model)) {
        request.instructions = options.instructions.trim();
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

export { DEFAULT_SPEECH_VOICE, createSpeechAudio, getSpeechVoices, isSpeechToolResult, sendSpeechToolResult, validateSpeechVoice };
