import { redis } from './redis.js';

const systemPrompt = ``;
const defaultAIConfig = {
    host: "",
    key: "",
    model: "",
    temperature: 0.7,
    max_tokens: 150,
    systemPrompt: systemPrompt,
};
const getAIConfig = async (guid) => {
    let id = guid ?? "global";
    console.log("获取", guid);
    const userConfigStr = await redis.get(`ai:config:${id}`);
    if (userConfigStr) {
        const userConfig = JSON.parse(userConfigStr);
        return userConfig;
    }
    redis.set(`ai:config:${id}`, JSON.stringify(defaultAIConfig));
    return defaultAIConfig;
};
const getAIList = async () => {
    const keys = await redis.keys("ai:list:*");
    return keys.map((key) => key.replace("ai:list:", ""));
};
const addAI = async (guid, name, host, key, model) => {
    const defaultConfig = await getAIConfig();
    defaultConfig.host = host;
    defaultConfig.key = key;
    defaultConfig.model = model;
    await redis.set(`ai:list:${name}`, JSON.stringify(defaultConfig));
    await switchAI(guid, name);
};
const switchAI = async (guid, name) => {
    const aiConfigStr = await redis.get(`ai:list:${name}`);
    if (!aiConfigStr) {
        console.log("切换失败, 无此模型");
        return null;
    }
    const aiConfig = JSON.parse(aiConfigStr);
    await redis.set(`ai:config:${guid}`, aiConfigStr);
    return aiConfig;
};
const getPromptList = async () => {
    const keys = await redis.keys("ai:prompt:*");
    return keys.map((key) => key.replace("ai:prompt:", ""));
};
const addPrompt = async (name, content) => {
    return await redis.set(`ai:prompt:${name}`, content);
};
const deletePrompt = async (name) => {
    return await redis.del(`ai:prompt:${name}`);
};
const switchPrompt = async (guid, name) => {
    if (name === "") {
        const config = await getAIConfig(guid);
        config.systemPrompt = "";
        await redis.set(`ai:config:${guid}`, JSON.stringify(config));
        return systemPrompt;
    }
    const prompt = await redis.get(`ai:prompt:${name}`);
    if (!prompt) {
        console.log("切换提示词失败, 无此提示词");
        return null;
    }
    const config = await getAIConfig(guid);
    config.systemPrompt = prompt;
    await redis.set(`ai:config:${guid}`, JSON.stringify(config));
    return prompt;
};
const getAIChatHistory = async (guid) => {
    const historyStr = await redis.get(`ai:history:${guid}`);
    if (historyStr) {
        return JSON.parse(historyStr);
    }
    return [];
};
const addAIChatHistory = async (guid, role, content) => {
    const history = await getAIChatHistory(guid);
    // 处理messages, 不要超过15条,超过就删除最早的
    while (history.length >= 20) {
        history.shift();
    }
    history.push({ role, content });
    await redis.set(`ai:history:${guid}`, JSON.stringify(history));
    return history;
};
const clearAIChatHistory = async (guid) => {
    return await redis.del(`ai:history:${guid}`);
};
/**
 *  获取好感度等级
 * @param userKey 用户标识
 * @returns
 */
const getAffectionLevel = async (userKey) => {
    const levelStr = await redis.get(`ai:affection:${userKey}`);
    if (levelStr) {
        return parseInt(levelStr, 10);
    }
    return 0;
};
const getAffectionLevelAll = async (guid) => {
    const keys = await redis.keys(`ai:affection:${guid}:*`);
    const levels = {};
    for (const key of keys) {
        const levelStr = await redis.get(key);
        if (levelStr) {
            const userKey = key.replace(`ai:affection:${guid}:`, "");
            levels[userKey] = parseInt(levelStr, 10);
        }
    }
    return levels;
};
/**
 * 设置好感度等级
 * @param userKey 用户标识
 * @param level 好感度等级
 * @returns
 */
const setAffectionLevel = async (userKey, level) => {
    return await redis.set(`ai:affection:${userKey}`, level.toString());
};
/**
 *  增加好感度等级
 * @param userKey 用户标识
 * @param increment  增加的等级
 * @returns
 */
const incrementAffectionLevel = async (userKey, increment) => {
    const currentLevel = await getAffectionLevel(userKey);
    const newLevel = currentLevel + increment;
    await setAffectionLevel(userKey, newLevel);
    return newLevel;
};
/** * 重置好感度等级
 * @param userKey 用户标识
 * @returns
 */
const resetAffectionLevel = async (userKey) => {
    return await redis.del(`ai:affection:${userKey}`);
};
/** 重置所有用户好感度等级
 * @param guid 频道标识
 * @returns
 */
const resetAllAffectionLevels = async () => {
    const keys = await redis.keys(`ai:affection:*`);
    for (const key of keys) {
        await redis.del(key);
    }
};
const getBotID = async () => {
    const botid = await redis.get("bot:id");
    return String(botid) || "794161769";
};
const setBotID = async (id) => {
    return await redis.set("bot:id", id);
};

export { addAI, addAIChatHistory, addPrompt, clearAIChatHistory, defaultAIConfig, deletePrompt, getAIChatHistory, getAIConfig, getAIList, getAffectionLevel, getAffectionLevelAll, getBotID, getPromptList, incrementAffectionLevel, resetAffectionLevel, resetAllAffectionLevels, setAffectionLevel, setBotID, switchAI, switchPrompt, systemPrompt };
