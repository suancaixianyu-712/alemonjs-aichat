import { randomUUID } from 'node:crypto';
import { redis } from './redis.js';
import { parseOwnedAIToolLoopState } from './api/tool-loop-state.js';
import { buildRestartRecoveryTask, RESTART_RECOVERY_TTL_SECONDS, parseRestartRecoveryTask, canConsumeRestartRecoveryTask } from './api/restart-recovery.js';
import { PROCESS_INSTANCE_ID, PM2_PROCESS_ID } from './api/runtime-instance.js';

const TOOL_LOOP_TTL_SECONDS = 3600;
const TOOL_LOOP_STALE_MS = TOOL_LOOP_TTL_SECONDS * 1000;
const AI_LOCKED_CONFIGS_KEY = "ai:locked:configs";
const NEXT_USER_MESSAGE_SUBSCRIPTION_TTL_SECONDS = 600;
const DEFAULT_CAPI_CONTEXT_LIMIT = 512000;
const ARCHIVED_CHAT_SUMMARY_MAX_LENGTH = 240;
const ARCHIVED_CHAT_DETAIL_MAX_LENGTH = 4000;
const ARCHIVED_CHAT_MESSAGE_MAX_LENGTH = 1200;
const ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH = 12000;
const ARCHIVED_CHAT_RECORD_MAX_STORE_BYTES = 128 * 1024;
const ARCHIVED_CHAT_RECORD_MAX_PARSE_BYTES = 1024 * 1024;
class db {
    redis;
    systemPrompt = "";
    /**
     * 校验并修复 OpenAI chat messages 中 tool 配对：
     * - role=tool 必须紧跟在带 tool_calls 的 assistant 之后，且 tool_call_id 一一对应
     * - 截断/压缩导致的孤儿 tool、不完整 tool_calls 组会被清理
     * - 避免 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
     */
    sanitizeAIChatHistory(history) {
        if (!Array.isArray(history) || history.length === 0) {
            return [];
        }
        const sanitized = [];
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
            const rawToolCalls = isAssistant && Array.isArray(message.tool_calls)
                ? message.tool_calls.filter((toolCall) => toolCall && (toolCall.function?.name || toolCall.name))
                : [];
            if (!isAssistant || rawToolCalls.length === 0) {
                // assistant 带了无效/空 tool_calls 时去掉该字段，避免 API 校验失败
                if (isAssistant && Array.isArray(message.tool_calls)) {
                    const { tool_calls: _ignored, ...rest } = message;
                    sanitized.push(rest);
                }
                else {
                    sanitized.push(message);
                }
                index += 1;
                continue;
            }
            const followingToolMessages = [];
            let cursor = index + 1;
            while (cursor < history.length && history[cursor]?.role === "tool") {
                followingToolMessages.push(history[cursor]);
                cursor += 1;
            }
            const normalizedToolCalls = rawToolCalls.map((toolCall, toolIndex) => {
                const existingId = String(toolCall.id || "").trim();
                const orderedTool = followingToolMessages[toolIndex];
                const orderedId = String(orderedTool?.tool_call_id || "").trim();
                const id = existingId || orderedId || `call_${index}_${toolIndex}`;
                return {
                    id,
                    type: toolCall.type || "function",
                    function: {
                        name: String(toolCall.function?.name || toolCall.name || ""),
                        arguments: typeof toolCall.function?.arguments === "string"
                            ? toolCall.function.arguments
                            : JSON.stringify(toolCall.function?.arguments ?? toolCall.arguments ?? {}),
                    },
                };
            });
            const usedToolIndexes = new Set();
            const matchedToolMessages = [];
            let allMatched = true;
            for (let toolIndex = 0; toolIndex < normalizedToolCalls.length; toolIndex += 1) {
                const toolCall = normalizedToolCalls[toolIndex];
                let foundIndex = followingToolMessages.findIndex((toolMessage, candidateIndex) => !usedToolIndexes.has(candidateIndex) &&
                    String(toolMessage?.tool_call_id || "").trim() === toolCall.id);
                if (foundIndex < 0 &&
                    !usedToolIndexes.has(toolIndex) &&
                    followingToolMessages[toolIndex]) {
                    // 部分上游流式响应会丢 id，按顺序兜底配对
                    foundIndex = toolIndex;
                }
                if (foundIndex < 0) {
                    allMatched = false;
                    break;
                }
                usedToolIndexes.add(foundIndex);
                const toolMessage = followingToolMessages[foundIndex];
                const content = typeof toolMessage.content === "string"
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
            if (allMatched &&
                matchedToolMessages.length === normalizedToolCalls.length) {
                sanitized.push({
                    ...message,
                    tool_calls: normalizedToolCalls,
                }, ...matchedToolMessages);
            }
            else {
                // 不完整 tool 组：降级为普通 assistant，丢掉残缺 tool，避免 400
                const { tool_calls: _ignored, ...rest } = message;
                const content = typeof rest.content === "string" && rest.content.trim()
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
    sanitizeChatMessages(history) {
        return this.sanitizeAIChatHistory(history);
    }
    async getToolDefinitions() {
        const { tools } = await import('./api/aitools.js');
        return tools;
    }
    extractMessageText(content) {
        if (typeof content === "string") {
            return content;
        }
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                if (!part)
                    return "";
                if (typeof part === "string")
                    return part;
                if (typeof part?.text === "string")
                    return part.text;
                if (typeof part?.content === "string")
                    return part.content;
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
    trimText(text, maxLength) {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `${normalized.slice(0, maxLength)}...`;
    }
    trimLatestText(text, maxLength) {
        const normalized = text.trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `...（较早记忆已省略，必要时调用 MemoryOperation 获取完整内容）\n${normalized.slice(-maxLength)}`;
    }
    getUtf8ByteLength(text) {
        return Buffer.byteLength(text, "utf8");
    }
    formatHistoryMessage(message) {
        if (!message || typeof message !== "object") {
            return "";
        }
        const role = String(message.role || "unknown");
        const name = message.name ? `(${message.name})` : "";
        const content = this.extractMessageText(message.content);
        const trimmed = this.trimText(content.trim(), ARCHIVED_CHAT_MESSAGE_MAX_LENGTH);
        if (!trimmed) {
            return `${role}${name}: [空内容]`;
        }
        return `${role}${name}: ${trimmed}`;
    }
    buildChatHistoryTranscript(history) {
        const transcript = history
            .map((message) => this.formatHistoryMessage(message))
            .filter(Boolean)
            .join("\n");
        return this.trimText(transcript, ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH);
    }
    compactToolCalls(toolCalls) {
        if (!Array.isArray(toolCalls)) {
            return [];
        }
        return toolCalls.slice(0, 5).map((toolCall) => ({
            id: toolCall?.id || "",
            type: toolCall?.type || "function",
            function: {
                name: toolCall?.function?.name || "",
                arguments: this.trimText(String(toolCall?.function?.arguments || ""), ARCHIVED_CHAT_MESSAGE_MAX_LENGTH),
            },
        }));
    }
    compactArchivedHistory(history) {
        if (!Array.isArray(history) || history.length === 0) {
            return [];
        }
        return history
            .slice(-12)
            .map((message) => {
            const compactMessage = {
                role: String(message?.role || "unknown"),
                content: this.trimText(this.extractMessageText(message?.content), ARCHIVED_CHAT_MESSAGE_MAX_LENGTH),
            };
            if (message?.name) {
                compactMessage.name = String(message.name);
            }
            if (message?.tool_call_id) {
                compactMessage.tool_call_id = String(message.tool_call_id);
            }
            if (Array.isArray(message?.tool_calls) &&
                message.tool_calls.length > 0) {
                compactMessage.tool_calls = this.compactToolCalls(message.tool_calls);
            }
            return compactMessage;
        });
    }
    buildArchivedChatFallbackRecord(guid, id, summary, detail) {
        if (!summary && !detail) {
            return null;
        }
        const normalizedSummary = this.trimText(summary || "无摘要", ARCHIVED_CHAT_SUMMARY_MAX_LENGTH);
        const normalizedDetail = this.trimText(detail || "", ARCHIVED_CHAT_DETAIL_MAX_LENGTH);
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
    buildStoredArchivedChatRecord(record) {
        const baseRecord = {
            ...record,
            summary: this.trimText(record.summary || "无摘要", ARCHIVED_CHAT_SUMMARY_MAX_LENGTH),
            detail: this.trimText(record.detail || "", ARCHIVED_CHAT_DETAIL_MAX_LENGTH),
            transcript: this.trimText(record.transcript || "", ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH),
            history: this.compactArchivedHistory(record.history || []),
        };
        const candidates = [
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
            if (this.getUtf8ByteLength(serialized) <=
                ARCHIVED_CHAT_RECORD_MAX_STORE_BYTES) {
                return {
                    record: candidate,
                    serialized,
                };
            }
        }
        const fallbackRecord = {
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
    buildFallbackSummary(history, transcript) {
        const recent = history
            .slice(-6)
            .map((message) => this.formatHistoryMessage(message))
            .filter(Boolean)
            .join(" ");
        if (recent) {
            return this.trimText(`共 ${history.length} 条消息，最近内容：${recent}`, 180);
        }
        return this.trimText(`共 ${history.length} 条消息，主要内容：${transcript || "无可用文本内容"}`, 180);
    }
    buildFallbackDetail(history, transcript) {
        const recentMessages = history
            .slice(-20)
            .map((message) => this.formatHistoryMessage(message))
            .filter(Boolean)
            .join("\n");
        return this.trimText(recentMessages || transcript || "无详细历史内容", 2000);
    }
    getArchiveRecordKey(guid, id) {
        return `ai:memory:chat:${guid}:${id}`;
    }
    buildSearchTerms(query) {
        const normalized = query.toLowerCase().trim();
        if (!normalized) {
            return [];
        }
        const parts = normalized.split(/\s+/).filter(Boolean);
        return [...new Set([normalized, ...parts])];
    }
    scoreArchivedChatRecord(record, query) {
        const normalized = query.toLowerCase().trim();
        if (!normalized) {
            return 0;
        }
        const summary = (record.summary || "").toLowerCase();
        const detail = (record.detail || "").toLowerCase();
        const transcript = (record.transcript || "").toLowerCase();
        const terms = this.buildSearchTerms(query);
        let score = 0;
        if (summary.includes(normalized))
            score += 18;
        if (detail.includes(normalized))
            score += 12;
        if (transcript.includes(normalized))
            score += 6;
        for (const term of terms) {
            if (!term)
                continue;
            if (summary.includes(term))
                score += 6;
            if (detail.includes(term))
                score += 4;
            if (transcript.includes(term))
                score += 2;
        }
        return score;
    }
    static defaultAIConfig = {
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
    constructor(redisInstance) {
        this.redis = redisInstance || redis;
    }
    /** 获取提示词优化内容 */
    async getPromptOptimization(guid) {
        const id = guid ?? "global";
        return (await this.redis.get(`ai:prompt_optimization:${id}`)) || "0";
    }
    /** 设置提示词优化内容 */
    async setPromptOptimization(guid, value) {
        await this.redis.set(`ai:prompt_optimization:${guid}`, value);
    }
    /** --------------------------------------------------------- */
    /** 工具相关配置 */
    /** 获取 CAPI 自动压缩上下文长度 */
    async getCAPIContextLimit(guid) {
        const raw = await this.redis.get(`ai:capi_context_limit:${guid}`);
        const limit = Number(raw);
        return Number.isFinite(limit) && limit > 0
            ? Math.floor(limit)
            : DEFAULT_CAPI_CONTEXT_LIMIT;
    }
    /** 设置 CAPI 自动压缩上下文长度 */
    async setCAPIContextLimit(guid, limit) {
        const normalized = Math.max(1, Math.floor(limit));
        await this.redis.set(`ai:capi_context_limit:${guid}`, String(normalized));
    }
    /** 获取识图/OCR 专用 AI 名称（AI 列表中的名称） */
    async getOCRAIName(guid) {
        return (await this.redis.get(`ai:ocr_ai:${guid}`)) || "";
    }
    /** 设置识图/OCR 专用 AI 名称 */
    async setOCRAIName(guid, name) {
        const trimmed = name.trim();
        if (!trimmed) {
            await this.redis.del(`ai:ocr_ai:${guid}`);
            return;
        }
        await this.redis.set(`ai:ocr_ai:${guid}`, trimmed);
    }
    /** 清除识图/OCR 专用 AI */
    async clearOCRAIName(guid) {
        await this.redis.del(`ai:ocr_ai:${guid}`);
    }
    /** 获取 GPT 画图工具专用配置（复用 AI 列表中的接口地址与密钥） */
    async getGPTImageConfig() {
        const configStr = await this.redis.get("ai:tool:gptimage");
        if (!configStr)
            return null;
        try {
            const config = JSON.parse(configStr);
            if (typeof config.aiName !== "string" ||
                !config.aiName.trim() ||
                typeof config.model !== "string" ||
                !config.model.trim()) {
                return null;
            }
            return {
                aiName: config.aiName.trim(),
                model: config.model.trim(),
            };
        }
        catch {
            return null;
        }
    }
    /** 设置 GPT 画图工具专用配置 */
    async setGPTImageConfig(aiName, model) {
        await this.redis.set("ai:tool:gptimage", JSON.stringify({ aiName: aiName.trim(), model: model.trim() }));
    }
    /** 获取 Grok 画图/修图工具专用配置（复用 AI 列表中的接口地址与密钥） */
    async getGrokImageConfig() {
        const configStr = await this.redis.get("ai:tool:grokimage");
        if (!configStr)
            return null;
        try {
            const config = JSON.parse(configStr);
            if (typeof config.aiName !== "string" ||
                !config.aiName.trim() ||
                typeof config.model !== "string" ||
                !config.model.trim()) {
                return null;
            }
            return {
                aiName: config.aiName.trim(),
                model: config.model.trim(),
            };
        }
        catch {
            return null;
        }
    }
    /** 设置 Grok 画图/修图工具专用配置 */
    async setGrokImageConfig(aiName, model) {
        await this.redis.set("ai:tool:grokimage", JSON.stringify({ aiName: aiName.trim(), model: model.trim() }));
    }
    /**
     * 获取识图/OCR 专用 AI 完整配置
     * 从厂商模型列表中解析，用于纯文本模型的看图描述
     */
    async getOCRAIConfig(guid) {
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
    async getToolSwitch(guid) {
        return (await this.redis.get(`ai:tool:switch:${guid}`)) || "1";
    }
    /** 设置工具开关状态 */
    async setToolSwitch(guid, enable) {
        await this.redis.set(`ai:tool:switch:${guid}`, enable ? "1" : "0");
    }
    /** 工具调用时是否发送提示 */
    async getToolPromptSwitch(guid) {
        return (await this.redis.get(`ai:tool_prompt:switch:${guid}`)) || "0";
    }
    /** 设置工具调用提示开关状态 */
    async setToolPromptSwitch(guid, enable) {
        await this.redis.set(`ai:tool_prompt:switch:${guid}`, enable ? "1" : "0");
    }
    /** 工具调用时发送的提示是否撤回 */
    async getToolPromptRevokeSwitch(guid) {
        return ((await this.redis.get(`ai:tool_prompt_revoke:switch:${guid}`)) || "0");
    }
    /** 设置工具调用提示撤回开关状态 */
    async setToolPromptRevokeSwitch(guid, enable) {
        await this.redis.set(`ai:tool_prompt_revoke:switch:${guid}`, enable ? "1" : "0");
    }
    /** 工具调用时发送的提示是否显示传参 */
    async getToolPromptArgsSwitch(guid) {
        return (await this.redis.get(`ai:tool_prompt_args:switch:${guid}`)) || "0";
    }
    /** 设置工具调用提示显示传参开关状态 */
    async setToolPromptArgsSwitch(guid, enable) {
        await this.redis.set(`ai:tool_prompt_args:switch:${guid}`, enable ? "1" : "0");
    }
    /** 工具调用前是否发送模型返回的 content */
    async getToolCallContentSwitch(guid) {
        return (await this.redis.get(`ai:tool_call_content:switch:${guid}`)) || "0";
    }
    /** 设置工具调用前 content 发送开关状态 */
    async setToolCallContentSwitch(guid, enable) {
        await this.redis.set(`ai:tool_call_content:switch:${guid}`, enable ? "1" : "0");
    }
    /** 文件消息处理开关状态（默认开启） */
    async getFileMessageSwitch(guid) {
        return (await this.redis.get(`ai:file_message:switch:${guid}`)) || "1";
    }
    /** 设置文件消息处理开关状态 */
    async setFileMessageSwitch(guid, enable) {
        await this.redis.set(`ai:file_message:switch:${guid}`, enable ? "1" : "0");
    }
    /** --------------------------------------------------------- */
    /** 获取复杂输出开关状态 */
    async getComplexOutput(guid) {
        return (await this.redis.get(`ai:complex_output:${guid}`)) || "1";
    }
    /** 设置复杂输出开关状态 */
    async setComplexOutput(guid, enable) {
        await this.redis.set(`ai:complex_output:${guid}`, enable ? "1" : "0");
    }
    /** 获取R18模式开关状态 */
    async getR18Switch(guid) {
        return await this.redis.get(`ai:r18:switch:${guid}`);
    }
    /** 设置R18模式开关状态 */
    async setR18Switch(guid, enable) {
        await this.redis.set(`ai:r18:switch:${guid}`, enable ? "1" : "0");
    }
    /** 切换当前图床 */
    async switchImageBed(guid, bedName) {
        await this.redis.set(`ai:image_bed:${guid}`, bedName);
    }
    /** 获取当前图床 */
    async getImageBed(guid) {
        return await this.redis.get(`ai:image_bed:${guid}`);
    }
    /** 获取图床开关状态 */
    async getImageBedSwitch(guid) {
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
    async setImageBedSwitch(enable) {
        await this.redis.set("ai:image_bed:switch:global", enable ? "1" : "0");
    }
    /** 读取单个 AI 配置是否开启代理，默认关闭。 */
    isAIProxyEnabled(config) {
        return config?.useProxy === true;
    }
    /**
     * 修改当前会话 AI 的代理开关，并同步回该 AI 的持久化配置。
     * 这样切到别的配置再切回来，仍保留各自的开关。
     */
    async setCurrentAIProxy(guid, enable) {
        const currentConfig = await this.getAIConfig(guid);
        if (!currentConfig.host || !currentConfig.key || !currentConfig.model) {
            return null;
        }
        const currentAI = await this.getCurrentAI(guid);
        const separatorIndex = currentAI.indexOf("/");
        if (separatorIndex > 0) {
            const provider = currentAI.slice(0, separatorIndex);
            const name = currentAI.slice(separatorIndex + 1);
            const providers = [
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
    async getAIConfig(guid) {
        const id = guid ?? "global";
        const userConfigStr = await this.redis.get(`ai:config:${id}`);
        if (userConfigStr) {
            return JSON.parse(userConfigStr);
        }
        await this.setAIConfig(id, db.defaultAIConfig);
        return { ...db.defaultAIConfig };
    }
    /** 设置AI配置 */
    async setAIConfig(guid, config) {
        await this.redis.set(`ai:config:${guid}`, JSON.stringify(config));
    }
    /** 关闭指定聊天 */
    async closeChat(guid) {
        await this.setAIConfig(guid, db.defaultAIConfig);
        await this.clearAIChatHistory(guid);
    }
    /** 关闭所有聊天 */
    async closeAllChat() {
        const keys = await this.redis.keys(`ai:config:*`);
        for (const key of keys) {
            const guid = key.replace("ai:config:", "");
            await this.setAIConfig(guid, db.defaultAIConfig);
            await this.clearAIChatHistory(guid);
        }
    }
    /** 将旧版 AI 列表一次性迁移到带厂商 ID 的新结构。 */
    async migrateLegacyAIModels() {
        const migrationKey = "ai:migration:provider-models:v1";
        if (await this.redis.exists(migrationKey))
            return;
        const legacyKeys = await this.redis.keys("ai:list:*");
        const migratedNames = new Set();
        for (const legacyKey of legacyKeys) {
            const name = legacyKey.replace("ai:list:", "");
            const configStr = await this.redis.get(legacyKey);
            if (!name || !configStr)
                continue;
            try {
                const config = JSON.parse(configStr);
                await this.setProviderAIModel("other", name, {
                    ...config,
                    provider: "other",
                });
                migratedNames.add(name);
            }
            catch {
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
            if (!configStr)
                continue;
            try {
                const config = JSON.parse(configStr);
                if (!config.provider && config.host && config.key && config.model) {
                    await this.redis.set(currentConfigKey, JSON.stringify({ ...config, provider: "other" }));
                }
            }
            catch {
                continue;
            }
        }
        if (legacyKeys.length > 0) {
            await this.redis.del(...legacyKeys);
        }
        await this.redis.set(migrationKey, "1");
    }
    /** 为旧 AI 配置补充别名，默认使用其实际模型名。 */
    async migrateAIModelAliases() {
        const migrationKey = "ai:migration:model-aliases:v1";
        if (await this.redis.exists(migrationKey))
            return;
        const modelKeys = await this.redis.keys("ai:model:*");
        for (const modelKey of modelKeys) {
            const configStr = await this.redis.get(modelKey);
            if (!configStr)
                continue;
            try {
                const config = JSON.parse(configStr);
                if (!config.alias?.trim() && config.model?.trim()) {
                    await this.redis.set(modelKey, JSON.stringify({ ...config, alias: config.model.trim() }));
                }
            }
            catch {
                continue;
            }
        }
        const currentConfigKeys = await this.redis.keys("ai:config:*");
        for (const currentConfigKey of currentConfigKeys) {
            const configStr = await this.redis.get(currentConfigKey);
            if (!configStr)
                continue;
            try {
                const config = JSON.parse(configStr);
                if (!config.alias?.trim() && config.model?.trim()) {
                    await this.redis.set(currentConfigKey, JSON.stringify({ ...config, alias: config.model.trim() }));
                }
            }
            catch {
                continue;
            }
        }
        await this.redis.set(migrationKey, "1");
    }
    /** 获取AI列表 */
    async getAIList() {
        await this.migrateLegacyAIModels();
        await this.migrateAIModelAliases();
        const providerKeys = await this.redis.keys("ai:model:*");
        const providerNames = providerKeys.flatMap((key) => {
            const provider = key.split(":")[2];
            const encodedName = key.split(":").slice(3).join(":");
            if (!provider || !encodedName)
                return [];
            try {
                return [`${provider}/${decodeURIComponent(encodedName)}`];
            }
            catch {
                return [];
            }
        });
        return [...new Set(providerNames)].sort((a, b) => a.localeCompare(b));
    }
    /** 获取被主人锁定、仅主人和网页端可使用的 AI 配置。 */
    async getLockedAIList() {
        return (await this.redis.smembers(AI_LOCKED_CONFIGS_KEY)).sort((a, b) => a.localeCompare(b));
    }
    /** 判断 AI 配置是否已被主人锁定。 */
    async isAILocked(name) {
        return (await this.redis.sismember(AI_LOCKED_CONFIGS_KEY, name)) === 1;
    }
    /** 批量锁定 AI 配置。 */
    async lockAI(names) {
        const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
        if (uniqueNames.length > 0) {
            await this.redis.sadd(AI_LOCKED_CONFIGS_KEY, ...uniqueNames);
        }
    }
    /** 批量解除 AI 配置锁定。 */
    async unlockAI(names) {
        const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
        if (uniqueNames.length > 0) {
            await this.redis.srem(AI_LOCKED_CONFIGS_KEY, ...uniqueNames);
        }
    }
    /** 获取带厂商 ID 的 AI 模型配置。 */
    async getAIListConfig(name) {
        await this.migrateLegacyAIModels();
        await this.migrateAIModelAliases();
        const providerKeys = await this.redis.keys("ai:model:*");
        const providerKey = providerKeys.find((key) => {
            const provider = key.split(":")[2];
            const encodedName = key.split(":").slice(3).join(":");
            try {
                const modelName = decodeURIComponent(encodedName);
                return `${provider}/${modelName}` === name || modelName === name;
            }
            catch {
                return false;
            }
        });
        if (providerKey) {
            const providerConfigStr = await this.redis.get(providerKey);
            if (providerConfigStr) {
                return JSON.parse(providerConfigStr);
            }
        }
        return null;
    }
    /** 获取 AI 标识对应的展示名称，优先使用别名。 */
    async getAIDisplayName(name, includeProvider = true) {
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
    async getAIDisplayNames(names, includeProvider = true) {
        return Promise.all(names.map((name) => this.getAIDisplayName(name, includeProvider)));
    }
    /** 按厂商保存模型；键和值中都保留厂商 ID。 */
    async setProviderAIModel(provider, name, config) {
        const storageKey = `ai:model:${provider}:${encodeURIComponent(name)}`;
        await this.redis.set(storageKey, JSON.stringify({
            ...config,
            alias: config.alias?.trim() || config.model?.trim() || name.trim(),
            provider,
        }));
    }
    /** 获取某个厂商保存的首个模型配置，供厂商专属能力复用凭据。 */
    async getProviderAIConfig(provider) {
        await this.migrateLegacyAIModels();
        const keys = await this.redis.keys(`ai:model:${provider}:*`);
        if (keys.length === 0)
            return null;
        const configStr = await this.redis.get(keys[0]);
        return configStr ? JSON.parse(configStr) : null;
    }
    /** 新增AI配置并切换 */
    async addAI(guid, name, host, key, model, provider = "other", apiMode = "capi", alias = name) {
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
    async deleteAI(name) {
        await this.migrateLegacyAIModels();
        const providerKeys = await this.redis.keys("ai:model:*");
        const matchedProviderKeys = providerKeys.filter((key) => {
            const provider = key.split(":")[2];
            const encodedName = key.split(":").slice(3).join(":");
            try {
                const modelName = decodeURIComponent(encodedName);
                return `${provider}/${modelName}` === name || modelName === name;
            }
            catch {
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
            if (!provider || !encodedName)
                return [];
            try {
                return [`${provider}/${decodeURIComponent(encodedName)}`];
            }
            catch {
                return [];
            }
        });
        await this.redis.del(...matchedProviderKeys);
        await this.unlockAI(matchedAIIdentifiers);
        return true;
    }
    /** 切换AI */
    async switchAI(guid, name) {
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
    async switchCurrentAIModel(guid, model) {
        const modelID = model.trim();
        if (!modelID)
            return null;
        const currentConfig = await this.getAIConfig(guid);
        if (!currentConfig.host || !currentConfig.key || !currentConfig.model) {
            return null;
        }
        const currentAI = await this.getCurrentAI(guid);
        const separatorIndex = currentAI.indexOf("/");
        if (separatorIndex > 0) {
            const provider = currentAI.slice(0, separatorIndex);
            const name = currentAI.slice(separatorIndex + 1);
            const providers = [
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
    async switchCurrentAIAPI(guid, apiMode) {
        if (apiMode !== "capi" && apiMode !== "rapi")
            return null;
        const currentConfig = await this.getAIConfig(guid);
        if (!currentConfig.host || !currentConfig.key || !currentConfig.model) {
            return null;
        }
        const currentAI = await this.getCurrentAI(guid);
        const separatorIndex = currentAI.indexOf("/");
        if (separatorIndex > 0) {
            const provider = currentAI.slice(0, separatorIndex);
            const name = currentAI.slice(separatorIndex + 1);
            const providers = [
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
    async switchCurrentAIBuiltinTools(guid, enable, tool) {
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
        const nextConfig = { ...currentConfig, builtinTools };
        const currentAI = await this.getCurrentAI(guid);
        const separatorIndex = currentAI.indexOf("/");
        if (separatorIndex > 0) {
            const provider = currentAI.slice(0, separatorIndex);
            const name = currentAI.slice(separatorIndex + 1);
            const providers = [
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
    async getCurrentAI(guid) {
        return (await this.redis.get(`ai:currentAI:${guid}`)) || "";
    }
    /** 获取提示词列表 */
    async getPromptList() {
        const keys = await this.redis.keys("ai:prompt:*");
        return keys.map((key) => key.replace("ai:prompt:", ""));
    }
    /** 获取提示词内容 */
    async getPrompt(name) {
        return await this.redis.get(`ai:prompt:${name}`);
    }
    /** 设置提示词内容 */
    async setPrompt(name, content) {
        await this.redis.set(`ai:prompt:${name}`, content);
    }
    /** 新增提示词 */
    async addPrompt(name, content) {
        await this.setPrompt(name, content);
    }
    /** 删除提示词 */
    async deletePrompt(name) {
        return await this.redis.del(`ai:prompt:${name}`);
    }
    /** 切换当前提示词 */
    async switchPrompt(guid, name) {
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
    async getAIChatHistory(guid) {
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
    async setAIChatHistory(guid, history) {
        const sanitizedHistory = this.sanitizeAIChatHistory(history);
        await this.redis.set(`ai:history:${guid}`, JSON.stringify(sanitizedHistory));
    }
    /** 添加聊天历史 */
    async addAIChatHistory(guid, data) {
        return this.addAIChatHistoryBatch(guid, [data]);
    }
    /** 批量添加聊天历史 */
    async addAIChatHistoryBatch(guid, dataList) {
        const history = await this.getAIChatHistory(guid);
        history.push(...dataList);
        await this.setAIChatHistory(guid, history);
        return history;
    }
    /** 清除聊天历史 */
    async clearAIChatHistory(guid) {
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
    async recordAIContextStats(guid, input) {
        const current = await this.getAIContextStats(guid);
        const promptTokens = input.promptTokens ?? 0;
        const completionTokens = input.completionTokens ?? 0;
        const totalTokens = input.totalTokens ?? promptTokens + completionTokens;
        const cachedTokens = input.cachedTokens ?? 0;
        const cacheMissTokens = input.cacheMissTokens ?? Math.max(promptTokens - cachedTokens, 0);
        const nextStats = {
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
            totalCompletionTokens: (current?.totalCompletionTokens ?? 0) + completionTokens,
            totalTokensUsed: (current?.totalTokensUsed ?? 0) + totalTokens,
            totalCachedTokens: (current?.totalCachedTokens ?? 0) + cachedTokens,
            totalCacheMissTokens: (current?.totalCacheMissTokens ?? 0) + cacheMissTokens,
        };
        await this.redis.set(`ai:context_stats:${guid}`, JSON.stringify(nextStats));
        return nextStats;
    }
    /** 获取当前会话上下文和 token 使用情况 */
    async getAIContextStats(guid) {
        const statsStr = await this.redis.get(`ai:context_stats:${guid}`);
        if (!statsStr) {
            return null;
        }
        return JSON.parse(statsStr);
    }
    /** 清理最后的N条聊天记录 */
    async clearLastNChatHistory(guid, n) {
        const history = await this.getAIChatHistory(guid);
        while (history.length > n) {
            history.shift();
        }
        await this.setAIChatHistory(guid, history);
    }
    /** 归档当前聊天历史 */
    async archiveAIChatHistory(guid, options) {
        const history = await this.getAIChatHistory(guid);
        if (!Array.isArray(history) || history.length === 0) {
            return null;
        }
        const transcript = this.buildChatHistoryTranscript(history);
        const id = Date.now().toString();
        const summary = this.trimText(options?.summary?.trim() ||
            this.buildFallbackSummary(history, transcript), ARCHIVED_CHAT_SUMMARY_MAX_LENGTH);
        const detail = this.trimText(options?.detail?.trim() || this.buildFallbackDetail(history, transcript), ARCHIVED_CHAT_DETAIL_MAX_LENGTH);
        const record = {
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
        await this.redis.set(this.getArchiveRecordKey(guid, id), storedRecord.serialized);
        return storedRecord.record;
    }
    /** 清理工具循环等临时会话状态 */
    async clearAITransientState(guid) {
        if (!guid) {
            const transientPrefixes = [
                "ai:tool_loop_processing:",
                "ai:guidance:",
                "ai:next_user_message:",
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
            `ai:session:${guid}`,
        ];
        const keys = (await Promise.all(keyPatterns.map((pattern) => this.redis.keys(pattern)))).flat();
        if (keys.length > 0) {
            await this.redis.del(...keys);
        }
        return;
    }
    getNextUserMessageSubscriptionKey(guid, userID, platform) {
        return `ai:next_user_message:${guid}:${platform || "default"}:${userID}`;
    }
    /** 订阅指定群聊用户的下一条非命令消息 */
    async subscribeNextUserMessage(guid, userID, platform) {
        await this.redis.set(this.getNextUserMessageSubscriptionKey(guid, userID, platform), "1", "EX", NEXT_USER_MESSAGE_SUBSCRIPTION_TTL_SECONDS);
    }
    /** 原子消费一次订阅，确保同一条订阅最多触发一条消息 */
    async consumeNextUserMessageSubscription(guid, userID, platform) {
        const result = await this.redis.eval(`
      local value = redis.call("GET", KEYS[1])
      if value then
        redis.call("DEL", KEYS[1])
        return 1
      end
      return 0
      `, 1, this.getNextUserMessageSubscriptionKey(guid, userID, platform));
        return Number(result) === 1;
    }
    getToolLoopStateKey(guid, platform) {
        if (platform) {
            return `ai:tool_loop_processing:${guid}:${platform}`;
        }
        return `ai:tool_loop_processing:${guid}`;
    }
    getGuidanceMessageKey(guid, platform) {
        if (platform) {
            return `ai:guidance:${guid}:${platform}`;
        }
        return `ai:guidance:${guid}`;
    }
    /** 获取聊天频率限制（0 表示不限制），默认每分钟 2 条 */
    async getChatRateLimit(guid) {
        const stored = Number(await this.redis.get(`ai:chat_rate_limit:${guid}`));
        return Number.isInteger(stored) && stored > 0 ? stored : 2;
    }
    /** 设置聊天频率限制（limit<=0 表示关闭限制） */
    async setChatRateLimit(guid, limit) {
        const validLimit = Math.max(0, Math.floor(Number(limit) || 0));
        await this.redis.set(`ai:chat_rate_limit:${guid}`, String(validLimit));
    }
    /** 检查并记录一次聊天频率（滑动窗口），返回本次是否允许 */
    async checkChatRateLimit(guid, userID, limit, windowSeconds = 60) {
        if (limit <= 0)
            return true;
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
    async acquireAIToolLoop(guid, userID, platform) {
        const now = Date.now();
        const state = {
            processing: true,
            ownerId: PROCESS_INSTANCE_ID,
            userID,
            startedAt: now,
            updatedAt: now,
        };
        const result = await this.redis.set(this.getToolLoopStateKey(guid, platform), JSON.stringify(state), "EX", TOOL_LOOP_TTL_SECONDS, "NX");
        return result === "OK";
    }
    async releaseAIToolLoop(guid, userID, platform) {
        const keys = [
            this.getToolLoopStateKey(guid, platform),
            `ai:tool_loop_processing:${guid}`,
        ].filter((key, index, values) => values.indexOf(key) === index);
        const released = await this.redis.eval(`
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
      `, keys.length, ...keys, userID);
        return Number(released) > 0;
    }
    async setAIToolLoopProcessing(guid, processing, platform, userID = "") {
        if (processing) {
            const now = Date.now();
            const state = {
                processing: true,
                ownerId: PROCESS_INSTANCE_ID,
                userID,
                startedAt: now,
                updatedAt: now,
            };
            await this.redis.set(this.getToolLoopStateKey(guid, platform), JSON.stringify(state), "EX", TOOL_LOOP_TTL_SECONDS);
            return;
        }
        const keys = [
            this.getToolLoopStateKey(guid, platform),
            `ai:tool_loop_processing:${guid}`,
        ];
        await this.redis.del(...keys);
    }
    /** 获取工具调用中的处理状态 */
    async getAIToolLoopState(guid, platform) {
        const key = this.getToolLoopStateKey(guid, platform);
        let processing = await this.redis.get(key);
        if (!processing && platform) {
            processing = await this.redis.get(`ai:tool_loop_processing:${guid}`);
        }
        if (!processing)
            return null;
        const state = parseOwnedAIToolLoopState(processing, PROCESS_INSTANCE_ID, TOOL_LOOP_STALE_MS);
        if (!state) {
            await this.clearAITransientState(guid);
            return null;
        }
        const ttl = await this.redis.ttl(key);
        if (ttl === -1)
            await this.redis.expire(key, TOOL_LOOP_TTL_SECONDS);
        return state;
    }
    async getAIToolLoopProcessing(guid, platform) {
        return (await this.getAIToolLoopState(guid, platform)) ? "1" : "0";
    }
    /** 获取工具调用期间追加的引导消息 */
    async getAIGuidanceMessages(guid, platform) {
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
        }
        catch {
            await this.clearAIGuidanceMessages(guid);
            return [];
        }
    }
    /** 追加工具调用期间的引导消息 */
    async addAIGuidanceMessage(guid, data, platform) {
        const queue = await this.getAIGuidanceMessages(guid, platform);
        queue.push(data);
        await this.redis.set(this.getGuidanceMessageKey(guid, platform), JSON.stringify(queue), "EX", TOOL_LOOP_TTL_SECONDS);
        return queue;
    }
    /** 提取并清空工具调用期间的引导消息 */
    async drainAIGuidanceMessages(guid, platform) {
        const queue = await this.getAIGuidanceMessages(guid, platform);
        await this.clearAIGuidanceMessages(guid, platform);
        return queue;
    }
    /** 清空工具调用期间的引导消息 */
    async clearAIGuidanceMessages(guid, platform) {
        const keys = [
            this.getGuidanceMessageKey(guid, platform),
            `ai:guidance:${guid}`,
        ];
        await this.redis.del(...keys);
    }
    /** 存储摘要,全局共享 */
    async setSummary(guid, id, summary) {
        await this.redis.set(`ai:summary:${guid}:${id}`, this.trimText(summary, ARCHIVED_CHAT_SUMMARY_MAX_LENGTH));
    }
    /** 获取摘要 */
    async getSummary(guid, id) {
        return await this.redis.get(`ai:summary:${guid}:${id}`);
    }
    /** 获取所有摘要时间列表 */
    async getSummaryList() {
        const keys = await this.redis.keys(`ai:summary:*`);
        const entries = await Promise.all(keys.map(async (key) => {
            const parts = key.split(":");
            const summary = await this.redis.get(key);
            return {
                id: `${parts[2]}:${parts[3]}`,
                summary: summary ?? "",
            };
        }));
        return entries.sort((a, b) => b.id.localeCompare(a.id));
    }
    /** 删除摘要 */
    async deleteSummary(guid, id) {
        return await this.redis.del(`ai:summary:${guid}:${id}`);
    }
    /** 存储摘要中的详细内容 */
    async setSummaryDetail(guid, id, detail) {
        await this.redis.set(`ai:summary_detail:${guid}:${id}`, this.trimText(detail, ARCHIVED_CHAT_DETAIL_MAX_LENGTH));
    }
    /** 获取摘要中的详细内容 */
    async getSummaryDetail(guid, id) {
        return await this.redis.get(`ai:summary_detail:${guid}:${id}`);
    }
    /** 删除摘要中的详细内容 */
    async deleteSummaryDetail(guid, id) {
        return await this.redis.del(`ai:summary_detail:${guid}:${id}`);
    }
    /** 获取完整归档记录 */
    async getArchivedChatRecord(guid, id) {
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
            const parsed = JSON.parse(raw);
            return {
                ...parsed,
                transcript: this.trimText(parsed?.transcript || detail || "", ARCHIVED_CHAT_TRANSCRIPT_MAX_LENGTH),
                detail: this.trimText(parsed?.detail || detail || "", 2000),
                summary: this.trimText(parsed?.summary || summary || "无摘要", 180),
                history: this.compactArchivedHistory(parsed?.history || []),
            };
        }
        catch {
            return this.buildArchivedChatFallbackRecord(guid, id, summary, detail);
        }
    }
    /** 获取归档记录列表 */
    async listArchivedChatRecords(guid, limit = 20) {
        const merged = new Map();
        const summaryPattern = guid ? `ai:summary:${guid}:*` : "ai:summary:*";
        const summaryKeys = await this.redis.keys(summaryPattern);
        for (const key of summaryKeys) {
            const [, , summaryGuid, summaryId] = key.split(":");
            const [summary, detail] = await Promise.all([
                this.redis.get(key),
                this.getSummaryDetail(summaryGuid, summaryId),
            ]);
            const record = this.buildArchivedChatFallbackRecord(summaryGuid, summaryId, summary, detail);
            if (record) {
                merged.set(`${summaryGuid}:${summaryId}`, record);
            }
        }
        return [...merged.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit);
    }
    /** 搜索归档聊天记录 */
    async searchArchivedChatRecords(query, options) {
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
    async getRelevantMemoryContext(guid, userKey, query, limit = 3) {
        const blocks = [];
        const userMemory = userKey ? await this.getUserData(userKey) : null;
        if (userMemory) {
            blocks.push(`用户长期记忆（优先展示最近记录）:\n${this.trimLatestText(userMemory, 2000)}`);
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
            const fallbackRecords = records.length === 0 &&
                /(之前|上次|刚才|还记得|继续|前面| earlier |before|remember)/i.test(normalizedQuery)
                ? await this.listArchivedChatRecords(guid, Math.min(limit, 2))
                : [];
            const finalRecords = (records.length > 0 ? records : fallbackRecords).slice(0, limit);
            if (finalRecords.length > 0) {
                blocks.push([
                    "相关历史归档:",
                    ...finalRecords.map((record) => {
                        const scope = record.guid === guid ? "当前会话" : `其他会话(${record.guid})`;
                        return `- ${scope} / 归档ID:${record.id} / 摘要:${this.trimText(record.summary || "无摘要", 120)} / 详情:${this.trimText(record.detail || record.transcript || "无详情", 220)}`;
                    }),
                ].join("\n"));
            }
        }
        return blocks.join("\n\n").trim();
    }
    /** 存储用户数据 */
    async setUserData(userKey, value) {
        await this.redis.set(`ai:user:${userKey}`, value);
    }
    /** 原子追加用户长期记忆，避免模型重写时删减已有内容 */
    async appendUserData(userKey, value) {
        await this.redis.eval(`
      local current = redis.call("GET", KEYS[1])
      if current and string.len(current) > 0 then
        redis.call("SET", KEYS[1], current .. "\\n" .. ARGV[1])
      else
        redis.call("SET", KEYS[1], ARGV[1])
      end
      return 1
      `, 1, `ai:user:${userKey}`, value);
    }
    /** 获取用户数据 */
    async getUserData(userKey) {
        return await this.redis.get(`ai:user:${userKey}`);
    }
    /** 删除用户数据 */
    async deleteUserData(userKey) {
        return await this.redis.del(`ai:user:${userKey}`);
    }
    /** 设置会话id */
    async setSessionId(guid, sessionId) {
        await this.redis.set(`ai:session:${guid}`, sessionId);
    }
    /** 获取会话id */
    async getSessionId(guid) {
        return await this.redis.get(`ai:session:${guid}`);
    }
    /** 删除会话id */
    async deleteSessionId(guid) {
        return await this.redis.del(`ai:session:${guid}`);
    }
    /** 获取好感度 */
    async getAffectionLevel(guid, userKey) {
        const levelStr = await this.redis.get(`ai:affection:${guid}:${userKey}`);
        return levelStr ? parseInt(levelStr, 10) : 0;
    }
    /** 设置好感度 */
    async setAffectionLevel(guid, userKey, level) {
        await this.redis.set(`ai:affection:${guid}:${userKey}`, level.toString());
    }
    /** 增加好感度 */
    async incrementAffectionLevel(guid, userKey, increment) {
        const currentLevel = await this.getAffectionLevel(guid, userKey);
        const newLevel = currentLevel + increment;
        await this.setAffectionLevel(guid, userKey, newLevel);
        return newLevel;
    }
    /** 获取所有好感度 */
    async getAffectionLevelAll(guid) {
        const keys = await this.redis.keys(`ai:affection:${guid}:*`);
        const levels = {};
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
    async resetAffectionLevel(guid, userKey) {
        return await this.redis.del(`ai:affection:${guid}:${userKey}`);
    }
    /** 重置全部好感度 */
    async resetAllAffectionLevels() {
        const keys = await this.redis.keys(`ai:affection:*`);
        for (const key of keys) {
            await this.redis.del(key);
        }
    }
    /** 设置好感度开关 */
    async setAffectionSwitch(guid, enable) {
        await this.redis.set(`ai:affection:switch:${guid}`, enable ? "1" : "0");
    }
    /** 获取好感度开关 */
    async getAffectionSwitch(guid) {
        const switchStr = (await this.redis.get(`ai:affection:switch:${guid}`)) || "1";
        return switchStr;
    }
    /** 设置语音回复开关 */
    async setTTSResponseSwitch(guid, enable) {
        await this.redis.set(`ai:tts:response:${guid}`, enable ? "1" : "0");
    }
    /** 获取语音回复开关 */
    async getTTSResponseSwitch(guid) {
        const switchStr = (await this.redis.get(`ai:tts:response:${guid}`)) || "0";
        return switchStr;
    }
    /** 添加图片URL */
    async addImgUrl(guid, url) {
        const id = guid ?? "global";
        await this.redis.lpush(`ai:images:${id}`, url);
    }
    /** 获取图片URL列表 */
    async getImgUrls(guid) {
        const id = guid ?? "global";
        return await this.redis.lrange(`ai:images:${id}`, 0, -1);
    }
    /** 主动搭话 */
    async getProactiveSwitch(guid) {
        return (await this.redis.get(`ai:proactive:switch:${guid}`)) || "1";
    }
    async setProactiveSwitch(guid, enable) {
        await this.redis.set(`ai:proactive:switch:${guid}`, enable ? "1" : "0");
    }
    /** 深度思考 */
    async getDeepThoughtSwitch(guid) {
        return (await this.redis.get(`ai:deep_thought:switch:${guid}`)) || "0";
    }
    /** 设置深度思考开关 */
    async setDeepThoughtSwitch(guid, enable) {
        await this.redis.set(`ai:deep_thought:switch:${guid}`, enable ? "1" : "0");
    }
    /** 仅艾特触发 */
    async getAtTriggerSwitch(guid) {
        return (await this.redis.get(`ai:at_trigger:switch:${guid}`)) || "1";
    }
    /** 设置仅艾特触发开关 */
    async setAtTriggerSwitch(guid, enable) {
        await this.redis.set(`ai:at_trigger:switch:${guid}`, enable ? "1" : "0");
    }
    /** --------------------------------------------------------- */
    /** 正则触发规则 */
    /** 获取正则触发规则列表 */
    async getRegexRules(guid) {
        const rulesStr = await this.redis.get(`ai:regex_rules:${guid}`);
        if (rulesStr) {
            return JSON.parse(rulesStr);
        }
        return [];
    }
    /** 设置正则触发规则列表 */
    async setRegexRules(guid, rules) {
        await this.redis.set(`ai:regex_rules:${guid}`, JSON.stringify(rules));
    }
    /** 添加正则触发规则 */
    async addRegexRule(guid, rule) {
        // 验证正则表达式是否合法
        try {
            new RegExp(rule);
        }
        catch {
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
    async removeRegexRule(guid, ruleOrIndex) {
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
    async matchRegexRule(guid, message) {
        const rules = await this.getRegexRules(guid);
        for (const rule of rules) {
            try {
                const regex = new RegExp(rule);
                if (regex.test(message)) {
                    return true;
                }
            }
            catch {
                // 跳过无效的正则
            }
        }
        return false;
    }
    /** 清空正则触发规则 */
    async clearRegexRules(guid) {
        await this.redis.del(`ai:regex_rules:${guid}`);
    }
    /** 禁用工具 */
    async disableTool(guid, toolName) {
        await this.redis.set(`ai:tool:disable:${guid}:${toolName}`, "1");
    }
    /** 启用工具 */
    async enableTool(guid, toolName) {
        await this.redis.del(`ai:tool:disable:${guid}:${toolName}`);
    }
    /** 获取工具状态 */
    async getToolStatus(guid, toolName) {
        const status = (await this.redis.get(`ai:tool:disable:${guid}:${toolName}`)) || "0";
        return status;
    }
    /** 获取当前会话的 agent/服务器管理权限，默认关闭 */
    async getAgentSwitch(guid) {
        return (await this.redis.get(`ai:agent:switch:${guid}`)) || "0";
    }
    /** 设置当前会话的 agent/服务器管理权限 */
    async setAgentSwitch(guid, enable) {
        await this.redis.set(`ai:agent:switch:${guid}`, enable ? "1" : "0");
    }
    /** 获取是否通过接口获取 bot 信息（按平台，默认开启接口获取） */
    async getBotInfoSwitch(platform) {
        return (await this.redis.get(`ai:bot_info:switch:${platform}`)) || "1";
    }
    /** 设置是否通过接口获取 bot 信息（按平台） */
    async setBotInfoSwitch(platform, enable) {
        await this.redis.set(`ai:bot_info:switch:${platform}`, enable ? "1" : "0");
    }
    /** 创建定时 AI 任务 */
    async createScheduledAITask(input) {
        const task = {
            ...input,
            id: randomUUID(),
            createdAt: Date.now(),
        };
        await this.redis.hset("ai:scheduled_tasks", task.id, JSON.stringify(task));
        return task;
    }
    /** 获取定时 AI 任务 */
    async getScheduledAITasks(guid) {
        const values = await this.redis.hvals("ai:scheduled_tasks");
        return values
            .map((value) => {
            try {
                return JSON.parse(value);
            }
            catch {
                return null;
            }
        })
            .filter((task) => task !== null && (!guid || task.guid === guid))
            .sort((a, b) => a.runAt - b.runAt);
    }
    /** 更新定时 AI 任务的下一次触发时间 */
    async updateScheduledAITask(task) {
        await this.redis.hset("ai:scheduled_tasks", task.id, JSON.stringify(task));
    }
    /** 删除定时 AI 任务 */
    async deleteScheduledAITask(guid, taskID) {
        const task = (await this.getScheduledAITasks(guid)).find((item) => item.id === taskID);
        if (!task)
            return false;
        await this.redis.hdel("ai:scheduled_tasks", taskID);
        return true;
    }
    /** 获取当前会话的心跳任务 */
    async getHeartbeatTask(guid) {
        const raw = await this.redis.get(`ai:heartbeat:${guid}`);
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    /** 获取所有心跳任务，供轮询器使用 */
    async getAllHeartbeatTasks() {
        const keys = await this.redis.keys("ai:heartbeat:*");
        if (!keys.length)
            return [];
        const values = await this.redis.mget(...keys);
        return values
            .map((value) => {
            if (!value)
                return null;
            try {
                return JSON.parse(value);
            }
            catch {
                return null;
            }
        })
            .filter((task) => task !== null);
    }
    /** 设置或更新当前会话心跳 */
    async setHeartbeatTask(task) {
        await this.redis.set(`ai:heartbeat:${task.guid}`, JSON.stringify(task));
    }
    /** 关闭当前会话心跳 */
    async clearHeartbeatTask(guid) {
        await this.redis.del(`ai:heartbeat:${guid}`);
    }
    /** 保存指令触发的当前进程重启恢复任务。 */
    async createRestartRecoveryTask(input) {
        const task = buildRestartRecoveryTask(input);
        await this.redis.set(`ai:restart_recovery:${task.id}`, JSON.stringify(task), "EX", RESTART_RECOVERY_TTL_SECONDS);
        return task;
    }
    /** 原子消费全部待恢复任务，确保重启后至多续接一次。 */
    async consumeRestartRecoveryTasks() {
        const keys = await this.redis.keys("ai:restart_recovery:*");
        const tasks = [];
        for (const key of keys) {
            const raw = await this.redis.get(key);
            if (!raw)
                continue;
            const task = parseRestartRecoveryTask(raw);
            if (task &&
                !canConsumeRestartRecoveryTask(task, PROCESS_INSTANCE_ID, PM2_PROCESS_ID)) {
                continue;
            }
            const consumed = await this.redis.eval(`
        local value = redis.call("GET", KEYS[1])
        if value == ARGV[1] then
          redis.call("DEL", KEYS[1])
          return value
        end
        return nil
        `, 1, key, raw);
            if (typeof consumed !== "string")
                continue;
            const consumedTask = parseRestartRecoveryTask(consumed);
            if (consumedTask)
                tasks.push(consumedTask);
        }
        return tasks;
    }
    async deleteRestartRecoveryTask(taskID) {
        await this.redis.del(`ai:restart_recovery:${taskID}`);
    }
    /** 获取所有工具状态 */
    async getAllToolStatus(guid) {
        const tools = await this.getToolDefinitions();
        const status = {};
        for (const tool of tools) {
            const toolName = tool.type === "function" ? tool.function.name : "";
            status[toolName] = await this.getToolStatus(guid, toolName);
        }
        return status;
    }
    // 获取所有可用工具,返回完整工具
    async getAvailableTools(guid) {
        const tools = await this.getToolDefinitions();
        const toolStatus = await this.getAllToolStatus(guid);
        const availableTools = tools.filter((tool) => {
            const toolName = tool.type === "function" ? tool.function.name : "";
            return !toolStatus[toolName] || toolStatus[toolName] === "0";
        });
        return availableTools;
    }
    /** 获取渲染精度 (中:80%, 高:100%, 超高:120%) */
    async getRenderPrecision(guid) {
        const val = await this.redis.get(`ai:render_precision:${guid}`);
        if (val === "中")
            return 0.8;
        if (val === "超高")
            return 1.2;
        return 1.0;
    }
    /** 设置渲染精度 */
    async setRenderPrecision(guid, level) {
        await this.redis.set(`ai:render_precision:${guid}`, level);
    }
    /** 装载工具 */
    async loadTools(guid) {
        const tools = await this.getToolDefinitions();
        const toolStatus = await this.getAllToolStatus(guid);
        const allTools = tools.map((tool) => tool.type === "function" ? tool.function.name : "");
        // 默认禁用的危险工具
        const defaultDisabledTools = ["EvalCode"];
        // 给工具添加默认状态
        const toolsWithStatus = allTools.map((tool) => ({
            name: tool,
            disabled: (toolStatus[tool] && toolStatus[tool] === "1") ||
                (!toolStatus[tool] && defaultDisabledTools.includes(tool)),
        }));
        // 存储工具状态
        for (const tool of toolsWithStatus) {
            if (tool.disabled) {
                await this.disableTool(guid, tool.name);
            }
            else {
                await this.enableTool(guid, tool.name);
            }
        }
        return toolsWithStatus.map((tool) => tool.name);
    }
}
const redisClient = new db(redis);

export { AI_LOCKED_CONFIGS_KEY, DEFAULT_CAPI_CONTEXT_LIMIT, NEXT_USER_MESSAGE_SUBSCRIPTION_TTL_SECONDS, redisClient as default };
