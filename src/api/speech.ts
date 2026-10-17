import OpenAI from "openai";
import type { SpeechCreateParams } from "openai/resources/audio/speech";
import { Audio, Text } from "alemonjs";
import { getOpenAIProxyFetch } from "./openaiProxy";

export const DEFAULT_SPEECH_VOICE = "alloy";

/**
 * OpenAI SDK `audio.speech` 支持的一键 TTS 模型（openai@6 SpeechModel）。
 * 不含 Realtime（gpt-4o-*-realtime-*）：那是 WebSocket 双工会话，不能直接产出
 * 可上传到 QQ/群聊的整段 mp3，故 GenerateSpeech 不接入。
 * 最自然的一键朗读：gpt-4o-mini-tts（支持 instructions）。
 */
export const OPENAI_SPEECH_MODELS = [
  "tts-1",
  "tts-1-hd",
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
] as const;

export type OpenAISpeechModel = (typeof OPENAI_SPEECH_MODELS)[number];

export const DEFAULT_OPENAI_SPEECH_MODEL: OpenAISpeechModel = "gpt-4o-mini-tts";

export const listOpenAISpeechModelsText = (): string =>
  OPENAI_SPEECH_MODELS.join(" | ");

export const isOpenAISpeechModel = (value: unknown): value is OpenAISpeechModel =>
  typeof value === "string" &&
  (OPENAI_SPEECH_MODELS as readonly string[]).includes(value.trim());

export const validateSpeechModel = (model: string): OpenAISpeechModel => {
  const id = String(model || "").trim();
  if (!isOpenAISpeechModel(id)) {
    throw new Error(
      `不支持的语音模型「${id || "(空)"}」。可用：${listOpenAISpeechModelsText()}`,
    );
  }
  return id;
};

/** gpt-4o-mini-tts* 支持 instructions；tts-1 / tts-1-hd 不支持 */
export const speechModelSupportsInstructions = (model: string): boolean =>
  !/^tts-1(?:-hd)?$/.test(String(model || "").trim());

const VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova",
  "onyx", "sage", "shimmer", "verse", "marin", "cedar",
];
const LEGACY_VOICES = [
  "alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer",
];

export const getSpeechVoices = (model: string): string[] =>
  [...(/^tts-1(?:-hd)?$/.test(model) ? LEGACY_VOICES : VOICES)];

export const validateSpeechVoice = (model: string, voice: string) => {
  if (!getSpeechVoices(model).includes(voice)) {
    throw new Error(`模型 ${model} 不支持音色 ${voice}。可用音色：${getSpeechVoices(model).join("、")}`);
  }
};

export const createSpeechAudio = async (options: {
  host: string;
  key: string;
  model: string;
  voice: string;
  text: string;
  instructions?: string;
  /** 0.25–4.0，OpenAI audio.speech 支持 */
  speed?: number;
  httpProxy?: string;
  useProxy?: boolean;
}): Promise<Buffer> => {
  const input = typeof options.text === "string" ? options.text.trim() : "";
  if (!input) throw new Error("语音合成内容不能为空。");
  if (Array.from(input).length > 4096) {
    throw new Error("语音合成内容不能超过 4096 个字符，请分段生成。");
  }
  const model = validateSpeechModel(options.model);
  validateSpeechVoice(model, options.voice);
  const client = new OpenAI({
    baseURL: options.host,
    apiKey: options.key,
    timeout: 120000,
    maxRetries: 0,
    fetch: getOpenAIProxyFetch(options.httpProxy, options.useProxy === true),
  });
  const request: SpeechCreateParams = {
    model,
    voice: options.voice,
    input,
    response_format: "mp3",
  };
  if (
    typeof options.instructions === "string" &&
    options.instructions.trim() &&
    speechModelSupportsInstructions(model)
  ) {
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
  if (!audio.length) throw new Error("语音接口返回了空音频。");
  return audio;
};

export type SpeechToolResult = {
  ok: true;
  type: "audio";
  url: string;
  model: string;
  voice: string;
};

export const isSpeechToolResult = (value: any): value is SpeechToolResult =>
  value?.ok === true && value?.type === "audio" &&
  typeof value.url === "string" && /^https?:\/\//.test(value.url);

export const sendSpeechToolResult = async (message: any, result: unknown) => {
  if (!isSpeechToolResult(result)) return;
  await message.send(format(Text("AI 合成语音"), Audio(result.url)));
};
