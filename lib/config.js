import { getConfigValue } from 'alemonjs';
import fs from 'fs';
import path from 'path';
import { redis } from './redis.js';

const TOOL_LOOP_TTL_SECONDS = 600;
const TOOL_LOOP_STALE_MS = TOOL_LOOP_TTL_SECONDS * 1000;
const DEFAULT_CAPI_CONTEXT_LIMIT = 256000;
class db {
    redis;
    systemPrompt = "";
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
            const toolCalls = Array.isArray(message.tool_calls)
                ? message.tool_calls.filter((toolCall) => toolCall?.id)
                : [];
            if (message.role === "tool") {
                index += 1;
                continue;
            }
            if (message.role !== "assistant" || toolCalls.length === 0) {
                sanitized.push(message);
                index += 1;
                continue;
            }
            const toolCallIds = new Set(toolCalls.map((toolCall) => String(toolCall.id)));
            const matchedToolIds = new Set();
            const toolMessages = [];
            let cursor = index + 1;
            while (cursor < history.length) {
                const nextMessage = history[cursor];
                if (nextMessage?.role !== "tool") {
                    break;
                }
                const toolCallId = String(nextMessage.tool_call_id || "");
                if (toolCallIds.has(toolCallId)) {
                    matchedToolIds.add(toolCallId);
                    toolMessages.push(nextMessage);
                    cursor += 1;
                    continue;
                }
                break;
            }
            if (matchedToolIds.size === toolCallIds.size) {
                sanitized.push(message, ...toolMessages);
            }
            index = cursor;
        }
        return sanitized;
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
    formatHistoryMessage(message) {
        if (!message || typeof message !== "object") {
            return "";
        }
        const role = String(message.role || "unknown");
        const name = message.name ? `(${message.name})` : "";
        const content = this.extractMessageText(message.content);
        const trimmed = content.trim();
        if (!trimmed) {
            return `${role}${name}: [空内容]`;
        }
        return `${role}${name}: ${trimmed}`;
    }
    buildChatHistoryTranscript(history) {
        return history
            .map((message) => this.formatHistoryMessage(message))
            .filter(Boolean)
            .join("\n");
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
        host: "",
        key: "",
        model: "",
        temperature: 0.7,
        max_tokens: 150,
        systemPrompt: "",
        rapi: false,
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
    /** 获取AI列表 */
    async getAIList() {
        const keys = await this.redis.keys("ai:list:*");
        return keys.map((key) => key.replace("ai:list:", ""));
    }
    /** 设置AI列表项 */
    async setAIList(name, config) {
        await this.redis.set(`ai:list:${name}`, JSON.stringify(config));
    }
    /** 新增AI配置并切换 */
    async addAI(guid, name, host, key, model) {
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
    async deleteAI(name) {
        const aiConfigStr = await this.redis.get(`ai:list:${name}`);
        if (!aiConfigStr) {
            console.log("删除失败, 无此模型");
            return false;
        }
        await this.redis.del(`ai:list:${name}`);
        return true;
    }
    /** 切换AI */
    async switchAI(guid, name) {
        const aiConfigStr = await this.redis.get(`ai:list:${name}`);
        if (!aiConfigStr) {
            console.log("切换失败, 无此AI");
            await this.setAIConfig(guid, db.defaultAIConfig);
            return null;
        }
        const aiConfig = JSON.parse(aiConfigStr);
        const currentConfig = await this.getAIConfig(guid);
        aiConfig.systemPrompt = currentConfig.systemPrompt;
        await this.setAIConfig(guid, aiConfig);
        // 记录当前切换的ai名字
        await this.redis.set(`ai:currentAI:${guid}`, name);
        return aiConfig;
    }
    /** 获取当前使用的AI名称 */
    async getCurrentAI(guid) {
        return (await this.redis.get(`ai:currentAI:${guid}`)) || "";
    }
    /** 切换AI的RAPI模式 */
    async switchModelRAPI(aiName, enable) {
        const aiConfigStr = await this.redis.get(`ai:list:${aiName}`);
        if (!aiConfigStr) {
            console.log("切换失败, 无此AI");
            return;
        }
        const aiConfig = JSON.parse(aiConfigStr);
        aiConfig.rapi = enable;
        await this.setAIList(aiName, aiConfig);
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
        const summary = options?.summary?.trim() || this.buildFallbackSummary(history, transcript);
        const detail = options?.detail?.trim() || this.buildFallbackDetail(history, transcript);
        const record = {
            id,
            guid,
            summary,
            detail,
            transcript,
            history,
            reason: options?.reason || "manual",
            createdAt: Date.now(),
        };
        await this.setSummary(guid, id, summary);
        await this.setSummaryDetail(guid, id, detail);
        await this.redis.set(this.getArchiveRecordKey(guid, id), JSON.stringify(record));
        return record;
    }
    /** 清理工具循环等临时会话状态 */
    async clearAITransientState(guid) {
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
        const keys = (await Promise.all(keyPatterns.map((pattern) => this.redis.keys(pattern)))).flat();
        if (keys.length > 0) {
            await this.redis.del(...keys);
        }
        return;
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
    /** 设置工具调用中的处理状态 */
    async setAIToolLoopProcessing(guid, processing, platform) {
        if (processing) {
            const now = Date.now();
            const state = {
                processing: true,
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
    async getAIToolLoopProcessing(guid, platform) {
        const key = this.getToolLoopStateKey(guid, platform);
        let processing = await this.redis.get(key);
        if (!processing && platform) {
            processing = await this.redis.get(`ai:tool_loop_processing:${guid}`);
        }
        if (!processing) {
            return "0";
        }
        let state = null;
        if (processing !== "1") {
            try {
                const parsed = JSON.parse(processing);
                if (parsed?.processing === true) {
                    state = parsed;
                }
            }
            catch {
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
        await this.redis.set(`ai:summary:${guid}:${id}`, `${summary}`);
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
        await this.redis.set(`ai:summary_detail:${guid}:${id}`, `${detail}`);
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
        const raw = await this.redis.get(this.getArchiveRecordKey(guid, id));
        if (!raw) {
            const summary = await this.getSummary(guid, id);
            const detail = await this.getSummaryDetail(guid, id);
            if (!summary && !detail) {
                return null;
            }
            return {
                id,
                guid,
                summary: summary || "无摘要",
                detail: detail || "",
                transcript: detail || "",
                history: [],
                reason: "legacy",
                createdAt: Number(id) || 0,
            };
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    /** 获取归档记录列表 */
    async listArchivedChatRecords(guid, limit = 20) {
        const pattern = guid
            ? this.getArchiveRecordKey(guid, "*")
            : this.getArchiveRecordKey("*", "*");
        const keys = await this.redis.keys(pattern);
        const records = await Promise.all(keys.map(async (key) => {
            const raw = await this.redis.get(key);
            if (!raw)
                return null;
            try {
                return JSON.parse(raw);
            }
            catch {
                return null;
            }
        }));
        const merged = new Map();
        for (const record of records) {
            if (!record)
                continue;
            merged.set(`${record.guid}:${record.id}`, record);
        }
        const summaryPattern = guid ? `ai:summary:${guid}:*` : "ai:summary:*";
        const summaryKeys = await this.redis.keys(summaryPattern);
        for (const key of summaryKeys) {
            const [, , summaryGuid, summaryId] = key.split(":");
            const recordKey = `${summaryGuid}:${summaryId}`;
            if (merged.has(recordKey)) {
                continue;
            }
            const [summary, detail] = await Promise.all([
                this.redis.get(key),
                this.getSummaryDetail(summaryGuid, summaryId),
            ]);
            if (!summary && !detail) {
                continue;
            }
            merged.set(recordKey, {
                id: summaryId,
                guid: summaryGuid,
                summary: summary || "无摘要",
                detail: detail || "",
                transcript: detail || "",
                history: [],
                reason: "legacy",
                createdAt: Number(summaryId) || 0,
            });
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
    /** --------------------------------------------------------- */
    /** 容器管理 */
    /** 获取群容器配置 */
    async getGroupContainer(groupId) {
        const str = await this.redis.get(`ai:container:group:${groupId}`);
        return str ? JSON.parse(str) : null;
    }
    /** 设置群容器配置 */
    async setGroupContainer(groupId, config) {
        await this.redis.set(`ai:container:group:${groupId}`, JSON.stringify(config));
    }
    /** 获取用户容器配置 */
    async getUserContainer(userId) {
        const str = await this.redis.get(`ai:container:user:${userId}`);
        return str ? JSON.parse(str) : null;
    }
    /** 设置用户容器配置 */
    async setUserContainer(userId, config) {
        await this.redis.set(`ai:container:user:${userId}`, JSON.stringify(config));
    }
    /** 获取用户当前 exec 环境配置（按群隔离） */
    async getExecEnv(groupId, userId) {
        const key = groupId === "private"
            ? `ai:container:env:private:${userId}`
            : `ai:container:env:${groupId}:${userId}`;
        const str = await this.redis.get(key);
        return str ? JSON.parse(str) : null;
    }
    /** 设置用户当前 exec 环境配置（按群隔离） */
    async setExecEnv(groupId, userId, config) {
        const key = groupId === "private"
            ? `ai:container:env:private:${userId}`
            : `ai:container:env:${groupId}:${userId}`;
        await this.redis.set(key, JSON.stringify(config));
    }
    /** 创建群容器（首次触发时自动创建） */
    async ensureGroupContainer(groupId) {
        const existing = await this.getGroupContainer(groupId);
        if (existing)
            return existing;
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
    async ensureUserContainer(userId) {
        const existing = await this.getUserContainer(userId);
        if (existing)
            return existing;
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
    async initExecEnv(groupId, userId) {
        const existing = await this.getExecEnv(groupId, userId);
        if (existing)
            return existing;
        if (groupId === "private") {
            const userConfig = await this.ensureUserContainer(userId);
            await this.setExecEnv("private", userId, { ...userConfig, type: "user" });
            return userConfig;
        }
        else {
            const groupConfig = await this.ensureGroupContainer(groupId);
            await this.setExecEnv(groupId, userId, { ...groupConfig, type: "group" });
            return groupConfig;
        }
    }
    /** 切换到群容器 */
    async switchToGroupContainer(groupId, userId) {
        const groupConfig = await this.ensureGroupContainer(groupId);
        await this.setExecEnv(groupId, userId, { ...groupConfig, type: "group" });
        return groupConfig;
    }
    /** 切换到用户容器 */
    async switchToUserContainer(groupId, userId) {
        const userConfig = await this.ensureUserContainer(userId);
        await this.setExecEnv(groupId, userId, { ...userConfig, type: "user" });
        return userConfig;
    }
    /** 切换到系统环境 */
    async switchToSystemEnv(groupId, userId) {
        await this.setExecEnv(groupId, userId, { type: "system" });
    }
    /** 切换到远程节点环境 */
    async switchToRemoteEnv(groupId, userId, nodeName) {
        await this.setExecEnv(groupId, userId, { type: "remote", nodeName });
    }
    /** 切换到 Singularity 环境 */
    async switchToSingularityEnv(groupId, userId, nodeName, image) {
        await this.setExecEnv(groupId, userId, { type: "singularity", nodeName, singularityImage: image });
    }
    /** 判断是否为超级管理员 */
    isSuperAdmin(userId) {
        const configValue = getConfigValue();
        const superAdmins = configValue.aiChat?.superAdmin || [];
        return superAdmins.includes(userId);
    }
    /** 获取所有容器配置 key */
    async getAllContainerKeys() {
        const groupKeys = await this.redis.keys("ai:container:group:*");
        const userKeys = await this.redis.keys("ai:container:user:*");
        return [...groupKeys, ...userKeys];
    }
    /** 删除指定容器配置 */
    async deleteContainer(key) {
        await this.redis.del(key);
    }
    /** --------------------------------------------------------- */
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
        const defaultDisabledTools = ["exec", "EvalCode"];
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

export { DEFAULT_CAPI_CONTEXT_LIMIT, redisClient as default };
