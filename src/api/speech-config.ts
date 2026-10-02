import redisClient from "@src/config";
import { getAiChatConfigValue } from "@src/config/app";
import { DEFAULT_SPEECH_VOICE, validateSpeechVoice } from "./speech";

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
    useProxy: redisClient.isAIProxyEnabled(ai),
    httpProxy: getAiChatConfigValue().httpProxy,
  };
};
