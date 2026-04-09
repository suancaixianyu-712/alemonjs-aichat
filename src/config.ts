import Redis, { RedisOptions } from "ioredis";
import { getConfigValue } from "alemonjs";
import { AIConfig } from "./types";

class db {
  redis: Redis;
  systemPrompt = "";

  static defaultAIConfig: AIConfig = {
    host: "",
    key: "",
    model: "",
    temperature: 0.7,
    max_tokens: 150,
    systemPrompt: "",
    rapi: false,
  };

  constructor(redisConfig?: RedisOptions) {
    this.redis =
      redisConfig && Object.keys(redisConfig).length > 0
        ? new Redis(redisConfig)
        : new Redis(); // 默认配置
  }

  /** 获取提示词优化内容 */
  async getPromptOptimization(guid?: string): Promise<string | null> {
    const id = guid ?? "global";
    return (await this.redis.get(`ai:prompt_optimization:${id}`)) || "0";
  }

  /** 设置提示词优化内容 */
  async setPromptOptimization(guid: string, value: string): Promise<void> {
    await this.redis.set(`ai:prompt_optimization:${guid}`, value);
  }

  /** 获取工具开关状态 */
  async getToolSwitch(guid: string): Promise<string | null> {
    return (await this.redis.get(`ai:tool:switch:${guid}`)) || "1";
  }

  /** 设置工具开关状态 */
  async setToolSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:tool:switch:${guid}`, enable ? "1" : "0");
  }

  /** 获取复杂输出开关状态 */
  async getComplexOutput(guid: string): Promise<string | null> {
    return (await this.redis.get(`ai:complex_output:${guid}`)) || "1";
  }

  /** 设置复杂输出开关状态 */
  async setComplexOutput(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:complex_output:${guid}`, enable ? "1" : "0");
  }

  /** 获取R18模式开关状态 */
  async getR18Switch(guid: string): Promise<string | null> {
    return await this.redis.get(`ai:r18:switch:${guid}`);
  }

  /** 设置R18模式开关状态 */
  async setR18Switch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:r18:switch:${guid}`, enable ? "1" : "0");
  }

  /** 切换当前图床 */
  async switchImageBed(guid: string, bedName: string): Promise<void> {
    await this.redis.set(`ai:image_bed:${guid}`, bedName);
  }

  /** 获取当前图床 */
  async getImageBed(guid: string): Promise<string | null> {
    return await this.redis.get(`ai:image_bed:${guid}`);
  }

  /** 获取AI配置 */
  async getAIConfig(guid?: string): Promise<AIConfig> {
    const id = guid ?? "global";
    const userConfigStr = await this.redis.get(`ai:config:${id}`);
    if (userConfigStr) {
      return JSON.parse(userConfigStr) as AIConfig;
    }
    await this.setAIConfig(id, db.defaultAIConfig);
    return { ...db.defaultAIConfig };
  }

  /** 设置AI配置 */
  async setAIConfig(guid: string, config: AIConfig): Promise<void> {
    await this.redis.set(`ai:config:${guid}`, JSON.stringify(config));
  }

  /** 关闭指定聊天 */
  async closeChat(guid: string): Promise<void> {
    await this.setAIConfig(guid, db.defaultAIConfig);
    await this.clearAIChatHistory(guid);
  }

  /** 关闭所有聊天 */
  async closeAllChat(): Promise<void> {
    const keys = await this.redis.keys(`ai:config:*`);
    for (const key of keys) {
      const guid = key.replace("ai:config:", "");
      await this.setAIConfig(guid, db.defaultAIConfig);
      await this.clearAIChatHistory(guid);
    }
  }

  /** 获取AI列表 */
  async getAIList(): Promise<string[]> {
    const keys = await this.redis.keys("ai:list:*");
    return keys.map((key) => key.replace("ai:list:", ""));
  }

  /** 设置AI列表项 */
  async setAIList(name: string, config: AIConfig): Promise<void> {
    await this.redis.set(`ai:list:${name}`, JSON.stringify(config));
  }

  /** 新增AI配置并切换 */
  async addAI(
    guid: string,
    name: string,
    host: string,
    key: string,
    model: string,
  ): Promise<void> {
    const defaultConfig = await this.getAIConfig();
    const aiConfig = {
      ...defaultConfig,
      host,
      key,
      model,
    };
    await this.setAIList(name, aiConfig);
    await this.switchAI(guid, name);
  }

  /** 删除AI配置 */
  async deleteAI(name: string): Promise<boolean> {
    const aiConfigStr = await this.redis.get(`ai:list:${name}`);
    if (!aiConfigStr) {
      console.log("删除失败, 无此模型");
      return false;
    }
    await this.redis.del(`ai:list:${name}`);
    return true;
  }

  /** 切换AI */
  async switchAI(guid: string, name: string): Promise<AIConfig | null> {
    const aiConfigStr = await this.redis.get(`ai:list:${name}`);
    if (!aiConfigStr) {
      console.log("切换失败, 无此模型");
      await this.setAIConfig(guid, db.defaultAIConfig);
      return null;
    }
    const aiConfig = JSON.parse(aiConfigStr) as AIConfig;
    const currentConfig = await this.getAIConfig(guid);
    aiConfig.systemPrompt = currentConfig.systemPrompt;
    await this.setAIConfig(guid, aiConfig);
    return aiConfig;
  }

  /** 切换AI的RAPI模式 */
  async switchModelRAPI(aiName: string, enable: boolean): Promise<void> {
    const aiConfigStr = await this.redis.get(`ai:list:${aiName}`);
    if (!aiConfigStr) {
      console.log("切换失败, 无此模型");
      return;
    }
    const aiConfig = JSON.parse(aiConfigStr) as AIConfig;
    aiConfig.rapi = enable;
    await this.setAIList(aiName, aiConfig);
  }

  /** 获取提示词列表 */
  async getPromptList(): Promise<string[]> {
    const keys = await this.redis.keys("ai:prompt:*");
    return keys.map((key) => key.replace("ai:prompt:", ""));
  }

  /** 获取提示词内容 */
  async getPrompt(name: string): Promise<string | null> {
    return await this.redis.get(`ai:prompt:${name}`);
  }

  /** 设置提示词内容 */
  async setPrompt(name: string, content: string): Promise<void> {
    await this.redis.set(`ai:prompt:${name}`, content);
  }

  /** 新增提示词 */
  async addPrompt(name: string, content: string): Promise<void> {
    await this.setPrompt(name, content);
  }

  /** 删除提示词 */
  async deletePrompt(name: string): Promise<number> {
    return await this.redis.del(`ai:prompt:${name}`);
  }

  /** 切换当前提示词 */
  async switchPrompt(guid: string, name: string): Promise<string | null> {
    if (name === "") {
      const config = await this.getAIConfig(guid);
      config.systemPrompt = "";
      await this.setAIConfig(guid, config);
      return this.systemPrompt;
    }
    const prompt = await this.getPrompt(name);
    if (!prompt) {
      console.log("切换提示词失败, 无此提示词");
      return null;
    }
    const config = await this.getAIConfig(guid);
    config.systemPrompt = prompt;
    await this.setAIConfig(guid, config);
    return prompt;
  }

  /** 获取聊天历史 */
  async getAIChatHistory(guid: string): Promise<any[]> {
    const historyStr = await this.redis.get(`ai:history:${guid}`);
    if (historyStr) {
      return JSON.parse(historyStr);
    }
    return [];
  }

  /** 设置聊天历史 */
  async setAIChatHistory(guid: string, history: any[]): Promise<void> {
    await this.redis.set(`ai:history:${guid}`, JSON.stringify(history));
  }

  /** 添加聊天历史 */
  async addAIChatHistory(guid: string, data: any): Promise<any[]> {
    const history = await this.getAIChatHistory(guid);
    while (history.length >= 40) history.shift();
    history.push(data);
    await this.setAIChatHistory(guid, history);
    return history;
  }

  /** 清除聊天历史 */
  async clearAIChatHistory(guid?: string): Promise<void> {
    if (!guid) {
      const keys = await this.redis.keys(`ai:history:*`);
      for (const key of keys) {
        await this.redis.del(key);
      }
      return;
    }
    await this.redis.del(`ai:history:${guid}`);
  }

  /** 获取好感度 */
  async getAffectionLevel(guid: string, userKey: string): Promise<number> {
    const levelStr = await this.redis.get(`ai:affection:${guid}:${userKey}`);
    return levelStr ? parseInt(levelStr, 10) : 0;
  }

  /** 设置好感度 */
  async setAffectionLevel(
    guid: string,
    userKey: string,
    level: number,
  ): Promise<void> {
    await this.redis.set(`ai:affection:${guid}:${userKey}`, level.toString());
  }

  /** 增加好感度 */
  async incrementAffectionLevel(
    guid: string,
    userKey: string,
    increment: number,
  ): Promise<number> {
    const currentLevel = await this.getAffectionLevel(guid, userKey);
    const newLevel = currentLevel + increment;
    await this.setAffectionLevel(guid, userKey, newLevel);
    return newLevel;
  }

  /** 获取所有好感度 */
  async getAffectionLevelAll(guid: string): Promise<Record<string, number>> {
    const keys = await this.redis.keys(`ai:affection:${guid}:*`);
    const levels: Record<string, number> = {};
    for (const key of keys) {
      const levelStr = await this.redis.get(key);
      if (levelStr) {
        const userKey = key.replace(`ai:affection:${guid}:`, "");
        levels[userKey] = parseInt(levelStr, 10);
      }
    }
    return levels;
  }

  /** 重置用户好感度 */
  async resetAffectionLevel(guid: string, userKey: string): Promise<number> {
    return await this.redis.del(`ai:affection:${guid}:${userKey}`);
  }

  /** 重置全部好感度 */
  async resetAllAffectionLevels(): Promise<void> {
    const keys = await this.redis.keys(`ai:affection:*`);
    for (const key of keys) {
      await this.redis.del(key);
    }
  }

  /** 设置好感度开关 */
  async setAffectionSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:affection:switch:${guid}`, enable ? "1" : "0");
  }

  /** 获取好感度开关 */
  async getAffectionSwitch(guid: string): Promise<string> {
    const switchStr =
      (await this.redis.get(`ai:affection:switch:${guid}`)) || "1";
    return switchStr;
  }

  /** 设置语音回复开关 */
  async setTTSResponseSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`chat:tts:response:${guid}`, enable ? "1" : "0");
  }

  /** 获取语音回复开关 */
  async getTTSResponseSwitch(guid: string): Promise<string> {
    const switchStr =
      (await this.redis.get(`chat:tts:response:${guid}`)) || "0";
    return switchStr;
  }

  /** 设置 bot id */
  async setBotID(id: string): Promise<void> {
    await this.redis.set("bot:id", id);
  }

  /** 获取 bot id */
  async getBotID(): Promise<string | null> {
    return await this.redis.get("bot:id");
  }

  /** 添加图片URL */
  async addImgUrl(guid: string, url: string): Promise<void> {
    const id = guid ?? "global";
    await this.redis.lpush(`ai:images:${id}`, url);
  }

  /** 获取图片URL列表 */
  async getImgUrls(guid: string): Promise<string[]> {
    const id = guid ?? "global";
    return await this.redis.lrange(`ai:images:${id}`, 0, -1);
  }

  /** 主动搭话 */
  async getProactiveSwitch(guid: string): Promise<string> {
    return (await this.redis.get(`ai:proactive:switch:${guid}`)) || "1";
  }

  async setProactiveSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:proactive:switch:${guid}`, enable ? "1" : "0");
  }

  /** 深度思考 */
  async getDeepThoughtSwitch(guid: string): Promise<string> {
    return (await this.redis.get(`ai:deep_thought:switch:${guid}`)) || "0";
  }

  async setDeepThoughtSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:deep_thought:switch:${guid}`, enable ? "1" : "0");
  }
}

const configValue = getConfigValue();
const aiChatConfig = configValue.aiChat || {};
const redisClient = new db({
  host: aiChatConfig.redis?.host ?? "localhost",
  port: aiChatConfig.redis?.port ?? 6379,
  password: aiChatConfig.redis?.password ?? "",
});

export default redisClient;
