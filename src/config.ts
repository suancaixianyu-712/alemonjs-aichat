import Redis from "ioredis";
import { getConfigValue } from "alemonjs";
import { AIConfig } from "./types";
import fs from "fs";
import path from "path";
import { redis } from "./redis";

type ArchivedChatRecord = {
  id: string;
  guid: string;
  summary: string;
  detail: string;
  transcript: string;
  history: any[];
  reason: string;
  createdAt: number;
};

type ArchivedChatSearchResult = {
  id: string;
  guid: string;
  summary: string;
  detail: string;
  transcript: string;
  reason: string;
  createdAt: number;
  score: number;
};

const TOOL_LOOP_TTL_SECONDS = 600;
const TOOL_LOOP_STALE_MS = TOOL_LOOP_TTL_SECONDS * 1000;
export const DEFAULT_CAPI_CONTEXT_LIMIT = 512000;
const ARCHIVED_CHAT_SUMMARY_MAX_LENGTH = 240;
const ARCHIVED_CHAT_DETAIL_MAX_LENGTH = 4000;
const ARCHIVED_CHAT_MESSAGE_MAX_LENGTH = 1200;
const ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH = 12000;
const ARCHIVED_CHAT_HISTORY_PREVIEW_LIMIT = 12;
const ARCHIVED_CHAT_RECORD_MAX_STORE_BYTES = 128 * 1024;
const ARCHIVED_CHAT_RECORD_MAX_PARSE_BYTES = 1024 * 1024;

type AIToolLoopState = {
  processing: true;
  startedAt: number;
  updatedAt: number;
};

export type AIContextStatsInput = {
  mode: "capi" | "rapi";
  model: string;
  contextMessageCount: number;
  contextCharLength: number;
  estimatedContextTokens: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  cacheMissTokens?: number | null;
  usageAvailable: boolean;
};

export type AIContextStats = AIContextStatsInput & {
  guid: string;
  requestCount: number;
  updatedAt: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokensUsed: number;
  totalCachedTokens: number;
  totalCacheMissTokens: number;
};

class db {
  redis: Redis;
  systemPrompt = "";

  /**
   * 校验并修复 OpenAI chat messages 中 tool 配对：
   * - role=tool 必须紧跟在带 tool_calls 的 assistant 之后，且 tool_call_id 一一对应
   * - 截断/压缩导致的孤儿 tool、不完整 tool_calls 组会被清理
   * - 避免 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
   */
  private sanitizeAIChatHistory(history: any[]): any[] {
    if (!Array.isArray(history) || history.length === 0) {
      return [];
    }

    const sanitized: any[] = [];
    let index = 0;

    while (index < history.length) {
      const message = history[index];

      if (!message || typeof message !== "object") {
        index += 1;
        continue;
      }

      // 孤儿 tool：前面没有完整的 assistant.tool_calls
      if (message.role === "tool") {
        index += 1;
        continue;
      }

      const isAssistant = message.role === "assistant";
      const rawToolCalls =
        isAssistant && Array.isArray(message.tool_calls)
          ? message.tool_calls.filter(
              (toolCall: any) =>
                toolCall &&
                (toolCall.function?.name || toolCall.name),
            )
          : [];

      if (!isAssistant || rawToolCalls.length === 0) {
        // assistant 带了无效/空 tool_calls 时去掉该字段，避免 API 校验失败
        if (isAssistant && Array.isArray(message.tool_calls)) {
          const { tool_calls: _ignored, ...rest } = message;
          sanitized.push(rest);
        } else {
          sanitized.push(message);
        }
        index += 1;
        continue;
      }

      const followingToolMessages: any[] = [];
      let cursor = index + 1;
      while (cursor < history.length && history[cursor]?.role === "tool") {
        followingToolMessages.push(history[cursor]);
        cursor += 1;
      }

      const normalizedToolCalls = rawToolCalls.map(
        (toolCall: any, toolIndex: number) => {
          const existingId = String(toolCall.id || "").trim();
          const orderedTool = followingToolMessages[toolIndex];
          const orderedId = String(orderedTool?.tool_call_id || "").trim();
          const id = existingId || orderedId || `call_${index}_${toolIndex}`;

          return {
            id,
            type: toolCall.type || "function",
            function: {
              name: String(toolCall.function?.name || toolCall.name || ""),
              arguments:
                typeof toolCall.function?.arguments === "string"
                  ? toolCall.function.arguments
                  : JSON.stringify(
                      toolCall.function?.arguments ?? toolCall.arguments ?? {},
                    ),
            },
          };
        },
      );

      const usedToolIndexes = new Set<number>();
      const matchedToolMessages: any[] = [];
      let allMatched = true;

      for (let toolIndex = 0; toolIndex < normalizedToolCalls.length; toolIndex += 1) {
        const toolCall = normalizedToolCalls[toolIndex];
        let foundIndex = followingToolMessages.findIndex(
          (toolMessage, candidateIndex) =>
            !usedToolIndexes.has(candidateIndex) &&
            String(toolMessage?.tool_call_id || "").trim() === toolCall.id,
        );

        if (foundIndex < 0 && !usedToolIndexes.has(toolIndex) && followingToolMessages[toolIndex]) {
          // 部分上游流式响应会丢 id，按顺序兜底配对
          foundIndex = toolIndex;
        }

        if (foundIndex < 0) {
          allMatched = false;
          break;
        }

        usedToolIndexes.add(foundIndex);
        const toolMessage = followingToolMessages[foundIndex];
        const content =
          typeof toolMessage.content === "string"
            ? toolMessage.content
            : JSON.stringify(toolMessage.content ?? null);

        matchedToolMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content,
          ...(toolMessage.name || toolCall.function.name
            ? { name: String(toolMessage.name || toolCall.function.name) }
            : {}),
        });
      }

      if (allMatched && matchedToolMessages.length === normalizedToolCalls.length) {
        sanitized.push(
          {
            ...message,
            tool_calls: normalizedToolCalls,
          },
          ...matchedToolMessages,
        );
      } else {
        // 不完整 tool 组：降级为普通 assistant，丢掉残缺 tool，避免 400
        const { tool_calls: _ignored, ...rest } = message;
        const content =
          typeof rest.content === "string" && rest.content.trim()
            ? rest.content
            : `[此前调用了工具: ${normalizedToolCalls
                .map((item) => item.function.name)
                .filter(Boolean)
                .join(", ")}]`;
        sanitized.push({
          ...rest,
          role: "assistant",
          content,
        });
      }

      index = cursor;
    }

    return sanitized;
  }

  /** 对外暴露：请求模型前清洗 messages，防止 tool 配对错误 */
  sanitizeChatMessages(history: any[]): any[] {
    return this.sanitizeAIChatHistory(history);
  }

  private async getToolDefinitions() {
    const { tools } = await import("./api/aitools");
    return tools;
  }

  private extractMessageText(content: any): string {
    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (!part) return "";
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          if (typeof part?.content === "string") return part.content;
          if (part?.type === "input_text" && typeof part?.text === "string") {
            return part.text;
          }
          if (part?.type === "output_text" && typeof part?.text === "string") {
            return part.text;
          }
          if (part?.type === "image_url" && part?.image_url?.url) {
            return `[image:${part.image_url.url}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    if (content && typeof content === "object") {
      if (typeof content.text === "string") {
        return content.text;
      }
      if (typeof content.content === "string") {
        return content.content;
      }
    }

    return "";
  }

  private trimText(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
  }

  private getUtf8ByteLength(text: string): number {
    return Buffer.byteLength(text, "utf8");
  }

  private formatHistoryMessage(message: any): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    const role = String(message.role || "unknown");
    const name = message.name ? `(${message.name})` : "";
    const content = this.extractMessageText(message.content);
    const trimmed = this.trimText(
      content.trim(),
      ARCHIVED_CHAT_MESSAGE_MAX_LENGTH,
    );

    if (!trimmed) {
      return `${role}${name}: [空内容]`;
    }

    return `${role}${name}: ${trimmed}`;
  }

  private buildChatHistoryTranscript(history: any[]): string {
    const transcript = history
      .map((message) => this.formatHistoryMessage(message))
      .filter(Boolean)
      .join("\n");

    return this.trimText(transcript, ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH);
  }

  private compactToolCalls(toolCalls: any[]): any[] {
    if (!Array.isArray(toolCalls)) {
      return [];
    }

    return toolCalls.slice(0, 5).map((toolCall) => ({
      id: toolCall?.id || "",
      type: toolCall?.type || "function",
      function: {
        name: toolCall?.function?.name || "",
        arguments: this.trimText(
          String(toolCall?.function?.arguments || ""),
          ARCHIVED_CHAT_MESSAGE_MAX_LENGTH,
        ),
      },
    }));
  }

  private compactArchivedHistory(history: any[]): any[] {
    if (!Array.isArray(history) || history.length === 0) {
      return [];
    }

    return history.slice(-ARCHIVED_CHAT_HISTORY_PREVIEW_LIMIT).map((message) => {
      const compactMessage: Record<string, any> = {
        role: String(message?.role || "unknown"),
        content: this.trimText(
          this.extractMessageText(message?.content),
          ARCHIVED_CHAT_MESSAGE_MAX_LENGTH,
        ),
      };

      if (message?.name) {
        compactMessage.name = String(message.name);
      }

      if (message?.tool_call_id) {
        compactMessage.tool_call_id = String(message.tool_call_id);
      }

      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        compactMessage.tool_calls = this.compactToolCalls(message.tool_calls);
      }

      return compactMessage;
    });
  }

  private buildArchivedChatFallbackRecord(
    guid: string,
    id: string,
    summary?: string | null,
    detail?: string | null,
  ): ArchivedChatRecord | null {
    if (!summary && !detail) {
      return null;
    }

    const normalizedSummary = this.trimText(
      summary || "无摘要",
      ARCHIVED_CHAT_SUMMARY_MAX_LENGTH,
    );
    const normalizedDetail = this.trimText(
      detail || "",
      ARCHIVED_CHAT_DETAIL_MAX_LENGTH,
    );

    return {
      id,
      guid,
      summary: normalizedSummary,
      detail: normalizedDetail,
      transcript: normalizedDetail,
      history: [],
      reason: "legacy",
      createdAt: Number(id) || 0,
    };
  }

  private buildStoredArchivedChatRecord(record: ArchivedChatRecord) {
    const baseRecord: ArchivedChatRecord = {
      ...record,
      summary: this.trimText(
        record.summary || "无摘要",
        ARCHIVED_CHAT_SUMMARY_MAX_LENGTH,
      ),
      detail: this.trimText(
        record.detail || "",
        ARCHIVED_CHAT_DETAIL_MAX_LENGTH,
      ),
      transcript: this.trimText(
        record.transcript || "",
        ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH,
      ),
      history: this.compactArchivedHistory(record.history || []),
    };

    const candidates: ArchivedChatRecord[] = [
      baseRecord,
      {
        ...baseRecord,
        history: [],
      },
      {
        ...baseRecord,
        detail: this.trimText(baseRecord.detail, 2000),
        transcript: this.trimText(baseRecord.transcript, 4000),
        history: [],
      },
      {
        ...baseRecord,
        detail: this.trimText(baseRecord.detail, 800),
        transcript: "",
        history: [],
      },
    ];

    for (const candidate of candidates) {
      const serialized = JSON.stringify(candidate);
      if (
        this.getUtf8ByteLength(serialized) <=
        ARCHIVED_CHAT_RECORD_MAX_STORE_BYTES
      ) {
        return {
          record: candidate,
          serialized,
        };
      }
    }

    const fallbackRecord: ArchivedChatRecord = {
      ...baseRecord,
      detail: "",
      transcript: "",
      history: [],
    };

    return {
      record: fallbackRecord,
      serialized: JSON.stringify(fallbackRecord),
    };
  }

  private buildFallbackSummary(history: any[], transcript: string): string {
    const recent = history
      .slice(-6)
      .map((message) => this.formatHistoryMessage(message))
      .filter(Boolean)
      .join(" ");

    if (recent) {
      return this.trimText(`共 ${history.length} 条消息，最近内容：${recent}`, 180);
    }

    return this.trimText(
      `共 ${history.length} 条消息，主要内容：${transcript || "无可用文本内容"}`,
      180,
    );
  }

  private buildFallbackDetail(history: any[], transcript: string): string {
    const recentMessages = history
      .slice(-20)
      .map((message) => this.formatHistoryMessage(message))
      .filter(Boolean)
      .join("\n");

    return this.trimText(
      recentMessages || transcript || "无详细历史内容",
      2000,
    );
  }

  private getArchiveRecordKey(guid: string, id: string): string {
    return `ai:memory:chat:${guid}:${id}`;
  }

  private buildSearchTerms(query: string): string[] {
    const normalized = query.toLowerCase().trim();
    if (!normalized) {
      return [];
    }

    const parts = normalized.split(/\s+/).filter(Boolean);
    return [...new Set([normalized, ...parts])];
  }

  private scoreArchivedChatRecord(
    record: ArchivedChatRecord,
    query: string,
  ): number {
    const normalized = query.toLowerCase().trim();
    if (!normalized) {
      return 0;
    }

    const summary = (record.summary || "").toLowerCase();
    const detail = (record.detail || "").toLowerCase();
    const transcript = (record.transcript || "").toLowerCase();
    const terms = this.buildSearchTerms(query);
    let score = 0;

    if (summary.includes(normalized)) score += 18;
    if (detail.includes(normalized)) score += 12;
    if (transcript.includes(normalized)) score += 6;

    for (const term of terms) {
      if (!term) continue;
      if (summary.includes(term)) score += 6;
      if (detail.includes(term)) score += 4;
      if (transcript.includes(term)) score += 2;
    }

    return score;
  }

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

  /** 获取 CAPI 自动压缩上下文长度 */
  async getCAPIContextLimit(guid: string): Promise<number> {
    const raw = await this.redis.get(`ai:capi_context_limit:${guid}`);
    const limit = Number(raw);
    return Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : DEFAULT_CAPI_CONTEXT_LIMIT;
  }

  /** 设置 CAPI 自动压缩上下文长度 */
  async setCAPIContextLimit(guid: string, limit: number): Promise<void> {
    const normalized = Math.max(1, Math.floor(limit));
    await this.redis.set(`ai:capi_context_limit:${guid}`, String(normalized));
  }

  /** 获取识图/OCR 专用 AI 名称（AI 列表中的名称） */
  async getOCRAIName(guid: string): Promise<string> {
    return (await this.redis.get(`ai:ocr_ai:${guid}`)) || "";
  }

  /** 设置识图/OCR 专用 AI 名称 */
  async setOCRAIName(guid: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      await this.redis.del(`ai:ocr_ai:${guid}`);
      return;
    }
    await this.redis.set(`ai:ocr_ai:${guid}`, trimmed);
  }

  /** 清除识图/OCR 专用 AI */
  async clearOCRAIName(guid: string): Promise<void> {
    await this.redis.del(`ai:ocr_ai:${guid}`);
  }

  /** 获取 GPT 画图工具专用配置 */
  async getGPTImageConfig(): Promise<{ host: string; key: string; model: string } | null> {
    const configStr = await this.redis.get("ai:tool:gptimage");
    if (!configStr) return null;
    try {
      return JSON.parse(configStr);
    } catch {
      return null;
    }
  }

  /** 设置 GPT 画图工具专用配置 */
  async setGPTImageConfig(host: string, key: string, model: string): Promise<void> {
    await this.redis.set("ai:tool:gptimage", JSON.stringify({ host, key, model }));
  }

  /**
   * 获取识图/OCR 专用 AI 完整配置
   * 从 ai:list 中解析，用于 DeepSeek 等纯文本模型的看图描述
   */
  async getOCRAIConfig(guid: string): Promise<(AIConfig & { name: string }) | null> {
    const name = await this.getOCRAIName(guid);
    if (!name) {
      return null;
    }
    const aiConfigStr = await this.redis.get(`ai:list:${name}`);
    if (!aiConfigStr) {
      return null;
    }
    try {
      const config = JSON.parse(aiConfigStr) as AIConfig;
      if (!config.host?.trim() || !config.key?.trim() || !config.model?.trim()) {
        return null;
      }
      return { ...config, name };
    } catch {
      return null;
    }
  }

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

  /** 工具调用前是否发送模型返回的 content */
  async getToolCallContentSwitch(guid: string): Promise<string | null> {
    return (await this.redis.get(`ai:tool_call_content:switch:${guid}`)) || "0";
  }

  /** 设置工具调用前 content 发送开关状态 */
  async setToolCallContentSwitch(
    guid: string,
    enable: boolean,
  ): Promise<void> {
    await this.redis.set(
      `ai:tool_call_content:switch:${guid}`,
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

  /** 获取图床开关状态 */
  async getImageBedSwitch(guid?: string): Promise<string> {
    const globalValue = await this.redis.get("ai:image_bed:switch:global");
    if (globalValue !== null) {
      return globalValue;
    }
    if (guid) {
      const legacyValue = await this.redis.get(`ai:image_bed:switch:${guid}`);
      if (legacyValue !== null) {
        return legacyValue;
      }
    }
    return "1";
  }

  /** 设置图床开关状态 */
  async setImageBedSwitch(enable: boolean): Promise<void> {
    await this.redis.set("ai:image_bed:switch:global", enable ? "1" : "0");
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
      const history = JSON.parse(historyStr);
      const sanitizedHistory = this.sanitizeAIChatHistory(history);
      if (JSON.stringify(history) !== JSON.stringify(sanitizedHistory)) {
        await this.setAIChatHistory(guid, sanitizedHistory);
      }
      return sanitizedHistory;
    }
    return [];
  }

  /** 设置聊天历史 */
  async setAIChatHistory(guid: string, history: any[]): Promise<void> {
    const sanitizedHistory = this.sanitizeAIChatHistory(history);
    await this.redis.set(`ai:history:${guid}`, JSON.stringify(sanitizedHistory));
  }

  /** 添加聊天历史 */
  async addAIChatHistory(guid: string, data: any): Promise<any[]> {
    return this.addAIChatHistoryBatch(guid, [data]);
  }

  /** 批量添加聊天历史 */
  async addAIChatHistoryBatch(guid: string, dataList: any[]): Promise<any[]> {
    const history = await this.getAIChatHistory(guid);
    history.push(...dataList);
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
      const contextStatsKeys = await this.redis.keys(`ai:context_stats:*`);
      if (contextStatsKeys.length > 0) {
        await this.redis.del(...contextStatsKeys);
      }
      await this.clearAITransientState();
      return;
    }
    await this.clearAITransientState(guid);
    await this.redis.del(`ai:history:${guid}`, `ai:context_stats:${guid}`);
  }

  /** 记录当前会话上下文和 token 使用情况 */
  async recordAIContextStats(
    guid: string,
    input: AIContextStatsInput,
  ): Promise<AIContextStats> {
    const current = await this.getAIContextStats(guid);
    const promptTokens = input.promptTokens ?? 0;
    const completionTokens = input.completionTokens ?? 0;
    const totalTokens = input.totalTokens ?? promptTokens + completionTokens;
    const cachedTokens = input.cachedTokens ?? 0;
    const cacheMissTokens =
      input.cacheMissTokens ?? Math.max(promptTokens - cachedTokens, 0);

    const nextStats: AIContextStats = {
      ...input,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      cachedTokens: input.cachedTokens ?? null,
      cacheMissTokens: input.cacheMissTokens ?? null,
      guid,
      requestCount: (current?.requestCount ?? 0) + 1,
      updatedAt: Date.now(),
      totalPromptTokens: (current?.totalPromptTokens ?? 0) + promptTokens,
      totalCompletionTokens:
        (current?.totalCompletionTokens ?? 0) + completionTokens,
      totalTokensUsed: (current?.totalTokensUsed ?? 0) + totalTokens,
      totalCachedTokens: (current?.totalCachedTokens ?? 0) + cachedTokens,
      totalCacheMissTokens:
        (current?.totalCacheMissTokens ?? 0) + cacheMissTokens,
    };

    await this.redis.set(`ai:context_stats:${guid}`, JSON.stringify(nextStats));
    return nextStats;
  }

  /** 获取当前会话上下文和 token 使用情况 */
  async getAIContextStats(guid: string): Promise<AIContextStats | null> {
    const statsStr = await this.redis.get(`ai:context_stats:${guid}`);
    if (!statsStr) {
      return null;
    }
    return JSON.parse(statsStr) as AIContextStats;
  }

  /** 清理最后的N条聊天记录 */
  async clearLastNChatHistory(guid: string, n: number): Promise<void> {
    const history = await this.getAIChatHistory(guid);
    while (history.length > n) {
      history.shift();
    }
    await this.setAIChatHistory(guid, history);
  }

  /** 归档当前聊天历史 */
  async archiveAIChatHistory(
    guid: string,
    options?: {
      reason?: string;
      summary?: string;
      detail?: string;
    },
  ): Promise<ArchivedChatRecord | null> {
    const history = await this.getAIChatHistory(guid);
    if (!Array.isArray(history) || history.length === 0) {
      return null;
    }

    const transcript = this.buildChatHistoryTranscript(history);
    const id = Date.now().toString();
    const summary = this.trimText(
      options?.summary?.trim() || this.buildFallbackSummary(history, transcript),
      ARCHIVED_CHAT_SUMMARY_MAX_LENGTH,
    );
    const detail = this.trimText(
      options?.detail?.trim() || this.buildFallbackDetail(history, transcript),
      ARCHIVED_CHAT_DETAIL_MAX_LENGTH,
    );

    const record: ArchivedChatRecord = {
      id,
      guid,
      summary,
      detail,
      transcript,
      history: this.compactArchivedHistory(history),
      reason: options?.reason || "manual",
      createdAt: Date.now(),
    };
    const storedRecord = this.buildStoredArchivedChatRecord(record);

    await this.setSummary(guid, id, storedRecord.record.summary);
    await this.setSummaryDetail(guid, id, storedRecord.record.detail);
    await this.redis.set(
      this.getArchiveRecordKey(guid, id),
      storedRecord.serialized,
    );

    return storedRecord.record;
  }

  /** 清理工具循环等临时会话状态 */
  async clearAITransientState(guid?: string): Promise<void> {
    if (!guid) {
      const transientPrefixes = [
        "ai:tool_loop_processing:",
        "ai:guidance:",
        "ai:session:",
      ];
      for (const prefix of transientPrefixes) {
        const keys = await this.redis.keys(`${prefix}*`);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      }
      return;
    }

    const keyPatterns = [
      `ai:tool_loop_processing:${guid}`,
      `ai:tool_loop_processing:${guid}:*`,
      `ai:guidance:${guid}`,
      `ai:guidance:${guid}:*`,
      `ai:session:${guid}`,
    ];
    const keys = (
      await Promise.all(keyPatterns.map((pattern) => this.redis.keys(pattern)))
    ).flat();

    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
    return;
  }

  private getToolLoopStateKey(guid: string, platform?: string) {
    if (platform) {
      return `ai:tool_loop_processing:${guid}:${platform}`;
    }
    return `ai:tool_loop_processing:${guid}`;
  }

  private getGuidanceMessageKey(guid: string, platform?: string) {
    if (platform) {
      return `ai:guidance:${guid}:${platform}`;
    }
    return `ai:guidance:${guid}`;
  }

  /** 设置工具调用中的处理状态 */
  async setAIToolLoopProcessing(
    guid: string,
    processing: boolean,
    platform?: string,
  ): Promise<void> {
    if (processing) {
      const now = Date.now();
      const state: AIToolLoopState = {
        processing: true,
        startedAt: now,
        updatedAt: now,
      };
      await this.redis.set(
        this.getToolLoopStateKey(guid, platform),
        JSON.stringify(state),
        "EX",
        TOOL_LOOP_TTL_SECONDS,
      );
      return;
    }
    const keys = [
      this.getToolLoopStateKey(guid, platform),
      `ai:tool_loop_processing:${guid}`,
    ];
    await this.redis.del(...keys);
  }

  /** 获取工具调用中的处理状态 */
  async getAIToolLoopProcessing(guid: string, platform?: string): Promise<string> {
    const key = this.getToolLoopStateKey(guid, platform);
    let processing = await this.redis.get(key);
    if (!processing && platform) {
      processing = await this.redis.get(`ai:tool_loop_processing:${guid}`);
    }
    if (!processing) {
      return "0";
    }

    let state: AIToolLoopState | null = null;
    if (processing !== "1") {
      try {
        const parsed = JSON.parse(processing);
        if (parsed?.processing === true) {
          state = parsed as AIToolLoopState;
        }
      } catch {
        await this.clearAITransientState(guid);
        return "0";
      }

      const updatedAt = Number(state?.updatedAt || state?.startedAt || 0);
      if (!updatedAt || Date.now() - updatedAt > TOOL_LOOP_STALE_MS) {
        await this.clearAITransientState(guid);
        return "0";
      }
    }

    const ttl = await this.redis.ttl(key);
    if (ttl === -1) {
      if (processing === "1") {
        await this.clearAITransientState(guid);
        return "0";
      }
      await this.redis.expire(key, TOOL_LOOP_TTL_SECONDS);
    }

    return "1";
  }

  /** 获取工具调用期间追加的引导消息 */
  async getAIGuidanceMessages(guid: string, platform?: string): Promise<any[]> {
    const key = this.getGuidanceMessageKey(guid, platform);
    let queueStr = await this.redis.get(key);
    if (!queueStr && platform) {
      queueStr = await this.redis.get(`ai:guidance:${guid}`);
    }
    if (!queueStr) {
      return [];
    }
    try {
      const queue = JSON.parse(queueStr);
      return Array.isArray(queue) ? queue : [];
    } catch {
      await this.clearAIGuidanceMessages(guid);
      return [];
    }
  }

  /** 追加工具调用期间的引导消息 */
  async addAIGuidanceMessage(
    guid: string,
    data: any,
    platform?: string,
  ): Promise<any[]> {
    const queue = await this.getAIGuidanceMessages(guid, platform);
    queue.push(data);
    await this.redis.set(
      this.getGuidanceMessageKey(guid, platform),
      JSON.stringify(queue),
      "EX",
      TOOL_LOOP_TTL_SECONDS,
    );
    return queue;
  }

  /** 提取并清空工具调用期间的引导消息 */
  async drainAIGuidanceMessages(
    guid: string,
    platform?: string,
  ): Promise<any[]> {
    const queue = await this.getAIGuidanceMessages(guid, platform);
    await this.clearAIGuidanceMessages(guid, platform);
    return queue;
  }

  /** 清空工具调用期间的引导消息 */
  async clearAIGuidanceMessages(guid: string, platform?: string): Promise<void> {
    const keys = [
      this.getGuidanceMessageKey(guid, platform),
      `ai:guidance:${guid}`,
    ];
    await this.redis.del(...keys);
  }

  /** 存储摘要,全局共享 */
  async setSummary(guid: string, id: string, summary: string): Promise<void> {
    await this.redis.set(
      `ai:summary:${guid}:${id}`,
      this.trimText(summary, ARCHIVED_CHAT_SUMMARY_MAX_LENGTH),
    );
  }
  /** 获取摘要 */
  async getSummary(guid: string, id: string): Promise<string | null> {
    return await this.redis.get(`ai:summary:${guid}:${id}`);
  }
  /** 获取所有摘要时间列表 */
  async getSummaryList(): Promise<{ id: string; summary: string }[]> {
    const keys = await this.redis.keys(`ai:summary:*`);
    const entries = await Promise.all(
      keys.map(async (key) => {
        const parts = key.split(":");
        const summary = await this.redis.get(key);
        return {
          id: `${parts[2]}:${parts[3]}`,
          summary: summary ?? "",
        };
      }),
    );
    return entries.sort((a, b) => b.id.localeCompare(a.id));
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
    await this.redis.set(
      `ai:summary_detail:${guid}:${id}`,
      this.trimText(detail, ARCHIVED_CHAT_DETAIL_MAX_LENGTH),
    );
  }
  /** 获取摘要中的详细内容 */
  async getSummaryDetail(guid: string, id: string): Promise<string | null> {
    return await this.redis.get(`ai:summary_detail:${guid}:${id}`);
  }
  /** 删除摘要中的详细内容 */
  async deleteSummaryDetail(guid: string, id: string): Promise<number> {
    return await this.redis.del(`ai:summary_detail:${guid}:${id}`);
  }

  /** 获取完整归档记录 */
  async getArchivedChatRecord(
    guid: string,
    id: string,
  ): Promise<ArchivedChatRecord | null> {
    const recordKey = this.getArchiveRecordKey(guid, id);
    const [rawSize, summary, detail] = await Promise.all([
      this.redis.strlen(recordKey),
      this.getSummary(guid, id),
      this.getSummaryDetail(guid, id),
    ]);

    if (rawSize <= 0) {
      return this.buildArchivedChatFallbackRecord(guid, id, summary, detail);
    }

    if (rawSize > ARCHIVED_CHAT_RECORD_MAX_PARSE_BYTES) {
      return this.buildArchivedChatFallbackRecord(guid, id, summary, detail);
    }

    const raw = await this.redis.get(recordKey);
    if (!raw) {
      return this.buildArchivedChatFallbackRecord(guid, id, summary, detail);
    }

    try {
      const parsed = JSON.parse(raw) as ArchivedChatRecord;
      return {
        ...parsed,
        transcript: this.trimText(
          parsed?.transcript || detail || "",
          ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH,
        ),
        detail: this.trimText(
          parsed?.detail || detail || "",
          2000,
        ),
        summary: this.trimText(
          parsed?.summary || summary || "无摘要",
          180,
        ),
        history: this.compactArchivedHistory(parsed?.history || []),
      };
    } catch {
      return this.buildArchivedChatFallbackRecord(guid, id, summary, detail);
    }
  }

  /** 获取归档记录列表 */
  async listArchivedChatRecords(
    guid?: string,
    limit = 20,
  ): Promise<ArchivedChatRecord[]> {
    const merged = new Map<string, ArchivedChatRecord>();
    const summaryPattern = guid ? `ai:summary:${guid}:*` : "ai:summary:*";
    const summaryKeys = await this.redis.keys(summaryPattern);
    for (const key of summaryKeys) {
      const [, , summaryGuid, summaryId] = key.split(":");
      const [summary, detail] = await Promise.all([
        this.redis.get(key),
        this.getSummaryDetail(summaryGuid, summaryId),
      ]);
      const record = this.buildArchivedChatFallbackRecord(
        summaryGuid,
        summaryId,
        summary,
        detail,
      );
      if (record) {
        merged.set(`${summaryGuid}:${summaryId}`, record);
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /** 搜索归档聊天记录 */
  async searchArchivedChatRecords(
    query: string,
    options?: {
      guid?: string;
      limit?: number;
    },
  ): Promise<ArchivedChatSearchResult[]> {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    const records = await this.listArchivedChatRecords(options?.guid, 200);
    return records
      .map((record) => ({
        ...record,
        score: this.scoreArchivedChatRecord(record, normalized),
      }))
      .filter((record) => record.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.createdAt - a.createdAt;
      })
      .slice(0, options?.limit || 5);
  }

  /** 获取与当前消息最相关的历史记忆上下文 */
  async getRelevantMemoryContext(
    guid: string,
    userKey: string,
    query: string,
    limit = 3,
  ): Promise<string> {
    const blocks: string[] = [];
    const userMemory = userKey ? await this.getUserData(userKey) : null;
    if (userMemory) {
      blocks.push(`用户长期记忆:\n${this.trimText(userMemory, 500)}`);
    }

    const normalizedQuery = query.trim();
    if (normalizedQuery) {
      const scopedRecords = await this.searchArchivedChatRecords(normalizedQuery, {
        guid,
        limit,
      });
      const records = [...scopedRecords];

      if (records.length < limit) {
        const globalRecords = await this.searchArchivedChatRecords(normalizedQuery, {
          limit: limit * 2,
        });
        for (const record of globalRecords) {
          if (records.some((item) => item.guid === record.guid && item.id === record.id)) {
            continue;
          }
          records.push(record);
          if (records.length >= limit) {
            break;
          }
        }
      }

      const fallbackRecords =
        records.length === 0 &&
        /(之前|上次|刚才|还记得|继续|前面| earlier |before|remember)/i.test(
          normalizedQuery,
        )
          ? await this.listArchivedChatRecords(guid, Math.min(limit, 2))
          : [];

      const finalRecords = (records.length > 0 ? records : fallbackRecords).slice(
        0,
        limit,
      );

      if (finalRecords.length > 0) {
        blocks.push(
          [
            "相关历史归档:",
            ...finalRecords.map((record) => {
              const scope = record.guid === guid ? "当前会话" : `其他会话(${record.guid})`;
              return `- ${scope} / 归档ID:${record.id} / 摘要:${this.trimText(record.summary || "无摘要", 120)} / 详情:${this.trimText(record.detail || record.transcript || "无详情", 220)}`;
            }),
          ].join("\n"),
        );
      }
    }

    return blocks.join("\n\n").trim();
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
    const workspacePath = path.resolve(process.cwd(), `public/sandbox/workspaces/groups/${groupId}`);
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }

    const config = {
      containerName,
      image,
      memory: containerConf.memory || "256m",
      cpus: containerConf.cpus || "0.5",
      pidsLimit: containerConf.pidsLimit || 64,
      networkMode: containerConf.networkMode || "none",
      workspacePath,
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
    const workspacePath = path.resolve(process.cwd(), `public/sandbox/workspaces/${userId}`);
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }

    const config = {
      containerName,
      image,
      memory: containerConf.memory || "128m",
      cpus: containerConf.cpus || "0.25",
      pidsLimit: containerConf.pidsLimit || 32,
      networkMode: containerConf.networkMode || "none",
      workspacePath,
    };
    await this.setUserContainer(userId, config);
    return config;
  }

  /** 初始化用户 exec 环境（群聊默认群容器，私聊默认用户容器） */
  async initExecEnv(groupId: string, userId: string): Promise<Record<string, any>> {
    const existing = await this.getExecEnv(groupId, userId);
    if (existing) return existing;

    if (groupId === "private") {
      const userConfig = await this.ensureUserContainer(userId);
      await this.setExecEnv("private", userId, { ...userConfig, type: "user" });
      return userConfig;
    } else {
      const groupConfig = await this.ensureGroupContainer(groupId);
      await this.setExecEnv(groupId, userId, { ...groupConfig, type: "group" });
      return groupConfig;
    }
  }

  /** 切换到群容器 */
  async switchToGroupContainer(groupId: string, userId: string): Promise<Record<string, any>> {
    const groupConfig = await this.ensureGroupContainer(groupId);
    await this.setExecEnv(groupId, userId, { ...groupConfig, type: "group" });
    return groupConfig;
  }

  /** 切换到用户容器 */
  async switchToUserContainer(groupId: string, userId: string): Promise<Record<string, any>> {
    const userConfig = await this.ensureUserContainer(userId);
    await this.setExecEnv(groupId, userId, { ...userConfig, type: "user" });
    return userConfig;
  }

  /** 切换到系统环境 */
  async switchToSystemEnv(groupId: string, userId: string): Promise<void> {
    await this.setExecEnv(groupId, userId, { type: "system" });
  }

  /** 切换到远程节点环境 */
  async switchToRemoteEnv(groupId: string, userId: string, nodeName: string): Promise<void> {
    await this.setExecEnv(groupId, userId, { type: "remote", nodeName });
  }

  /** 切换到 Singularity 环境 */
  async switchToSingularityEnv(groupId: string, userId: string, nodeName: string, image?: string): Promise<void> {
    await this.setExecEnv(groupId, userId, { type: "singularity", nodeName, singularityImage: image });
  }

  /** 判断是否为超级管理员 */
  isSuperAdmin(userId: string): boolean {
    const configValue = getConfigValue();
    const superAdmins = configValue.aiChat?.superAdmin || [];
    return superAdmins.includes(userId);
  }

  /** 获取所有容器配置 key */
  async getAllContainerKeys(): Promise<string[]> {
    const groupKeys = await this.redis.keys("ai:container:group:*");
    const userKeys = await this.redis.keys("ai:container:user:*");
    return [...groupKeys, ...userKeys];
  }

  /** 删除指定容器配置 */
  async deleteContainer(key: string): Promise<void> {
    await this.redis.del(key);
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
    const tools = await this.getToolDefinitions();
    const status: Record<string, string> = {};
    for (const tool of tools) {
      const toolName = tool.type === "function" ? tool.function.name : "";
      status[toolName] = await this.getToolStatus(guid, toolName);
    }
    return status;
  }

  // 获取所有可用工具,返回完整工具
  async getAvailableTools(guid: string): Promise<any[]> {
    const tools = await this.getToolDefinitions();
    const toolStatus = await this.getAllToolStatus(guid);
    const availableTools = tools.filter((tool) => {
      const toolName = tool.type === "function" ? tool.function.name : "";
      return !toolStatus[toolName] || toolStatus[toolName] === "0";
    });
    return availableTools;
  }

  /** 获取渲染精度 (中:80%, 高:100%, 超高:120%) */
  async getRenderPrecision(guid: string): Promise<number> {
    const val = await this.redis.get(`ai:render_precision:${guid}`);
    if (val === "中") return 0.8;
    if (val === "超高") return 1.2;
    return 1.0;
  }

  /** 设置渲染精度 */
  async setRenderPrecision(guid: string, level: string): Promise<void> {
    await this.redis.set(`ai:render_precision:${guid}`, level);
  }

  /** 装载工具 */
  async loadTools(guid: string): Promise<string[]> {
    const tools = await this.getToolDefinitions();
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
