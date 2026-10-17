import redisClient from "@src/config";
import { getAiChatConfigValue } from "@src/config/app";
import {
  DEFAULT_SPEECH_VOICE,
  DEFAULT_OPENAI_SPEECH_MODEL,
  validateSpeechModel,
  validateSpeechVoice,
} from "./speech";

const MODELS_KEY = "ai:speech:models";
const CURRENT_KEY = "ai:speech:current";

export type SpeechModelConfig = { model: string; aiName: string; voice: string };

const parseConfig = (value: string | null): SpeechModelConfig | null => {
  if (!value) return null;
  try {
    const config = JSON.parse(value);
    if ([config.model, config.aiName, config.voice].every(
      (item) => typeof item === "string" && item.trim(),
    )) return config;
  } catch {}
  return null;
};

export const getSpeechModel = async (model?: string): Promise<SpeechModelConfig | null> => {
  const id = model || await redisClient.redis.get(CURRENT_KEY);
  return id ? parseConfig(await redisClient.redis.hget(MODELS_KEY, id)) : null;
};

export const listSpeechModels = async () => {
  const values = await redisClient.redis.hvals(MODELS_KEY);
  const models = values.map(parseConfig).filter((item): item is SpeechModelConfig => Boolean(item));
  return {
    current: await redisClient.redis.get(CURRENT_KEY),
    models: models.sort((a, b) => a.model.localeCompare(b.model)),
  };
};

export const addSpeechModel = async (model: string, aiName: string) => {
  if (!model.trim() || /\s/.test(model)) throw new Error("模型 ID 不能为空或包含空白。");
  const ai = await redisClient.getAIListConfig(aiName);
  if (!ai?.host?.trim() || !ai.key?.trim()) {
    throw new Error(`AI 配置「${aiName}」不存在或接口地址、密钥不完整，请重新选择。`);
  }
  const oldConfig = await getSpeechModel(model);
  const config = { model, aiName, voice: oldConfig?.voice || DEFAULT_SPEECH_VOICE };
  await redisClient.redis.hset(MODELS_KEY, model, JSON.stringify(config));
  await redisClient.redis.set(CURRENT_KEY, model);
  return config;
};

export const switchSpeechModel = async (model: string) => {
  const config = await getSpeechModel(model);
  if (!config) throw new Error(`未找到语音模型 ${model}，请先使用 #语音列表 查看已添加的模型。`);
  await redisClient.redis.set(CURRENT_KEY, model);
  return config;
};

export const setSpeechVoice = async (voice: string) => {
  const config = await getSpeechModel();
  if (!config) throw new Error("尚未添加语音配置，请先使用 #添加语音配置 <模型id>。");
  validateSpeechVoice(config.model, voice);
  config.voice = voice;
  await redisClient.redis.hset(MODELS_KEY, config.model, JSON.stringify(config));
  return config;
};

export const resolveSpeechConfig = async (model?: string) => {
  const config = await getSpeechModel(model);
  if (!config) {
    throw new Error(model ? `未找到语音模型 ${model}。` : "尚未添加语音配置，请先使用 #添加语音配置 <模型id>。");
  }
  const ai = await redisClient.getAIListConfig(config.aiName);
  if (!ai?.host?.trim() || !ai.key?.trim()) {
    throw new Error(`语音模型引用的 AI 配置「${config.aiName}」不存在或不完整，请重新添加语音配置。`);
  }
  return {
    ...config,
    host: ai.host.trim(),
    key: ai.key.trim(),
    useProxy: await redisClient.isToolProxyEnabled(ai),
    httpProxy: getAiChatConfigValue().httpProxy,
  };
};

/** OpenAI TTS 专用密钥（优先于 Redis AI 配置）。勿写入源码；本地可 export OPENAI_TTS_API_KEY。 */
export const OPENAI_TTS_API_KEY_ENV = "OPENAI_TTS_API_KEY";
export const OPENAI_TTS_BASE_URL_ENV = "OPENAI_TTS_BASE_URL";
export const DEFAULT_OPENAI_TTS_HOST = "https://api.openai.com/v1";
/** @deprecated 使用 DEFAULT_OPENAI_SPEECH_MODEL；保留别名兼容 */
export const DEFAULT_OPENAI_TTS_MODEL = DEFAULT_OPENAI_SPEECH_MODEL;

export const getOpenAiTtsEnvCredentials = (): { key: string; host: string } | null => {
  const key = String(process.env[OPENAI_TTS_API_KEY_ENV] || "").trim();
  if (!key) return null;
  const host =
    String(process.env[OPENAI_TTS_BASE_URL_ENV] || DEFAULT_OPENAI_TTS_HOST)
      .trim()
      .replace(/\/+$/, "") || DEFAULT_OPENAI_TTS_HOST;
  return { key, host };
};

export type SpeechRuntimeConfig = {
  model: string;
  voice: string;
  host: string;
  key: string;
  useProxy: boolean;
  httpProxy?: string;
  aiName?: string;
  /** env = OPENAI_TTS_API_KEY；ai-config = #添加语音配置 关联的 AI 密钥 */
  keySource: "env" | "ai-config";
};

/**
 * 解析 GenerateSpeech 运行时配置。
 * 密钥优先读环境变量 OPENAI_TTS_API_KEY（可选 OPENAI_TTS_BASE_URL），
 * 否则回退到 Redis 语音模型 + AI 列表配置（#添加语音配置）。
 */
export const resolveSpeechRuntimeConfig = async (options?: {
  model?: string;
  voice?: string;
}): Promise<SpeechRuntimeConfig> => {
  const requestedModel = String(options?.model || "").trim();
  const requestedVoice = String(options?.voice || "").trim();
  const env = getOpenAiTtsEnvCredentials();

  if (env) {
    let model = requestedModel;
    let voice = requestedVoice;
    if (!model || !voice) {
      const stored = await getSpeechModel(requestedModel || undefined);
      if (stored) {
        model = model || stored.model;
        voice = voice || stored.voice;
      }
    }
    model = validateSpeechModel(model || DEFAULT_OPENAI_SPEECH_MODEL);
    voice = voice || DEFAULT_SPEECH_VOICE;
    validateSpeechVoice(model, voice);
    const toolProxyOn = (await redisClient.getToolProxySwitch()) === "1";
    return {
      model,
      voice,
      host: env.host,
      key: env.key,
      useProxy: toolProxyOn,
      httpProxy: getAiChatConfigValue().httpProxy,
      aiName: "(OPENAI_TTS_API_KEY)",
      keySource: "env",
    };
  }

  const config = await resolveSpeechConfig(requestedModel || undefined);
  const model = validateSpeechModel(config.model);
  const voice = requestedVoice || config.voice;
  validateSpeechVoice(model, voice);
  return {
    ...config,
    model,
    voice,
    keySource: "ai-config",
  };
};
