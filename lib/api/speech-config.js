import redisClient from '../config.js';
import { getAiChatConfigValue } from '../config/app.js';
import { validateSpeechVoice, DEFAULT_SPEECH_VOICE } from './speech.js';

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

export { addSpeechModel, getSpeechModel, listSpeechModels, resolveSpeechConfig, setSpeechVoice, switchSpeechModel };
