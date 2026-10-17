import redisClient from '../config.js';
import { getAiChatConfigValue } from '../config/app.js';
import { validateSpeechVoice, DEFAULT_SPEECH_VOICE, validateSpeechModel, DEFAULT_OPENAI_SPEECH_MODEL } from './speech.js';

const MODELS_KEY = "ai:speech:models";
const CURRENT_KEY = "ai:speech:current";
const parseConfig = (value) => {
    if (!value)
        return null;
    try {
        const config = JSON.parse(value);
        if ([config.model, config.aiName, config.voice].every((item) => typeof item === "string" && item.trim()))
            return config;
    }
    catch { }
    return null;
};
const getSpeechModel = async (model) => {
    const id = model || await redisClient.redis.get(CURRENT_KEY);
    return id ? parseConfig(await redisClient.redis.hget(MODELS_KEY, id)) : null;
};
const listSpeechModels = async () => {
    const values = await redisClient.redis.hvals(MODELS_KEY);
    const models = values.map(parseConfig).filter((item) => Boolean(item));
    return {
        current: await redisClient.redis.get(CURRENT_KEY),
        models: models.sort((a, b) => a.model.localeCompare(b.model)),
    };
};
const addSpeechModel = async (model, aiName) => {
    if (!model.trim() || /\s/.test(model))
        throw new Error("模型 ID 不能为空或包含空白。");
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
const switchSpeechModel = async (model) => {
    const config = await getSpeechModel(model);
    if (!config)
        throw new Error(`未找到语音模型 ${model}，请先使用 #语音列表 查看已添加的模型。`);
    await redisClient.redis.set(CURRENT_KEY, model);
    return config;
};
const setSpeechVoice = async (voice) => {
    const config = await getSpeechModel();
    if (!config)
        throw new Error("尚未添加语音配置，请先使用 #添加语音配置 <模型id>。");
    validateSpeechVoice(config.model, voice);
    config.voice = voice;
    await redisClient.redis.hset(MODELS_KEY, config.model, JSON.stringify(config));
    return config;
};
const resolveSpeechConfig = async (model) => {
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
const OPENAI_TTS_API_KEY_ENV = "OPENAI_TTS_API_KEY";
const OPENAI_TTS_BASE_URL_ENV = "OPENAI_TTS_BASE_URL";
const DEFAULT_OPENAI_TTS_HOST = "https://api.openai.com/v1";
/** @deprecated 使用 DEFAULT_OPENAI_SPEECH_MODEL；保留别名兼容 */
const DEFAULT_OPENAI_TTS_MODEL = DEFAULT_OPENAI_SPEECH_MODEL;
const getOpenAiTtsEnvCredentials = () => {
    const key = String(process.env[OPENAI_TTS_API_KEY_ENV] || "").trim();
    if (!key)
        return null;
    const host = String(process.env[OPENAI_TTS_BASE_URL_ENV] || DEFAULT_OPENAI_TTS_HOST)
        .trim()
        .replace(/\/+$/, "") || DEFAULT_OPENAI_TTS_HOST;
    return { key, host };
};
/**
 * 解析 GenerateSpeech 运行时配置。
 * 密钥优先读环境变量 OPENAI_TTS_API_KEY（可选 OPENAI_TTS_BASE_URL），
 * 否则回退到 Redis 语音模型 + AI 列表配置（#添加语音配置）。
 */
const resolveSpeechRuntimeConfig = async (options) => {
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

export { DEFAULT_OPENAI_TTS_HOST, DEFAULT_OPENAI_TTS_MODEL, OPENAI_TTS_API_KEY_ENV, OPENAI_TTS_BASE_URL_ENV, addSpeechModel, getOpenAiTtsEnvCredentials, getSpeechModel, listSpeechModels, resolveSpeechConfig, resolveSpeechRuntimeConfig, setSpeechVoice, switchSpeechModel };
