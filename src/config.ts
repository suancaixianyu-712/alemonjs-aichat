import { randomUUID } from "node:crypto";
import { getConfigValue } from "alemonjs";
import { AIConfig } from "./types";
import { redis } from "./redis";
import {
  getAIToolLoopCurrentTool as readAIToolLoopCurrentTool,
  parseOwnedAIToolLoopState,
  type AIToolLoopState,
} from "./api/tool-loop-state";
import {
  buildRestartRecoveryTask,
  canConsumeRestartRecoveryTask,
  parseRestartRecoveryTask,
  RESTART_RECOVERY_TTL_SECONDS,
  type RestartRecoveryTask,
} from "./api/restart-recovery";
import { PM2_PROCESS_ID, PROCESS_INSTANCE_ID } from "./api/runtime-instance";
export type { RestartRecoveryTask } from "./api/restart-recovery";

export type ScheduledAITask = {
  id: string;
  guid: string;
  userID: string;
  platform: string;
  spaceId: string;
  isPrivate: boolean;
  prompt: string;
  runAt: number;
  repeat: "once" | "daily";
  createdAt: number;
};

export type HeartbeatTask = {
  guid: string;
  userID: string;
  platform: string;
  spaceId: string;
  isPrivate: boolean;
  mode: "daily" | "interval";
  value: string;
  nextRunAt: number;
  createdAt: number;
};

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

const TOOL_LOOP_TTL_SECONDS = 3600;
const TOOL_LOOP_STALE_MS = TOOL_LOOP_TTL_SECONDS * 1000;
export const AI_LOCKED_CONFIGS_KEY = "ai:locked:configs";
export const NEXT_USER_MESSAGE_SUBSCRIPTION_TTL_SECONDS = 600;
export const FOLLOWUP_WATCH_TTL_SECONDS = 60;
const FOLLOWUP_LOG_LIMIT = 40;
const FOLLOWUP_TEXT_LIMIT = 300;

export type FollowupMessageRecord = {
  userID: string;
  name: string;
  text: string;
  at: number;
};
export const DEFAULT_CAPI_CONTEXT_LIMIT = 512000;
const ARCHIVED_CHAT_SUMMARY_MAX_LENGTH = 240;
const ARCHIVED_CHAT_DETAIL_MAX_LENGTH = 4000;
const ARCHIVED_CHAT_MESSAGE_MAX_LENGTH = 1200;
const ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH = 12000;
const ARCHIVED_CHAT_HISTORY_PREVIEW_LIMIT = 12;
const ARCHIVED_CHAT_RECORD_MAX_STORE_BYTES = 128 * 1024;
const ARCHIVED_CHAT_RECORD_MAX_PARSE_BYTES = 1024 * 1024;

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
  redis: typeof redis;
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
                toolCall && (toolCall.function?.name || toolCall.name),
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

      for (
        let toolIndex = 0;
        toolIndex < normalizedToolCalls.length;
        toolIndex += 1
      ) {
        const toolCall = normalizedToolCalls[toolIndex];
        let foundIndex = followingToolMessages.findIndex(
          (toolMessage, candidateIndex) =>
            !usedToolIndexes.has(candidateIndex) &&
            String(toolMessage?.tool_call_id || "").trim() === toolCall.id,
        );

        if (
          foundIndex < 0 &&
          !usedToolIndexes.has(toolIndex) &&
          followingToolMessages[toolIndex]
        ) {
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

      if (
        allMatched &&
        matchedToolMessages.length === normalizedToolCalls.length
      ) {
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

  private trimLatestText(text: string, maxLength: number): string {
    const normalized = text.trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `...（较早记忆已省略，必要时调用 MemoryOperation 获取完整内容）\n${normalized.slice(-maxLength)}`;
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

    return history
      .slice(-ARCHIVED_CHAT_HISTORY_PREVIEW_LIMIT)
      .map((message) => {
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

        if (
          Array.isArray(message?.tool_calls) &&
          message.tool_calls.length > 0
        ) {
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
      return this.trimText(
        `共 ${history.length} 条消息，最近内容：${recent}`,
        180,
      );
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
    apiMode: "capi",
    useProxy: false,
    builtinTools: {
      enabled: true,
      overrides: {},
    },
    host: "",
    key: "",
    model: "",
    temperature: 0.7,
    max_tokens: 150,
    systemPrompt: "",
  };

  constructor(redisInstance?: typeof redis) {
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

  /** 获取 GPT 画图工具专用配置（复用 AI 列表中的接口地址与密钥） */
  async getGPTImageConfig(): Promise<{
    aiName: string;
    model: string;
  } | null> {
    const configStr = await this.redis.get("ai:tool:gptimage");
    if (!configStr) return null;
    try {
      const config = JSON.parse(configStr) as Record<string, unknown>;
      if (
        typeof config.aiName !== "string" ||
        !config.aiName.trim() ||
        typeof config.model !== "string" ||
        !config.model.trim()
      ) {
        return null;
      }
      return {
        aiName: config.aiName.trim(),
        model: config.model.trim(),
      };
    } catch {
      return null;
    }
  }

  /** 设置 GPT 画图工具专用配置 */
  async setGPTImageConfig(aiName: string, model: string): Promise<void> {
    await this.redis.set(
      "ai:tool:gptimage",
      JSON.stringify({ aiName: aiName.trim(), model: model.trim() }),
    );
  }

  /** 获取 Grok 画图/修图工具专用配置（复用 AI 列表中的接口地址与密钥） */
  async getGrokImageConfig(): Promise<{
    aiName: string;
    model: string;
  } | null> {
    const configStr = await this.redis.get("ai:tool:grokimage");
    if (!configStr) return null;
    try {
      const config = JSON.parse(configStr) as Record<string, unknown>;
      if (
        typeof config.aiName !== "string" ||
        !config.aiName.trim() ||
        typeof config.model !== "string" ||
        !config.model.trim()
      ) {
        return null;
      }
      return {
        aiName: config.aiName.trim(),
        model: config.model.trim(),
      };
    } catch {
      return null;
    }
  }

  /** 设置 Grok 画图/修图工具专用配置 */
  async setGrokImageConfig(aiName: string, model: string): Promise<void> {
    await this.redis.set(
      "ai:tool:grokimage",
      JSON.stringify({ aiName: aiName.trim(), model: model.trim() }),
    );
  }

  /**
   * 获取识图/OCR 专用 AI 完整配置
   * 从厂商模型列表中解析，用于纯文本模型的看图描述
   */
  async getOCRAIConfig(
    guid: string,
  ): Promise<(AIConfig & { name: string }) | null> {
    const name = await this.getOCRAIName(guid);
    if (!name) {
      return null;
    }
    const config = await this.getAIListConfig(name);
    if (!config) {
      return null;
    }
    if (!config.host?.trim() || !config.key?.trim() || !config.model?.trim()) {
      return null;
    }
    return { ...config, name };
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
  async setToolCallContentSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(
      `ai:tool_call_content:switch:${guid}`,
      enable ? "1" : "0",
    );
  }

  /** 文件消息处理开关状态（默认开启） */
  async getFileMessageSwitch(guid: string): Promise<string | null> {
    return (await this.redis.get(`ai:file_message:switch:${guid}`)) || "1";
  }

  /** 设置文件消息处理开关状态 */
  async setFileMessageSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:file_message:switch:${guid}`, enable ? "1" : "0");
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
  /** 读取单个 AI 配置是否开启代理，默认关闭。 */
  isAIProxyEnabled(config?: Pick<AIConfig, "useProxy"> | null): boolean {
    return config?.useProxy === true;
  }

  /** 工具调用是否强制走全局 httpProxy。默认关闭，与单个 AI 的代理开关互不影响。 */
  async getToolProxySwitch(): Promise<string> {
    return (await this.redis.get("ai:tool_proxy:switch")) || "0";
  }

  /** 设置工具调用代理开关。开启后语音、画图等工具请求走 aichat.httpProxy。 */
  async setToolProxySwitch(enable: boolean): Promise<void> {
    await this.redis.set("ai:tool_proxy:switch", enable ? "1" : "0");
  }

  /**
   * 工具请求是否走代理。
   * 单个 AI 配置已开启代理，或全局工具代理已开启，任一成立即走代理。
   */
  async isToolProxyEnabled(
    config?: Pick<AIConfig, "useProxy"> | null,
  ): Promise<boolean> {
    if (this.isAIProxyEnabled(config)) return true;
    return (await this.getToolProxySwitch()) === "1";
  }

  /**
   * 修改当前会话 AI 的代理开关，并同步回该 AI 的持久化配置。
   * 这样切到别的配置再切回来，仍保留各自的开关。
   */
  async setCurrentAIProxy(
    guid: string,
    enable: boolean,
  ): Promise<AIConfig | null> {
    const currentConfig = await this.getAIConfig(guid);
    if (!currentConfig.host || !currentConfig.key || !currentConfig.model) {
      return null;
    }

    const currentAI = await this.getCurrentAI(guid);
    const separatorIndex = currentAI.indexOf("/");
    if (separatorIndex > 0) {
      const provider = currentAI.slice(0, separatorIndex) as NonNullable<
        AIConfig["provider"]
      >;
      const name = currentAI.slice(separatorIndex + 1);
      const providers: NonNullable<AIConfig["provider"]>[] = [
        "deepseek",
        "openai",
        "grok",
        "other",
      ];
      if (providers.includes(provider) && name) {
        const savedConfig = await this.getAIListConfig(currentAI);
        if (savedConfig) {
          await this.setProviderAIModel(provider, name, {
            ...savedConfig,
            useProxy: enable,
          });
        }
      }
    }

    const nextConfig = { ...currentConfig, useProxy: enable };
    await this.setAIConfig(guid, nextConfig);
    return nextConfig;
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

  /** 将旧版 AI 列表一次性迁移到带厂商 ID 的新结构。 */
  private async migrateLegacyAIModels(): Promise<void> {
    const migrationKey = "ai:migration:provider-models:v1";
    if (await this.redis.exists(migrationKey)) return;

    const legacyKeys = await this.redis.keys("ai:list:*");
    const migratedNames = new Set<string>();
    for (const legacyKey of legacyKeys) {
      const name = legacyKey.replace("ai:list:", "");
      const configStr = await this.redis.get(legacyKey);
      if (!name || !configStr) continue;
      try {
        const config = JSON.parse(configStr) as AIConfig;
        await this.setProviderAIModel("other", name, {
          ...config,
          provider: "other",
        });
        migratedNames.add(name);
      } catch {
        continue;
      }
    }

    const currentAIKeys = await this.redis.keys("ai:currentAI:*");
    for (const currentAIKey of currentAIKeys) {
      const name = await this.redis.get(currentAIKey);
      if (name && migratedNames.has(name)) {
        await this.redis.set(currentAIKey, `other/${name}`);
      }
    }

    const currentConfigKeys = await this.redis.keys("ai:config:*");
    for (const currentConfigKey of currentConfigKeys) {
      const configStr = await this.redis.get(currentConfigKey);
      if (!configStr) continue;
      try {
        const config = JSON.parse(configStr) as AIConfig;
        if (!config.provider && config.host && config.key && config.model) {
          await this.redis.set(
            currentConfigKey,
            JSON.stringify({ ...config, provider: "other" }),
          );
        }
      } catch {
        continue;
      }
    }

    if (legacyKeys.length > 0) {
      await this.redis.del(...legacyKeys);
    }
    await this.redis.set(migrationKey, "1");
  }

  /** 为旧 AI 配置补充别名，默认使用其实际模型名。 */
  private async migrateAIModelAliases(): Promise<void> {
    const migrationKey = "ai:migration:model-aliases:v1";
    if (await this.redis.exists(migrationKey)) return;

    const modelKeys = await this.redis.keys("ai:model:*");
    for (const modelKey of modelKeys) {
      const configStr = await this.redis.get(modelKey);
      if (!configStr) continue;
      try {
        const config = JSON.parse(configStr) as AIConfig;
        if (!config.alias?.trim() && config.model?.trim()) {
          await this.redis.set(
            modelKey,
            JSON.stringify({ ...config, alias: config.model.trim() }),
          );
        }
      } catch {
        continue;
      }
    }

    const currentConfigKeys = await this.redis.keys("ai:config:*");
    for (const currentConfigKey of currentConfigKeys) {
      const configStr = await this.redis.get(currentConfigKey);
      if (!configStr) continue;
      try {
        const config = JSON.parse(configStr) as AIConfig;
        if (!config.alias?.trim() && config.model?.trim()) {
          await this.redis.set(
            currentConfigKey,
            JSON.stringify({ ...config, alias: config.model.trim() }),
          );
        }
      } catch {
        continue;
      }
    }

    await this.redis.set(migrationKey, "1");
  }

  /** 获取AI列表 */
  async getAIList(): Promise<string[]> {
    await this.migrateLegacyAIModels();
    await this.migrateAIModelAliases();
    const providerKeys = await this.redis.keys("ai:model:*");
    const providerNames = providerKeys.flatMap((key) => {
      const provider = key.split(":")[2];
      const encodedName = key.split(":").slice(3).join(":");
      if (!provider || !encodedName) return [];
      try {
        return [`${provider}/${decodeURIComponent(encodedName)}`];
      } catch {
        return [];
      }
    });
    return [...new Set(providerNames)].sort((a, b) => a.localeCompare(b));
  }

  /** 获取被主人锁定、仅主人和网页端可使用的 AI 配置。 */
  async getLockedAIList(): Promise<string[]> {
    return (await this.redis.smembers(AI_LOCKED_CONFIGS_KEY)).sort((a, b) =>
      a.localeCompare(b),
    );
  }

  /** 判断 AI 配置是否已被主人锁定。 */
  async isAILocked(name: string): Promise<boolean> {
    return (await this.redis.sismember(AI_LOCKED_CONFIGS_KEY, name)) === 1;
  }

  /** 批量锁定 AI 配置。 */
  async lockAI(names: string[]): Promise<void> {
    const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (uniqueNames.length > 0) {
      await this.redis.sadd(AI_LOCKED_CONFIGS_KEY, ...uniqueNames);
      // 锁定后移除此前选用这些配置的会话；主人重新切换后才能授权该群使用。
      const selectedKeys = await this.redis.keys("ai:currentAI:*");
      for (const key of selectedKeys) {
        if (uniqueNames.includes((await this.redis.get(key)) || "")) {
          await this.redis.del(key);
          await this.setAIConfig(key.slice("ai:currentAI:".length), db.defaultAIConfig);
        }
      }
    }
  }

  /** 群内当前由主人选用的锁定 AI 对全群开放；私聊仍只允许主人。 */
  async canUseLockedAI(guid: string, isGroup: boolean, name: string): Promise<boolean> {
    return !await this.isAILocked(name) ||
      (isGroup && (await this.getCurrentAI(guid)) === name);
  }

  /** 批量解除 AI 配置锁定。 */
  async unlockAI(names: string[]): Promise<void> {
    const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (uniqueNames.length > 0) {
      await this.redis.srem(AI_LOCKED_CONFIGS_KEY, ...uniqueNames);
    }
  }

  /** 获取带厂商 ID 的 AI 模型配置。 */
  async getAIListConfig(name: string): Promise<AIConfig | null> {
    await this.migrateLegacyAIModels();
    await this.migrateAIModelAliases();
    const providerKeys = await this.redis.keys("ai:model:*");
    const providerKey = providerKeys.find((key) => {
      const provider = key.split(":")[2];
      const encodedName = key.split(":").slice(3).join(":");
      try {
        const modelName = decodeURIComponent(encodedName);
        return `${provider}/${modelName}` === name || modelName === name;
      } catch {
        return false;
      }
    });
    if (providerKey) {
      const providerConfigStr = await this.redis.get(providerKey);
      if (providerConfigStr) {
        return JSON.parse(providerConfigStr) as AIConfig;
      }
    }

    return null;
  }

  /** 获取 AI 标识对应的展示名称，优先使用别名。 */
  async getAIDisplayName(
    name: string,
    includeProvider = true,
  ): Promise<string> {
    const separatorIndex = name.indexOf("/");
    const provider = separatorIndex > 0 ? name.slice(0, separatorIndex) : "";
    const storedName = separatorIndex > 0 ? name.slice(separatorIndex + 1) : name;
    const config = await this.getAIListConfig(name);
    const alias = config?.alias?.trim() || config?.model?.trim() || storedName;
    const model = config?.model?.trim();
    const label = model && model !== alias ? `${alias}（${model}）` : alias;
    return includeProvider && provider ? `${provider}/${label}` : label;
  }

  /** 批量获取 AI 列表的展示名称，顺序和内部标识保持一致。 */
  async getAIDisplayNames(
    names: string[],
    includeProvider = true,
  ): Promise<string[]> {
    return Promise.all(
      names.map((name) => this.getAIDisplayName(name, includeProvider)),
    );
  }

  /** 按厂商保存模型；键和值中都保留厂商 ID。 */
  async setProviderAIModel(
    provider: NonNullable<AIConfig["provider"]>,
    name: string,
    config: AIConfig,
  ): Promise<void> {
    const storageKey = `ai:model:${provider}:${encodeURIComponent(name)}`;
    await this.redis.set(
      storageKey,
      JSON.stringify({
        ...config,
        alias: config.alias?.trim() || config.model?.trim() || name.trim(),
        provider,
      }),
    );
  }

  /** 获取某个厂商保存的首个模型配置，供厂商专属能力复用凭据。 */
  async getProviderAIConfig(
    provider: NonNullable<AIConfig["provider"]>,
  ): Promise<AIConfig | null> {
    await this.migrateLegacyAIModels();
    const keys = await this.redis.keys(`ai:model:${provider}:*`);
    if (keys.length === 0) return null;
    const configStr = await this.redis.get(keys[0]);
    return configStr ? (JSON.parse(configStr) as AIConfig) : null;
  }

  /** 新增AI配置并切换 */
  async addAI(
    guid: string,
    name: string,
    host: string,
    key: string,
    model: string,
    provider: NonNullable<AIConfig["provider"]> = "other",
    apiMode: NonNullable<AIConfig["apiMode"]> = "capi",
    alias = name,
  ): Promise<void> {
    const defaultConfig = await this.getAIConfig();
    const aiConfig = {
      ...defaultConfig,
      host,
      key,
      model,
      alias: alias.trim() || model.trim() || name.trim(),
      provider,
      apiMode,
    };
    await this.setProviderAIModel(provider, name, aiConfig);
    await this.switchAI(guid, `${provider}/${name}`);
  }

  /** 删除AI配置 */
  async deleteAI(name: string): Promise<boolean> {
    await this.migrateLegacyAIModels();
    const providerKeys = await this.redis.keys("ai:model:*");
    const matchedProviderKeys = providerKeys.filter((key) => {
      const provider = key.split(":")[2];
      const encodedName = key.split(":").slice(3).join(":");
      try {
        const modelName = decodeURIComponent(encodedName);
        return `${provider}/${modelName}` === name || modelName === name;
      } catch {
        return false;
      }
    });
    if (matchedProviderKeys.length === 0) {
      console.log("删除失败, 无此模型");
      return false;
    }
    const matchedAIIdentifiers = matchedProviderKeys.flatMap((key) => {
      const provider = key.split(":")[2];
      const encodedName = key.split(":").slice(3).join(":");
      if (!provider || !encodedName) return [];
      try {
        return [`${provider}/${decodeURIComponent(encodedName)}`];
      } catch {
        return [];
      }
    });
    await this.redis.del(...matchedProviderKeys);
    await this.unlockAI(matchedAIIdentifiers);
    return true;
  }

  /** 切换AI */
  async switchAI(guid: string, name: string): Promise<AIConfig | null> {
    const aiConfig = await this.getAIListConfig(name);
    if (!aiConfig) {
      console.log("切换失败, 无此AI");
      await this.setAIConfig(guid, db.defaultAIConfig);
      return null;
    }
    const currentConfig = await this.getAIConfig(guid);
    aiConfig.systemPrompt = currentConfig.systemPrompt;
    await this.setAIConfig(guid, aiConfig);

    // 记录当前切换的ai名字
    await this.redis.set(`ai:currentAI:${guid}`, name);
    return aiConfig;
  }

  /**
   * 切换当前 AI 配置使用的模型 ID，并同步回当前选中的模型配置。
   * 这样切换到其他 AI 后再切回来，仍会使用刚刚选择的模型 ID。
   */
  async switchCurrentAIModel(
    guid: string,
    model: string,
  ): Promise<AIConfig | null> {
    const modelID = model.trim();
    if (!modelID) return null;

    const currentConfig = await this.getAIConfig(guid);
    if (!currentConfig.host || !currentConfig.key || !currentConfig.model) {
      return null;
    }

    const currentAI = await this.getCurrentAI(guid);
    const separatorIndex = currentAI.indexOf("/");
    if (separatorIndex > 0) {
      const provider = currentAI.slice(0, separatorIndex) as NonNullable<
        AIConfig["provider"]
      >;
      const name = currentAI.slice(separatorIndex + 1);
      const providers: NonNullable<AIConfig["provider"]>[] = [
        "deepseek",
        "openai",
        "grok",
        "other",
      ];
      if (providers.includes(provider) && name) {
        const savedConfig = await this.getAIListConfig(currentAI);
        if (savedConfig) {
          await this.setProviderAIModel(provider, name, {
            ...savedConfig,
            model: modelID,
          });
        }
      }
    }

    const nextConfig = { ...currentConfig, model: modelID };
    await this.setAIConfig(guid, nextConfig);
    return nextConfig;
  }

  /** 切换当前 AI 使用的 API 协议，并同步回当前选中的模型配置。 */
  async switchCurrentAIAPI(
    guid: string,
    apiMode: NonNullable<AIConfig["apiMode"]>,
  ): Promise<AIConfig | null> {
    if (apiMode !== "capi" && apiMode !== "rapi") return null;

    const currentConfig = await this.getAIConfig(guid);
    if (!currentConfig.host || !currentConfig.key || !currentConfig.model) {
      return null;
    }

    const currentAI = await this.getCurrentAI(guid);
    const separatorIndex = currentAI.indexOf("/");
    if (separatorIndex > 0) {
      const provider = currentAI.slice(0, separatorIndex) as NonNullable<
        AIConfig["provider"]
      >;
      const name = currentAI.slice(separatorIndex + 1);
      const providers: NonNullable<AIConfig["provider"]>[] = [
        "deepseek",
        "openai",
        "grok",
        "other",
      ];
      if (providers.includes(provider) && name) {
        const savedConfig = await this.getAIListConfig(currentAI);
        if (savedConfig) {
          await this.setProviderAIModel(provider, name, {
            ...savedConfig,
            apiMode,
          });
        }
      }
    }

    const nextConfig = { ...currentConfig, apiMode };
    await this.setAIConfig(guid, nextConfig);
    return nextConfig;
  }

  /** 修改当前 AI 的厂商内置工具开关，并同步回该 AI 的持久化配置。 */
  async switchCurrentAIBuiltinTools(
    guid: string,
    enable: boolean,
    tool?: string,
  ): Promise<AIConfig | null> {
    const currentConfig = await this.getAIConfig(guid);
    if (!currentConfig.host || !currentConfig.key || !currentConfig.model) {
      return null;
    }

    const currentTools = currentConfig.builtinTools ?? {};
    const builtinTools = tool
      ? {
          enabled: currentTools.enabled !== false,
          overrides: {
            ...(currentTools.overrides ?? {}),
            [tool]: enable,
          },
        }
      : {
          enabled: enable,
          overrides: {},
        };
    const nextConfig: AIConfig = { ...currentConfig, builtinTools };

    const currentAI = await this.getCurrentAI(guid);
    const separatorIndex = currentAI.indexOf("/");
    if (separatorIndex > 0) {
      const provider = currentAI.slice(0, separatorIndex) as NonNullable<
        AIConfig["provider"]
      >;
      const name = currentAI.slice(separatorIndex + 1);
      const providers: NonNullable<AIConfig["provider"]>[] = [
        "deepseek",
        "openai",
        "grok",
        "other",
      ];
      if (providers.includes(provider) && name) {
        const savedConfig = await this.getAIListConfig(currentAI);
        if (savedConfig) {
          await this.setProviderAIModel(provider, name, {
            ...savedConfig,
            builtinTools,
          });
        }
      }
    }

    await this.setAIConfig(guid, nextConfig);
    return nextConfig;
  }

  /** 获取当前使用的AI名称 */
  async getCurrentAI(guid: string): Promise<string> {
    return (await this.redis.get(`ai:currentAI:${guid}`)) || "";
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
    await this.redis.set(
      `ai:history:${guid}`,
      JSON.stringify(sanitizedHistory),
    );
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
      options?.summary?.trim() ||
        this.buildFallbackSummary(history, transcript),
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
        "ai:next_user_message:",
        "ai:followup:active:",
        "ai:followup:watch:",
        "ai:followup:log:",
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
      `ai:next_user_message:${guid}:*`,
      `ai:followup:active:${guid}`,
      `ai:followup:active:${guid}:*`,
      `ai:followup:watch:${guid}:*`,
      `ai:followup:log:${guid}`,
      `ai:followup:log:${guid}:*`,
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

  private getNextUserMessageSubscriptionKey(
    guid: string,
    userID: string,
    platform?: string,
  ) {
    return `ai:next_user_message:${guid}:${platform || "default"}:${userID}`;
  }

  /** 订阅指定群聊用户的下一条非命令消息 */
  async subscribeNextUserMessage(
    guid: string,
    userID: string,
    platform?: string,
  ): Promise<void> {
    await this.redis.set(
      this.getNextUserMessageSubscriptionKey(guid, userID, platform),
      "1",
      "EX",
      NEXT_USER_MESSAGE_SUBSCRIPTION_TTL_SECONDS,
    );
  }

  /** 原子消费一次订阅，确保同一条订阅最多触发一条消息 */
  async consumeNextUserMessageSubscription(
    guid: string,
    userID: string,
    platform?: string,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      `
      local value = redis.call("GET", KEYS[1])
      if value then
        redis.call("DEL", KEYS[1])
        return 1
      end
      return 0
      `,
      1,
      this.getNextUserMessageSubscriptionKey(guid, userID, platform),
    );
    return Number(result) === 1;
  }

  private getFollowupActiveKey(guid: string, platform?: string) {
    return `ai:followup:active:${guid}:${platform || "default"}`;
  }

  private getFollowupWatchKey(
    guid: string,
    userID: string,
    platform?: string,
  ) {
    return `ai:followup:watch:${guid}:${platform || "default"}:${userID}`;
  }

  private getFollowupLogKey(guid: string, platform?: string) {
    return `ai:followup:log:${guid}:${platform || "default"}`;
  }

  /**
   * AI 实际回复后，或一分钟窗口内有人新触发时，记下这个用户。
   * 同一群共用一份一分钟消息记录，不按人各开一份。
   */
  async markFollowupWatch(
    guid: string,
    userID: string,
    platform?: string,
  ): Promise<void> {
    if (!guid || !userID) return;
    const ttl = FOLLOWUP_WATCH_TTL_SECONDS;
    await this.redis
      .pipeline()
      .set(this.getFollowupWatchKey(guid, userID, platform), "1", "EX", ttl)
      .set(this.getFollowupActiveKey(guid, platform), "1", "EX", ttl)
      .expire(this.getFollowupLogKey(guid, platform), ttl)
      .exec();
  }

  async isFollowupWindowActive(
    guid: string,
    platform?: string,
  ): Promise<boolean> {
    if (!guid) return false;
    return (
      (await this.redis.get(this.getFollowupActiveKey(guid, platform))) === "1"
    );
  }

  async isFollowupUserWatched(
    guid: string,
    userID: string,
    platform?: string,
  ): Promise<boolean> {
    if (!guid || !userID) return false;
    return (
      (await this.redis.get(
        this.getFollowupWatchKey(guid, userID, platform),
      )) === "1"
    );
  }

  /** 窗口开启时追加一条群消息。只保留最近一分钟、最多 40 条。 */
  async appendFollowupMessage(
    guid: string,
    platform: string | undefined,
    entry: { userID: string; name: string; text: string },
  ): Promise<void> {
    if (!guid) return;
    if (!(await this.isFollowupWindowActive(guid, platform))) return;
    const text = String(entry.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, FOLLOWUP_TEXT_LIMIT);
    const record: FollowupMessageRecord = {
      userID: String(entry.userID || ""),
      name: String(entry.name || entry.userID || "未知").slice(0, 80),
      text: text || "[非文本消息]",
      at: Date.now(),
    };
    const key = this.getFollowupLogKey(guid, platform);
    await this.redis
      .pipeline()
      .rpush(key, JSON.stringify(record))
      .ltrim(key, -FOLLOWUP_LOG_LIMIT, -1)
      .expire(key, FOLLOWUP_WATCH_TTL_SECONDS)
      .exec();
  }

  async getFollowupMessages(
    guid: string,
    platform?: string,
  ): Promise<FollowupMessageRecord[]> {
    if (!guid) return [];
    const rows = await this.redis.lrange(
      this.getFollowupLogKey(guid, platform),
      0,
      -1,
    );
    const cutoff = Date.now() - FOLLOWUP_WATCH_TTL_SECONDS * 1000;
    const messages: FollowupMessageRecord[] = [];
    for (const row of rows) {
      try {
        const item = JSON.parse(row) as FollowupMessageRecord;
        if (!item || typeof item.at !== "number" || item.at < cutoff) continue;
        if (!item.text) continue;
        messages.push(item);
      } catch {
        continue;
      }
    }
    return messages;
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

  /** 获取聊天频率限制（0 表示不限制），默认每分钟 2 条 */
  async getChatRateLimit(guid: string): Promise<number> {
    const stored = Number(await this.redis.get(`ai:chat_rate_limit:${guid}`));
    return Number.isInteger(stored) && stored > 0 ? stored : 2;
  }

  /** 设置聊天频率限制（limit<=0 表示关闭限制） */
  async setChatRateLimit(guid: string, limit: number): Promise<void> {
    const validLimit = Math.max(0, Math.floor(Number(limit) || 0));
    await this.redis.set(`ai:chat_rate_limit:${guid}`, String(validLimit));
  }

  /** 检查并记录一次聊天频率（滑动窗口），返回本次是否允许 */
  async checkChatRateLimit(
    guid: string,
    userID: string,
    limit: number,
    windowSeconds = 60,
  ): Promise<boolean> {
    if (limit <= 0) return true;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const key = `ai:chat_rate_used:${guid}:${userID}`;
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
    const results = await this.redis
      .pipeline()
      .zremrangebyscore(key, 0, now - windowMs)
      .zadd(key, now, member)
      .zcard(key)
      .expire(key, windowSeconds * 2 + 60)
      .exec();
    const count = Number(results?.[2]?.[1] ?? 0);
    return count <= limit;
  }
  /** 设置工具调用中的处理状态 */
  async acquireAIToolLoop(
    guid: string,
    userID: string,
    platform?: string,
  ): Promise<boolean> {
    const now = Date.now();
    const state: AIToolLoopState = {
      processing: true,
      ownerId: PROCESS_INSTANCE_ID,
      userID,
      startedAt: now,
      updatedAt: now,
      toolStack: [],
    };
    const result = await this.redis.set(
      this.getToolLoopStateKey(guid, platform),
      JSON.stringify(state),
      "EX",
      TOOL_LOOP_TTL_SECONDS,
      "NX",
    );
    return result === "OK";
  }

  async releaseAIToolLoop(
    guid: string,
    userID: string,
    platform?: string,
  ): Promise<boolean> {
    const keys = [
      this.getToolLoopStateKey(guid, platform),
      `ai:tool_loop_processing:${guid}`,
    ].filter((key, index, values) => values.indexOf(key) === index);
    const released = await this.redis.eval(
      `
      local released = 0
      for _, key in ipairs(KEYS) do
        local value = redis.call("GET", key)
        if value and value ~= "1" then
          local ok, state = pcall(cjson.decode, value)
          if ok and tostring(state.userID or "") == ARGV[1] then
            redis.call("DEL", key)
            released = released + 1
          end
        end
      end
      return released
      `,
      keys.length,
      ...keys,
      userID,
    );
    return Number(released) > 0;
  }

  async setAIToolLoopProcessing(
    guid: string,
    processing: boolean,
    platform?: string,
    userID = "",
  ): Promise<void> {
    if (processing) {
      const now = Date.now();
      const state: AIToolLoopState = {
        processing: true,
        ownerId: PROCESS_INSTANCE_ID,
        userID,
        startedAt: now,
        updatedAt: now,
        toolStack: [],
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
  async getAIToolLoopState(
    guid: string,
    platform?: string,
  ): Promise<AIToolLoopState | null> {
    const key = this.getToolLoopStateKey(guid, platform);
    let processing = await this.redis.get(key);
    if (!processing && platform) {
      processing = await this.redis.get(`ai:tool_loop_processing:${guid}`);
    }
    if (!processing) return null;

    const state = parseOwnedAIToolLoopState(
      processing,
      PROCESS_INSTANCE_ID,
      TOOL_LOOP_STALE_MS,
    );
    if (!state) {
      await this.clearAITransientState(guid);
      return null;
    }
    const ttl = await this.redis.ttl(key);
    if (ttl === -1) await this.redis.expire(key, TOOL_LOOP_TTL_SECONDS);
    return state;
  }

  async getAIToolLoopProcessing(
    guid: string,
    platform?: string,
  ): Promise<string> {
    return (await this.getAIToolLoopState(guid, platform)) ? "1" : "0";
  }

  /** Push a tool name onto the active tool-loop stack (innermost = last). */
  async pushAIToolLoopTool(
    guid: string,
    toolName: string,
    platform?: string,
    userID = "",
  ): Promise<void> {
    const name = String(toolName || "").trim();
    if (!name) return;
    await this.mutateAIToolLoopState(guid, platform, userID, (state) => {
      state.toolStack = [...(state.toolStack || []), name];
    });
  }

  /**
   * Pop the innermost tool from the tool-loop stack.
   * If expectedTool is provided, only pops when it matches the top.
   */
  async popAIToolLoopTool(
    guid: string,
    platform?: string,
    userID = "",
    expectedTool?: string,
  ): Promise<void> {
    await this.mutateAIToolLoopState(guid, platform, userID, (state) => {
      const stack = [...(state.toolStack || [])];
      if (stack.length === 0) {
        state.toolStack = [];
        return;
      }
      const expected = String(expectedTool || "").trim();
      if (expected && stack[stack.length - 1] !== expected) {
        return;
      }
      stack.pop();
      state.toolStack = stack;
    });
  }

  getAIToolLoopCurrentTool(state: AIToolLoopState | null | undefined): string {
    return readAIToolLoopCurrentTool(state);
  }

  private async mutateAIToolLoopState(
    guid: string,
    platform: string | undefined,
    userID: string,
    mutator: (state: AIToolLoopState) => void,
  ): Promise<boolean> {
    const key = this.getToolLoopStateKey(guid, platform);
    const raw = await this.redis.get(key);
    if (!raw) return false;
    const current = parseOwnedAIToolLoopState(
      raw,
      PROCESS_INSTANCE_ID,
      TOOL_LOOP_STALE_MS,
    );
    if (!current) return false;
    if (userID && current.userID && current.userID !== userID) return false;
    const now = Date.now();
    const state: AIToolLoopState = {
      ...current,
      updatedAt: now,
      toolStack: [...(current.toolStack || [])],
    };
    mutator(state);
    await this.redis.set(
      key,
      JSON.stringify(state),
      "EX",
      TOOL_LOOP_TTL_SECONDS,
    );
    return true;
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
  async clearAIGuidanceMessages(
    guid: string,
    platform?: string,
  ): Promise<void> {
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
        detail: this.trimText(parsed?.detail || detail || "", 2000),
        summary: this.trimText(parsed?.summary || summary || "无摘要", 180),
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
      blocks.push(
        `用户长期记忆（优先展示最近记录）:\n${this.trimLatestText(userMemory, 2000)}`,
      );
    }

    const normalizedQuery = query.trim();
    if (normalizedQuery) {
      const scopedRecords = await this.searchArchivedChatRecords(
        normalizedQuery,
        {
          guid,
          limit,
        },
      );
      const records = [...scopedRecords];

      if (records.length < limit) {
        const globalRecords = await this.searchArchivedChatRecords(
          normalizedQuery,
          {
            limit: limit * 2,
          },
        );
        for (const record of globalRecords) {
          if (
            records.some(
              (item) => item.guid === record.guid && item.id === record.id,
            )
          ) {
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

      const finalRecords = (
        records.length > 0 ? records : fallbackRecords
      ).slice(0, limit);

      if (finalRecords.length > 0) {
        blocks.push(
          [
            "相关历史归档:",
            ...finalRecords.map((record) => {
              const scope =
                record.guid === guid ? "当前会话" : `其他会话(${record.guid})`;
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
  /** 原子追加用户长期记忆，避免模型重写时删减已有内容 */
  async appendUserData(userKey: string, value: string): Promise<void> {
    await this.redis.eval(
      `
      local current = redis.call("GET", KEYS[1])
      if current and string.len(current) > 0 then
        redis.call("SET", KEYS[1], current .. "\\n" .. ARGV[1])
      else
        redis.call("SET", KEYS[1], ARGV[1])
      end
      return 1
      `,
      1,
      `ai:user:${userKey}`,
      value,
    );
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

  /** 获取当前会话的 agent/服务器管理权限，默认关闭 */
  async getAgentSwitch(guid: string): Promise<string> {
    return (await this.redis.get(`ai:agent:switch:${guid}`)) || "0";
  }

  /** 设置当前会话的 agent/服务器管理权限 */
  async setAgentSwitch(guid: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:agent:switch:${guid}`, enable ? "1" : "0");
  }

  /** 获取是否通过接口获取 bot 信息（按平台，默认开启接口获取） */
  async getBotInfoSwitch(platform: string): Promise<string> {
    return (await this.redis.get(`ai:bot_info:switch:${platform}`)) || "1";
  }

  /** 设置是否通过接口获取 bot 信息（按平台） */
  async setBotInfoSwitch(platform: string, enable: boolean): Promise<void> {
    await this.redis.set(`ai:bot_info:switch:${platform}`, enable ? "1" : "0");
  }

  /** 创建定时 AI 任务 */
  async createScheduledAITask(
    input: Omit<ScheduledAITask, "id" | "createdAt">,
  ): Promise<ScheduledAITask> {
    const task: ScheduledAITask = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    await this.redis.hset("ai:scheduled_tasks", task.id, JSON.stringify(task));
    return task;
  }

  /** 获取定时 AI 任务 */
  async getScheduledAITasks(guid?: string): Promise<ScheduledAITask[]> {
    const values = await this.redis.hvals("ai:scheduled_tasks");
    return values
      .map((value) => {
        try {
          return JSON.parse(value) as ScheduledAITask;
        } catch {
          return null;
        }
      })
      .filter(
        (task): task is ScheduledAITask =>
          task !== null && (!guid || task.guid === guid),
      )
      .sort((a, b) => a.runAt - b.runAt);
  }

  /** 更新定时 AI 任务的下一次触发时间 */
  async updateScheduledAITask(task: ScheduledAITask): Promise<void> {
    await this.redis.hset("ai:scheduled_tasks", task.id, JSON.stringify(task));
  }

  /** 删除定时 AI 任务 */
  async deleteScheduledAITask(guid: string, taskID: string): Promise<boolean> {
    const task = (await this.getScheduledAITasks(guid)).find(
      (item) => item.id === taskID,
    );
    if (!task) return false;
    await this.redis.hdel("ai:scheduled_tasks", taskID);
    return true;
  }

  /** 获取当前会话的心跳任务 */
  async getHeartbeatTask(guid: string): Promise<HeartbeatTask | null> {
    const raw = await this.redis.get(`ai:heartbeat:${guid}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as HeartbeatTask;
    } catch {
      return null;
    }
  }

  /** 获取所有心跳任务，供轮询器使用 */
  async getAllHeartbeatTasks(): Promise<HeartbeatTask[]> {
    const keys = await this.redis.keys("ai:heartbeat:*");
    if (!keys.length) return [];
    const values = await this.redis.mget(...keys);
    return values
      .map((value) => {
        if (!value) return null;
        try {
          return JSON.parse(value) as HeartbeatTask;
        } catch {
          return null;
        }
      })
      .filter((task): task is HeartbeatTask => task !== null);
  }

  /** 设置或更新当前会话心跳 */
  async setHeartbeatTask(task: HeartbeatTask): Promise<void> {
    await this.redis.set(`ai:heartbeat:${task.guid}`, JSON.stringify(task));
  }

  /** 关闭当前会话心跳 */
  async clearHeartbeatTask(guid: string): Promise<void> {
    await this.redis.del(`ai:heartbeat:${guid}`);
  }

  /** 保存指令触发的当前进程重启恢复任务。 */
  async createRestartRecoveryTask(
    input: Omit<
      RestartRecoveryTask,
      "id" | "ownerId" | "createdAt" | "restartRecovery"
    >,
  ): Promise<RestartRecoveryTask> {
    const task = buildRestartRecoveryTask(input);
    await this.redis.set(
      `ai:restart_recovery:${task.id}`,
      JSON.stringify(task),
      "EX",
      RESTART_RECOVERY_TTL_SECONDS,
    );
    return task;
  }

  /** 原子消费全部待恢复任务，确保重启后至多续接一次。 */
  async consumeRestartRecoveryTasks(): Promise<RestartRecoveryTask[]> {
    const keys = await this.redis.keys("ai:restart_recovery:*");
    const tasks: RestartRecoveryTask[] = [];
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) continue;
      const task = parseRestartRecoveryTask(raw);
      if (
        task &&
        !canConsumeRestartRecoveryTask(
          task,
          PROCESS_INSTANCE_ID,
          PM2_PROCESS_ID,
        )
      ) {
        continue;
      }

      const consumed = await this.redis.eval(
        `
        local value = redis.call("GET", KEYS[1])
        if value == ARGV[1] then
          redis.call("DEL", KEYS[1])
          return value
        end
        return nil
        `,
        1,
        key,
        raw,
      );
      if (typeof consumed !== "string") continue;
      const consumedTask = parseRestartRecoveryTask(consumed);
      if (consumedTask) tasks.push(consumedTask);
    }
    return tasks;
  }

  async deleteRestartRecoveryTask(taskID: string): Promise<void> {
    await this.redis.del(`ai:restart_recovery:${taskID}`);
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
    const defaultDisabledTools = ["EvalCode"];
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
