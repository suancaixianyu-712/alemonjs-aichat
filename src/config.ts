import Redis, { RedisOptions } from "ioredis";
import { getConfigValue } from "alemonjs";
import { AIConfig } from "./types";
import { availableTools, tools } from "./api/aitools";
import fs from "fs";
import path from "path";
import { redis } from "./redis";

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

  constructor(redisInstance?: Redis) {
    this.redis = redisInstance || redis;
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

  /** --------------------------------------------------------- */
  /** 工具相关配置 */

  /** 获取工具开关状态 */
  async getToolSwitch(guid: string): Promise<string | null> {
    return (await this.redis.get(`ai:tool:switch:${guid}`)) || "1";
  }

  /** 设置工具开关状态 */
  async setToolSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:tool:switch:${guid}`, enable ? "1" : "0");
  }

  /** 工具调用时是否发送提示 */
  async getToolPromptSwitch(guid: string): Promise<string | null> {
    return (await this.redis.get(`ai:tool_prompt:switch:${guid}`)) || "0";
  }

  /** 设置工具调用提示开关状态 */
  async setToolPromptSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:tool_prompt:switch:${guid}`, enable ? "1" : "0");
  }

  /** 工具调用时发送的提示是否撤回 */
  async getToolPromptRevokeSwitch(guid: string): Promise<string | null> {
    return (
      (await this.redis.get(`ai:tool_prompt_revoke:switch:${guid}`)) || "0"
    );
  }

  /** 设置工具调用提示撤回开关状态 */
  async setToolPromptRevokeSwitch(
    guid: string,
    enable: boolean,
  ): Promise<void> {
    await this.redis.set(
      `ai:tool_prompt_revoke:switch:${guid}`,
      enable ? "1" : "0",
    );
  }

  /** 工具调用时发送的提示是否显示传参 */
  async getToolPromptArgsSwitch(guid: string): Promise<string | null> {
    return (await this.redis.get(`ai:tool_prompt_args:switch:${guid}`)) || "0";
  }

  /** 设置工具调用提示显示传参开关状态 */
  async setToolPromptArgsSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(
      `ai:tool_prompt_args:switch:${guid}`,
      enable ? "1" : "0",
    );
  }

  /** --------------------------------------------------------- */

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
      console.log("切换失败, 无此AI");
      await this.setAIConfig(guid, db.defaultAIConfig);
      return null;
    }
    const aiConfig = JSON.parse(aiConfigStr) as AIConfig;
    const currentConfig = await this.getAIConfig(guid);
    aiConfig.systemPrompt = currentConfig.systemPrompt;
    await this.setAIConfig(guid, aiConfig);

    // 记录当前切换的ai名字
    await this.redis.set(`ai:currentAI:${guid}`, name);
    return aiConfig;
  }

  /** 获取当前使用的AI名称 */
  async getCurrentAI(guid: string): Promise<string> {
    return (await this.redis.get(`ai:currentAI:${guid}`)) || "";
  }

  /** 切换AI的RAPI模式 */
  async switchModelRAPI(aiName: string, enable: boolean): Promise<void> {
    const aiConfigStr = await this.redis.get(`ai:list:${aiName}`);
    if (!aiConfigStr) {
      console.log("切换失败, 无此AI");
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
    // while (history.length >= 40) history.shift();
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

  /** 清理最后的N条聊天记录 */
  async clearLastNChatHistory(guid: string, n: number): Promise<void> {
    const history = await this.getAIChatHistory(guid);
    while (history.length > n) {
      history.shift();
    }
    await this.setAIChatHistory(guid, history);
  }

  /** 存储摘要,全局共享 */
  async setSummary(guid: string, id: string, summary: string): Promise<void> {
    await this.redis.set(`ai:summary:${guid}:${id}`, `${summary}`);
  }
  /** 获取摘要 */
  async getSummary(guid: string, id: string): Promise<string | null> {
    return await this.redis.get(`ai:summary:${guid}:${id}`);
  }
  /** 获取所有摘要时间列表 */
  async getSummaryList(): Promise<{ id: string; summary: string }[]> {
    console.log("获取列表");

    const keys = await this.redis.keys(`ai:summary:*`);
    return Promise.all(
      keys.map(async (key) => {
        const parts = key.split(":");
        const summary = await this.redis.get(key);
        return {
          id: `${parts[2]}:${parts[3]}`,
          summary: summary ?? "",
        };
      }),
    );
  }

  /** 删除摘要 */
  async deleteSummary(guid: string, id: string): Promise<number> {
    return await this.redis.del(`ai:summary:${guid}:${id}`);
  }
  /** 存储摘要中的详细内容 */
  async setSummaryDetail(
    guid: string,
    id: string,
    detail: string,
  ): Promise<void> {
    await this.redis.set(`ai:summary_detail:${guid}:${id}`, `${detail}`);
  }
  /** 获取摘要中的详细内容 */
  async getSummaryDetail(guid: string, id: string): Promise<string | null> {
    return await this.redis.get(`ai:summary_detail:${guid}:${id}`);
  }
  /** 删除摘要中的详细内容 */
  async deleteSummaryDetail(guid: string, id: string): Promise<number> {
    return await this.redis.del(`ai:summary_detail:${guid}:${id}`);
  }

  /** 存储用户数据 */
  async setUserData(userKey: string, value: string): Promise<void> {
    await this.redis.set(`ai:user:${userKey}`, value);
  }
  /** 获取用户数据 */
  async getUserData(userKey: string): Promise<string | null> {
    return await this.redis.get(`ai:user:${userKey}`);
  }
  /** 删除用户数据 */
  async deleteUserData(userKey: string): Promise<number> {
    return await this.redis.del(`ai:user:${userKey}`);
  }

  /** 设置会话id */
  async setSessionId(guid: string, sessionId: string): Promise<void> {
    await this.redis.set(`ai:session:${guid}`, sessionId);
  }
  /** 获取会话id */
  async getSessionId(guid: string): Promise<string | null> {
    return await this.redis.get(`ai:session:${guid}`);
  }
  /** 删除会话id */
  async deleteSessionId(guid: string): Promise<number> {
    return await this.redis.del(`ai:session:${guid}`);
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
    await this.redis.set(`ai:tts:response:${guid}`, enable ? "1" : "0");
  }

  /** 获取语音回复开关 */
  async getTTSResponseSwitch(guid: string): Promise<string> {
    const switchStr = (await this.redis.get(`ai:tts:response:${guid}`)) || "0";
    return switchStr;
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

  /** 设置深度思考开关 */
  async setDeepThoughtSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:deep_thought:switch:${guid}`, enable ? "1" : "0");
  }

  /** 仅艾特触发 */
  async getAtTriggerSwitch(guid: string): Promise<string> {
    return (await this.redis.get(`ai:at_trigger:switch:${guid}`)) || "1";
  }

  /** 设置仅艾特触发开关 */
  async setAtTriggerSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:at_trigger:switch:${guid}`, enable ? "1" : "0");
  }

  /** --------------------------------------------------------- */
  /** 正则触发规则 */

  /** 获取正则触发规则列表 */
  async getRegexRules(guid: string): Promise<string[]> {
    const rulesStr = await this.redis.get(`ai:regex_rules:${guid}`);
    if (rulesStr) {
      return JSON.parse(rulesStr);
    }
    return [];
  }

  /** 设置正则触发规则列表 */
  async setRegexRules(guid: string, rules: string[]): Promise<void> {
    await this.redis.set(`ai:regex_rules:${guid}`, JSON.stringify(rules));
  }

  /** 添加正则触发规则 */
  async addRegexRule(guid: string, rule: string): Promise<boolean> {
    // 验证正则表达式是否合法
    try {
      new RegExp(rule);
    } catch {
      return false;
    }
    const rules = await this.getRegexRules(guid);
    if (rules.includes(rule)) {
      return false; // 规则已存在
    }
    rules.push(rule);
    await this.setRegexRules(guid, rules);
    return true;
  }

  /** 删除正则触发规则 */
  async removeRegexRule(guid: string, ruleOrIndex: string): Promise<boolean> {
    const rules = await this.getRegexRules(guid);
    // 尝试按索引删除
    const index = parseInt(ruleOrIndex, 10);
    if (!isNaN(index) && index >= 0 && index < rules.length) {
      rules.splice(index, 1);
      await this.setRegexRules(guid, rules);
      return true;
    }
    // 按规则内容删除
    const ruleIndex = rules.indexOf(ruleOrIndex);
    if (ruleIndex === -1) {
      return false;
    }
    rules.splice(ruleIndex, 1);
    await this.setRegexRules(guid, rules);
    return true;
  }

  /** 检查消息是否匹配正则触发规则 */
  async matchRegexRule(guid: string, message: string): Promise<boolean> {
    const rules = await this.getRegexRules(guid);
    for (const rule of rules) {
      try {
        const regex = new RegExp(rule);
        if (regex.test(message)) {
          return true;
        }
      } catch {
        // 跳过无效的正则
      }
    }
    return false;
  }

  /** 清空正则触发规则 */
  async clearRegexRules(guid: string): Promise<void> {
    await this.redis.del(`ai:regex_rules:${guid}`);
  }

  /** --------------------------------------------------------- */
  /** 容器管理 */

  /** 获取群容器配置 */
  async getGroupContainer(groupId: string): Promise<Record<string, any> | null> {
    const str = await this.redis.get(`ai:container:group:${groupId}`);
    return str ? JSON.parse(str) : null;
  }

  /** 设置群容器配置 */
  async setGroupContainer(groupId: string, config: Record<string, any>): Promise<void> {
    await this.redis.set(`ai:container:group:${groupId}`, JSON.stringify(config));
  }

  /** 获取用户容器配置 */
  async getUserContainer(userId: string): Promise<Record<string, any> | null> {
    const str = await this.redis.get(`ai:container:user:${userId}`);
    return str ? JSON.parse(str) : null;
  }

  /** 设置用户容器配置 */
  async setUserContainer(userId: string, config: Record<string, any>): Promise<void> {
    await this.redis.set(`ai:container:user:${userId}`, JSON.stringify(config));
  }

  /** 获取用户当前 exec 环境配置（按群隔离） */
  async getExecEnv(groupId: string, userId: string): Promise<Record<string, any> | null> {
    const key = groupId === "private"
      ? `ai:container:env:private:${userId}`
      : `ai:container:env:${groupId}:${userId}`;
    const str = await this.redis.get(key);
    return str ? JSON.parse(str) : null;
  }

  /** 设置用户当前 exec 环境配置（按群隔离） */
  async setExecEnv(groupId: string, userId: string, config: Record<string, any>): Promise<void> {
    const key = groupId === "private"
      ? `ai:container:env:private:${userId}`
      : `ai:container:env:${groupId}:${userId}`;
    await this.redis.set(key, JSON.stringify(config));
  }

  /** 创建群容器（首次触发时自动创建） */
  async ensureGroupContainer(groupId: string): Promise<Record<string, any>> {
    const existing = await this.getGroupContainer(groupId);
    if (existing) return existing;

    const configValue = getConfigValue();
    const containerConf = configValue.aiChat?.groupContainer || {};
    const image = containerConf.image || "ubuntu:latest";
    const containerName = `aichat_grp_${groupId}`;

    const config = {
      containerName,
      image,
      memory: containerConf.memory || "256m",
      cpus: containerConf.cpus || "0.5",
      pidsLimit: containerConf.pidsLimit || 64,
      networkMode: containerConf.networkMode || "none",
    };
    await this.setGroupContainer(groupId, config);
    return config;
  }

  /** 创建用户容器（手动切换或私聊首次触发时创建） */
  async ensureUserContainer(userId: string): Promise<Record<string, any>> {
    const existing = await this.getUserContainer(userId);
    if (existing) return existing;

    const configValue = getConfigValue();
    const containerConf = configValue.aiChat?.userContainer || {};
    const image = containerConf.image || "ubuntu:latest";
    const containerName = `aichat_usr_${userId}`;

    const config = {
      containerName,
      image,
      memory: containerConf.memory || "128m",
      cpus: containerConf.cpus || "0.25",
      pidsLimit: containerConf.pidsLimit || 32,
      networkMode: containerConf.networkMode || "none",
    };
    await this.setUserContainer(userId, config);
    return config;
  }

  /** 初始化用户 exec 环境（群聊默认群容器，私聊默认用户容器） */
  async initExecEnv(groupId: string, userId: string): Promise<Record<string, any>> {
    const existing = await this.getExecEnv(groupId, userId);
    if (existing) return existing;

    if (groupId === "private") {
      // 私聊默认用户容器
      const userConfig = await this.ensureUserContainer(userId);
      await this.setExecEnv("private", userId, userConfig);
      return userConfig;
    } else {
      // 群聊默认群容器
      const groupConfig = await this.ensureGroupContainer(groupId);
      await this.setExecEnv(groupId, userId, groupConfig);
      return groupConfig;
    }
  }

  /** 切换到群容器 */
  async switchToGroupContainer(groupId: string, userId: string): Promise<Record<string, any>> {
    const groupConfig = await this.ensureGroupContainer(groupId);
    await this.setExecEnv(groupId, userId, groupConfig);
    return groupConfig;
  }

  /** 切换到用户容器 */
  async switchToUserContainer(groupId: string, userId: string): Promise<Record<string, any>> {
    const userConfig = await this.ensureUserContainer(userId);
    await this.setExecEnv(groupId, userId, userConfig);
    return userConfig;
  }

  /** 切换到系统环境 */
  async switchToSystemEnv(userId: string): Promise<void> {
    await this.setExecEnv("private", userId, { system: true });
  }

  /** 判断是否为超级管理员 */
  isSuperAdmin(userId: string): boolean {
    const configValue = getConfigValue();
    const superAdmins = configValue.aiChat?.superAdmin || [];
    return superAdmins.includes(userId);
  }

  /** --------------------------------------------------------- */

  /** 禁用工具 */
  async disableTool(guid: string, toolName: string): Promise<void> {
    await this.redis.set(`ai:tool:disable:${guid}:${toolName}`, "1");
  }

  /** 启用工具 */
  async enableTool(guid: string, toolName: string): Promise<void> {
    await this.redis.del(`ai:tool:disable:${guid}:${toolName}`);
  }

  /** 获取工具状态 */
  async getToolStatus(guid: string, toolName: string): Promise<string> {
    const status =
      (await this.redis.get(`ai:tool:disable:${guid}:${toolName}`)) || "0";
    return status;
  }

  /** 获取所有工具状态 */
  async getAllToolStatus(guid: string): Promise<Record<string, string>> {
    const status: Record<string, string> = {};
    for (const tool of tools) {
      const toolName = tool.type === "function" ? tool.function.name : "";
      status[toolName] = await this.getToolStatus(guid, toolName);
    }
    return status;
  }

  // 获取所有可用工具,返回完整工具
  async getAvailableTools(guid: string): Promise<any[]> {
    const toolStatus = await this.getAllToolStatus(guid);
    const availableTools = tools.filter((tool) => {
      const toolName = tool.type === "function" ? tool.function.name : "";
      return !toolStatus[toolName] || toolStatus[toolName] === "0";
    });
    return availableTools;
  }

  /** 装载工具 */
  async loadTools(guid: string): Promise<string[]> {
    const toolStatus = await this.getAllToolStatus(guid);
    const allTools = tools.map((tool) =>
      tool.type === "function" ? tool.function.name : "",
    );
    // 默认禁用的危险工具
    const defaultDisabledTools = ["exec", "EvalCode"];
    // 给工具添加默认状态
    const toolsWithStatus = allTools.map((tool) => ({
      name: tool,
      disabled:
        (toolStatus[tool] && toolStatus[tool] === "1") ||
        (!toolStatus[tool] && defaultDisabledTools.includes(tool)),
    }));
    // 存储工具状态
    for (const tool of toolsWithStatus) {
      if (tool.disabled) {
        await this.disableTool(guid, tool.name);
      } else {
        await this.enableTool(guid, tool.name);
      }
    }
    return toolsWithStatus.map((tool) => tool.name);
  }
}

const redisClient = new db(redis);

export default redisClient;
