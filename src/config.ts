import { redis } from "@src/redis";

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

  console.log("获取", guid);

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
    return null;
  }
  const aiConfig = JSON.parse(aiConfigStr);
  await redis.set(`ai:config:${guid}`, aiConfigStr);
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

export const addAIChatHistory = async (
  guid: string,
  role: "user" | "assistant" | "system",
  content: string,
) => {
  const history = await getAIChatHistory(guid);

  // 处理messages, 不要超过15条,超过就删除最早的
  while (history.length >= 20) {
    history.shift();
  }

  history.push({ role, content });
  await redis.set(`ai:history:${guid}`, JSON.stringify(history));
  return history;
};

export const clearAIChatHistory = async (guid: string) => {
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

export const getBotID = async () => {
  const botid = await redis.get("bot:id");
  return String(botid) || "794161769";
};

export const setBotID = async (id: string) => {
  return await redis.set("bot:id", id);
};
