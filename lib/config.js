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
        // 清空当前配置
        await redis.set(`ai:config:${guid}`, JSON.stringify(defaultAIConfig));
        return null;
    }
    const aiConfig = JSON.parse(aiConfigStr);
    // 保留当前系统提示词
    const currentConfig = await getAIConfig(guid);
    aiConfig.systemPrompt = currentConfig.systemPrompt;
    await redis.set(`ai:config:${guid}`, JSON.stringify(aiConfig));
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
const addAIChatHistory = async (guid, data) => {
    const history = await getAIChatHistory(guid);
    // 处理messages, 不要超过15条,超过就删除最早的
    while (history.length >= 20) {
        history.shift();
    }
    history.push(data);
    await redis.set(`ai:history:${guid}`, JSON.stringify(history));
    return history;
};
const clearAIChatHistory = async (guid) => {
    if (!guid) {
        const keys = await redis.keys(`ai:history:*`);
        for (const key of keys) {
            await redis.del(key);
        }
        return;
    }
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
const setBotID = async (id) => {
    return await redis.set("bot:id", id);
};
const deleteAI = async (name) => {
    const aiConfigStr = await redis.get(`ai:list:${name}`);
    if (!aiConfigStr) {
        console.log("删除失败, 无此模型");
        return false;
    }
    await redis.del(`ai:list:${name}`);
    return true;
};
/**
 *  设置好感度开关
 */
const affectionSwitch = async (guid, enable) => {
    return await redis.set(`ai:affection:switch:${guid}`, enable ? "1" : "0");
};
const tools = [
    {
        type: "function",
        function: {
            name: "StableDiffusionGenerateImage",
            description: "使用 Stable Diffusion 模型生成图像",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "正向提示词（prompt），越详细越好。建议包含：主体、动作、服装、场景、风格、光线、画质修饰词。\n推荐全英文且使用标签描述,当遇到动漫人物时,使用ta的英文名可以自动触发lora,不用额外lora标签\n括号的使用:[增强效果],(弱化效果), 示例：'[artist:ciloranko],artist:kazutake_hazano,[artist:kedama milk]，smile, short_hair, open_mouth, bangs, multiple_girls, skirt, black_hair, hair_ornament, red_eyes, long_sleeves, 2girls, sitting, school_uniform, :d, grey_hair, multicolored_hair, pleated_skirt, shoes, serafuku, choker, socks, sailor_collar, neckerchief, orange_eyes, petals, siblings, black_choker, brown_footwear, blue sky， pointing, loafers, red_neckerchief, bench, falling_petals'",
                    },
                    bad_prompt: {
                        type: "string",
                        description: "反向提示词（negative prompt），用于排除不想要的元素。\n示例：'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, deformed'",
                        default: "(easynegative:1.1), (verybadimagenegative_v1.3:1), (low quality:1.2), (worst quality:1.2)",
                    },
                    direction: {
                        type: "string",
                        description: "图片方向, 横向: landscape, 纵向: portrait, 方形: square",
                        enum: ["landscape", "portrait", "square"],
                        default: "portrait",
                    },
                },
                required: ["prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "StableDiffusionImageToPrompt",
            description: "使用 Stable Diffusion 将图片转换为提示词",
            parameters: {
                type: "object",
                properties: {
                    image_url: {
                        type: "string",
                        description: "图片的URL地址，必须是你所收到的图片地址",
                    },
                },
                required: ["image_url"],
            },
        },
    },
];

export { addAI, addAIChatHistory, addPrompt, affectionSwitch, clearAIChatHistory, defaultAIConfig, deleteAI, deletePrompt, getAIChatHistory, getAIConfig, getAIList, getAffectionLevel, getAffectionLevelAll, getPromptList, incrementAffectionLevel, resetAffectionLevel, resetAllAffectionLevels, setAffectionLevel, setBotID, switchAI, switchPrompt, systemPrompt, tools };
