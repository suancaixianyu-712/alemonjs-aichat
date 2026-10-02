import OpenAI from "openai";
import type { SpeechCreateParams } from "openai/resources/audio/speech";
import { Audio, Text } from "alemonjs";
import { getOpenAIProxyFetch } from "./openaiProxy";

export const DEFAULT_SPEECH_VOICE = "alloy";
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
  httpProxy?: string;
  useProxy?: boolean;
}): Promise<Buffer> => {
  const input = typeof options.text === "string" ? options.text.trim() : "";
  if (!input) throw new Error("语音合成内容不能为空。");
  if (Array.from(input).length > 4096) {
    throw new Error("语音合成内容不能超过 4096 个字符，请分段生成。");
  }
  validateSpeechVoice(options.model, options.voice);
  const client = new OpenAI({
    baseURL: options.host,
    apiKey: options.key,
    timeout: 120000,
    maxRetries: 0,
    fetch: getOpenAIProxyFetch(options.httpProxy, options.useProxy === true),
  });
  const request: SpeechCreateParams = {
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
