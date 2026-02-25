import { redis } from "@src/redis";
import { ChatCompletionTool } from "openai/resources";

export const systemPrompt = ``;

export const defaultAIConfig = {
  host: "",
  key: "",
  model: "",
  temperature: 0.7,
  max_tokens: 150,
  systemPrompt: systemPrompt,
};

export const getAIConfig = async (
  guid?: string,
): Promise<{
  host: string;
  key: string;
  model: string;
  temperature: number;
  max_tokens: number;
  systemPrompt: string;
}> => {
  let id = guid ?? "global";

  const userConfigStr = await redis.get(`ai:config:${id}`);
  if (userConfigStr) {
    const userConfig = JSON.parse(userConfigStr);
    return userConfig;
  }
  redis.set(`ai:config:${id}`, JSON.stringify(defaultAIConfig));
  return defaultAIConfig;
};

export const getAIList = async () => {
  const keys = await redis.keys("ai:list:*");
  return keys.map((key) => key.replace("ai:list:", ""));
};

export const addAI = async (
  guid: string,
  name: string,
  host: string,
  key: string,
  model: string,
) => {
  const defaultConfig = await getAIConfig();
  defaultConfig.host = host;
  defaultConfig.key = key;
  defaultConfig.model = model;
  await redis.set(`ai:list:${name}`, JSON.stringify(defaultConfig));
  await switchAI(guid, name);
};

export const switchAI = async (guid: string, name: string) => {
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

export const getPromptList = async () => {
  const keys = await redis.keys("ai:prompt:*");
  return keys.map((key) => key.replace("ai:prompt:", ""));
};

export const addPrompt = async (name: string, content: string) => {
  return await redis.set(`ai:prompt:${name}`, content);
};

export const deletePrompt = async (name: string) => {
  return await redis.del(`ai:prompt:${name}`);
};

export const switchPrompt = async (guid: string, name: string) => {
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

export const getAIChatHistory = async (guid: string) => {
  const historyStr = await redis.get(`ai:history:${guid}`);
  if (historyStr) {
    return JSON.parse(historyStr);
  }
  return [];
};

export const addAIChatHistory = async (guid: string, data: any) => {
  const history = await getAIChatHistory(guid);

  // 处理messages, 不要超过15条,超过就删除最早的
  while (history.length >= 20) {
    history.shift();
  }

  history.push(data);
  await redis.set(`ai:history:${guid}`, JSON.stringify(history));
  return history;
};

export const clearAIChatHistory = async (guid?: string) => {
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
export const getAffectionLevel = async (userKey: string) => {
  const levelStr = await redis.get(`ai:affection:${userKey}`);
  if (levelStr) {
    return parseInt(levelStr, 10);
  }
  return 0;
};

export const getAffectionLevelAll = async (guid: string) => {
  const keys = await redis.keys(`ai:affection:${guid}:*`);
  const levels: Record<string, number> = {};
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
export const setAffectionLevel = async (userKey: string, level: number) => {
  return await redis.set(`ai:affection:${userKey}`, level.toString());
};

/**
 *  增加好感度等级
 * @param userKey 用户标识
 * @param increment  增加的等级
 * @returns
 */
export const incrementAffectionLevel = async (
  userKey: string,
  increment: number,
) => {
  const currentLevel = await getAffectionLevel(userKey);
  const newLevel = currentLevel + increment;
  await setAffectionLevel(userKey, newLevel);
  return newLevel;
};

/** * 重置好感度等级
 * @param userKey 用户标识
 * @returns
 */
export const resetAffectionLevel = async (userKey: string) => {
  return await redis.del(`ai:affection:${userKey}`);
};

/** 重置所有用户好感度等级
 * @param guid 频道标识
 * @returns
 */
export const resetAllAffectionLevels = async () => {
  const keys = await redis.keys(`ai:affection:*`);
  for (const key of keys) {
    await redis.del(key);
  }
};

export const setBotID = async (id: string) => {
  return await redis.set("bot:id", id);
};

export const deleteAI = async (name: string) => {
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
export const affectionSwitch = async (guid: string, enable: boolean) => {
  return await redis.set(`ai:affection:switch:${guid}`, enable ? "1" : "0");
};

export const tools: ChatCompletionTool[] = [
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
            description:
              "正向提示词（prompt），越详细越好。建议包含：主体、动作、服装、场景、风格、光线、画质修饰词。\n推荐全英文且使用标签描述,当遇到动漫人物时,使用ta的英文名可以自动触发lora,不用额外lora标签\n括号的使用:[增强效果],(弱化效果), 示例：'[artist:ciloranko],artist:kazutake_hazano,[artist:kedama milk]，smile, short_hair, open_mouth, bangs, multiple_girls, skirt, black_hair, hair_ornament, red_eyes, long_sleeves, 2girls, sitting, school_uniform, :d, grey_hair, multicolored_hair, pleated_skirt, shoes, serafuku, choker, socks, sailor_collar, neckerchief, orange_eyes, petals, siblings, black_choker, brown_footwear, blue sky， pointing, loafers, red_neckerchief, bench, falling_petals'",
          },
          bad_prompt: {
            type: "string",
            description:
              "反向提示词（negative prompt），用于排除不想要的元素。\n示例：'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, deformed'",
            default:
              "(easynegative:1.1), (verybadimagenegative_v1.3:1), (low quality:1.2), (worst quality:1.2)",
          },
          direction: {
            type: "string",
            description:
              "图片方向, 横向: landscape, 纵向: portrait, 方形: square",
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
      description:
        "使用 Stable Diffusion 将图片转换为提示词, 仅供绘图时使用, 其他场景请勿使用",
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
  {
    type: "function",
    function: {
      name: "SearchScbbsPost",
      description:
        "搜索《survivalcraft》(译名《生存战争》,也简称sc)论坛的帖子, 搜索时请尽量提供精确的关键词, 关键词最好只有一个. 在这里可以搜索到sc这个游戏相关的各种模组等资源或教程帖子和更新公告等内容, 但请注意不要搜索与游戏无关的内容, 否则可能会得到不相关的结果，若是搜索不到请减少关键词的数量或更换关键词",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "搜索关键词",
          },
        },
        required: ["keyword"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "SearchWeb",
      description:
        "使用搜索引擎搜索网页内容, 你可以使用这个工具来获取最新的资讯或数据, 但请注意不要搜索敏感或违法的内容, 否则可能会得到不相关的结果, 此外,不推荐使用该工具搜索与sc这个游戏相关的内容, 因为搜索引擎的结果可能不如专门的游戏论坛或社区来的准确和有用, 在搜索时请尽量提供精确的关键词, 关键词最好只有一个. 如果你想搜索与游戏相关的内容, 建议使用SearchScbbsPost工具来搜索survivalcraft(生存战争)论坛的帖子",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "搜索关键词",
          },
          engine: {
            type: "string",
            description: "选择搜索引擎",
            enum: ["bing", "google", "baidu"],
            default: "baidu",
          },
          cc: {
            type: "string",
            description:
              "搜索国家/地区代码, 例如搜索美国就填us, 搜索中国就填cn, 搜索日本就填jp, 这个参数会影响搜索结果的地域性",
            default: "CN",
          },
          type: {
            type: "string",
            description:
              "选择结果类型, 搜索后获取对应结果, 建议使用自然结果organic_results, 其他选项可能不存在",
            enum: ["organic_results", "related_questions", "related_searches"],
            default: "organic_results",
          },
        },
        required: ["keyword"],
      },
    },
  },
];
