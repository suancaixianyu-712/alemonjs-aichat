import { useMessage, Audio, Text, ImageURL, ImageFile, Mention } from 'alemonjs';
import { log } from 'console';
import OpenAi from 'openai';
import { TTSClient } from '../../api/tts.js';
import { availableTools } from '../../api/aitools.js';
import redisClient, { DEFAULT_CAPI_CONTEXT_LIMIT } from '../../config.js';
import { getChatConfig, shouldSkipAIReply, buildUserMessage, getDeepThoughtReasoning } from './getChatConfig.js';
import { createTTSMessage } from './tts.js';
import { parseAIReply, sendAIReplyToOutput } from './tools.js';

const selects = onSelects(["message.create", "private.message.create"]);
let currentModel = "派蒙-默认"; // 默认音色
const CAPI_CONTEXT_COMPRESSION_RATIO = 0.9;
const CAPI_CONTEXT_RETAIN_RATIO = 0.35;
const AUTO_SUMMARY_DETAIL_MAX_LENGTH = 2000;
const sendAIReply = async (reply, cfg, e, message) => {
    const aireply = await parseAIReply(reply, cfg, e, message);
    console.log("aireply", aireply);
    if (await sendAIReplyToOutput(message, aireply)) {
        return aireply;
    }
    if (aireply?.ttsMessages) {
        for (const ttsMsg of aireply.ttsMessages) {
            const ttsMessage = await createTTSMessage(ttsMsg.text, new TTSClient(), ttsMsg.model ?? currentModel);
            await message.send(format(Audio(ttsMessage)));
        }
    }
    if (aireply?.replyMessages) {
        for (const msg of aireply.replyMessages) {
            await message.send(format(Text(msg.text), ...(msg.images || []).map((img) => {
                return /^https?:\/\//.test(img) ? ImageURL(img) : ImageFile(img);
            }), ...(msg.at || []).map((uid) => Mention(uid))));
        }
    }
    return aireply;
};
const sendOutputText = async (message, text) => {
    if (typeof message?.sendText === "function") {
        return await message.sendText(text);
    }
    return await message.send(format(Text(text)));
};
const appendPendingGuidanceMessages = async (guid, platform, messages) => {
    const queuedMessages = await redisClient.drainAIGuidanceMessages(guid, platform);
    if (!queuedMessages.length) {
        return [];
    }
    const guidanceMessages = queuedMessages
        .map((item) => item?.capiMessage || item)
        .filter(Boolean);
    if (!guidanceMessages.length) {
        return [];
    }
    messages.push(...guidanceMessages);
    await redisClient.addAIChatHistoryBatch(guid, guidanceMessages);
    return guidanceMessages;
};
const extractTextValue = (value) => {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => extractTextValue(item))
            .filter((text) => text.trim() !== "")
            .join("\n");
    }
    if (value && typeof value === "object") {
        return extractTextValue(value.text ?? value.content ?? value.summary ?? "");
    }
    return "";
};
const getToolCallDisplayContent = (message) => {
    const content = extractTextValue(message?.content);
    if (content.trim() !== "") {
        return content;
    }
    return extractTextValue(message?.reasoning_content ??
        message?.reasoningContent ??
        message?.reasoning);
};
const getTextLength = (value) => {
    if (typeof value === "string") {
        return value.length;
    }
    if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + getTextLength(item), 0);
    }
    if (value && typeof value === "object") {
        return Object.values(value).reduce((sum, item) => sum + getTextLength(item), 0);
    }
    return 0;
};
const estimateContextTokens = (value) => {
    return Math.ceil(getTextLength(value) / 4);
};
const trimText = (text, maxLength) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
};
const takeTailMessagesWithinTokenBudget = (history, tokenBudget) => {
    const kept = [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
        kept.unshift(history[index]);
        if (estimateContextTokens(kept) > tokenBudget) {
            kept.shift();
            break;
        }
    }
    return kept;
};
const buildAutoSummaryMessage = (record) => {
    const summary = record?.summary || "较早对话已自动归档";
    const detail = trimText(record?.detail || record?.transcript || "无详细摘要", AUTO_SUMMARY_DETAIL_MAX_LENGTH);
    return {
        role: "system",
        content: [
            "【自动压缩上下文】",
            `较早对话已归档为 ${record?.id || "未知ID"}，当前上下文只保留摘要和最近消息。`,
            `摘要: ${summary}`,
            `详细信息: ${detail}`,
            "如需更完整内容，可按归档ID或关键词调用 MemoryOperation 检索历史归档。",
        ].join("\n"),
    };
};
const prepareCapiMessagesForRequest = async (guid, systemMessage, currentMessages) => {
    const limit = await redisClient.getCAPIContextLimit(guid);
    const threshold = Math.floor(limit * CAPI_CONTEXT_COMPRESSION_RATIO);
    const estimatedTokens = estimateContextTokens(currentMessages);
    if (estimatedTokens < threshold) {
        return currentMessages;
    }
    const history = await redisClient.getAIChatHistory(guid);
    if (history.length === 0) {
        return currentMessages;
    }
    const archived = await redisClient.archiveAIChatHistory(guid, {
        reason: "auto_context_compress",
    });
    if (!archived) {
        return currentMessages;
    }
    const minRetainBudget = Math.min(Math.floor(DEFAULT_CAPI_CONTEXT_LIMIT * 0.05), Math.floor(limit * 0.5));
    const retainBudget = Math.max(Math.floor(limit * CAPI_CONTEXT_RETAIN_RATIO), minRetainBudget);
    const keptHistory = takeTailMessagesWithinTokenBudget(history, retainBudget);
    const compressedHistory = [buildAutoSummaryMessage(archived), ...keptHistory];
    await redisClient.setAIChatHistory(guid, compressedHistory);
    const rebuiltMessages = [systemMessage, ...compressedHistory];
    const pendingMessages = currentMessages.slice(Math.max(1 + history.length, 1));
    rebuiltMessages.push(...pendingMessages);
    log(`CAPI上下文接近上限，已自动压缩：${estimatedTokens}/${limit} tokens，归档ID:${archived.id}`);
    return rebuiltMessages;
};
const getNumber = (value) => {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const extractCachedTokens = (usage) => {
    return getNumber(usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens ??
        usage?.prompt_cache_hit_tokens);
};
const extractCacheMissTokens = (usage, promptTokens) => {
    const explicitMissTokens = getNumber(usage?.prompt_cache_miss_tokens);
    if (explicitMissTokens !== null) {
        return explicitMissTokens;
    }
    const cachedTokens = extractCachedTokens(usage);
    if (promptTokens !== null && cachedTokens !== null) {
        return Math.max(promptTokens - cachedTokens, 0);
    }
    return null;
};
const recordCapiContextStats = async (guid, model, messages, completion) => {
    const usage = completion?.usage;
    const promptTokens = getNumber(usage?.prompt_tokens ?? usage?.input_tokens);
    const completionTokens = getNumber(usage?.completion_tokens ?? usage?.output_tokens);
    const contextCharLength = getTextLength(messages);
    await redisClient.recordAIContextStats(guid, {
        mode: "capi",
        model,
        contextMessageCount: messages.length,
        contextCharLength,
        estimatedContextTokens: estimateContextTokens(messages),
        promptTokens,
        completionTokens,
        totalTokens: getNumber(usage?.total_tokens),
        cachedTokens: extractCachedTokens(usage),
        cacheMissTokens: extractCacheMissTokens(usage, promptTokens),
        usageAvailable: Boolean(usage),
    });
};
const CApiReply = async (e, outputMessage) => {
    console.log("e.UserId", e.UserId, e.bot);
    const cfg = await getChatConfig(e);
    if (await shouldSkipAIReply(e, cfg)) {
        return {
            next: true,
        };
    }
    // 创建消息
    const [message] = outputMessage ? [outputMessage] : useMessage(e);
    const usermessage = await buildUserMessage(e, cfg, "capi");
    try {
        const openai = new OpenAi({
            baseURL: cfg.config.host,
            apiKey: cfg.config.key,
            timeout: 300000,
        });
        const shouldStreamToOutput = typeof outputMessage?.streamTextDelta === "function";
        const requestChatCompletion = async (params, requestMessages) => {
            if (!shouldStreamToOutput) {
                const completion = await openai.chat.completions.create(params);
                await recordCapiContextStats(e.guid, cfg.config.model, requestMessages, completion);
                return completion;
            }
            const streamParams = {
                ...params,
                stream: true,
            };
            const stream = (await openai.chat.completions.create(streamParams));
            let content = "";
            let reasoningContent = "";
            const toolCalls = [];
            const ensureToolCall = (index) => {
                if (!toolCalls[index]) {
                    toolCalls[index] = {
                        id: "",
                        type: "function",
                        function: {
                            name: "",
                            arguments: "",
                        },
                    };
                }
                return toolCalls[index];
            };
            for await (const chunk of stream) {
                const delta = chunk?.choices?.[0]?.delta || {};
                const text = extractTextValue(delta.content ?? "");
                if (text) {
                    content += text;
                    await outputMessage.streamTextDelta(text);
                }
                const reasoningDelta = extractTextValue(delta.reasoning_content ?? delta.reasoningContent ?? "");
                if (reasoningDelta) {
                    reasoningContent += reasoningDelta;
                }
                if (Array.isArray(delta.tool_calls)) {
                    for (const item of delta.tool_calls) {
                        const indexValue = Number(item.index);
                        const index = Number.isFinite(indexValue) ? indexValue : 0;
                        const toolCall = ensureToolCall(index);
                        if (item.id)
                            toolCall.id = item.id;
                        if (item.type)
                            toolCall.type = item.type;
                        if (item.function?.name) {
                            toolCall.function.name += item.function.name;
                        }
                        if (item.function?.arguments) {
                            toolCall.function.arguments += item.function.arguments;
                        }
                    }
                }
            }
            const normalizedToolCalls = toolCalls.filter((item) => item?.function?.name);
            return {
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content,
                            reasoning_content: reasoningContent,
                            tool_calls: normalizedToolCalls.length
                                ? normalizedToolCalls
                                : undefined,
                        },
                    },
                ],
            };
        };
        const systemMessage = {
            role: "system",
            content: cfg.systemPrompt + `\n性格约束:${cfg.config.systemPrompt}`,
        };
        let messages = [
            systemMessage,
            ...cfg.historyMessages,
            usermessage,
        ];
        messages = await prepareCapiMessagesForRequest(e.guid, systemMessage, messages);
        const createParams = {
            model: cfg.config.model,
            messages: messages,
        };
        if (cfg.toolConfig.toolSwitch === "1") {
            createParams["tools"] = cfg.toolConfig.cApiToolList;
            createParams["tool_choice"] = "auto";
        }
        const deepThoughtReasoning = getDeepThoughtReasoning(cfg);
        Object.assign(createParams, deepThoughtReasoning);
        if (!shouldStreamToOutput) {
            createParams["stream"] = false;
        }
        // log("请求AI，参数：", createParams);
        const stream = await requestChatCompletion(createParams, messages);
        log("AI回复原始数据:\n", JSON.stringify(stream, null, 2));
        let fullContent = "";
        let toolCalls = [];
        const completion = stream;
        const aiReplyMessage = completion?.choices?.[0]?.message;
        fullContent = getToolCallDisplayContent(aiReplyMessage);
        if (Array.isArray(aiReplyMessage?.tool_calls)) {
            toolCalls = aiReplyMessage.tool_calls.map((tc) => ({
                id: tc.id || "",
                type: "function",
                function: {
                    name: tc.function?.name || "",
                    arguments: tc.function?.arguments || "",
                },
            }));
        }
        let res = {
            choices: [
                {
                    message: {
                        ...aiReplyMessage,
                        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                    },
                },
            ],
        };
        if (!res.choices || res.choices.length === 0) {
            log("AI未返回内容");
            return;
        }
        await redisClient.addAIChatHistory(e.guid, usermessage);
        if (cfg.toolConfig.toolCallContentSwitch === "1" &&
            res.choices[0].message?.tool_calls &&
            fullContent.trim() !== "") {
            await sendAIReply(fullContent, cfg, e, message);
        }
        // 检查是否有工具调用需要处理
        let toolRound = 0;
        if (res.choices[0].message?.tool_calls?.length) {
            await redisClient.setAIToolLoopProcessing(e.guid, true, e.Platform);
        }
        try {
            while (true) {
                if (!res.choices[0].message?.tool_calls?.length) {
                    const pendingGuidanceMessages = await appendPendingGuidanceMessages(e.guid, e.Platform, messages);
                    if (pendingGuidanceMessages.length === 0) {
                        break;
                    }
                    messages = await prepareCapiMessagesForRequest(e.guid, systemMessage, messages);
                    log("工具调用完成后收到补充引导，继续请求模型：", pendingGuidanceMessages.length);
                    const params = {
                        model: cfg.config.model,
                        messages: messages,
                    };
                    if (cfg.toolConfig.toolSwitch === "1") {
                        params.tools = cfg.toolConfig.cApiToolList;
                        params.tool_choice = "auto";
                    }
                    Object.assign(params, getDeepThoughtReasoning(cfg));
                    res = await requestChatCompletion(params, messages);
                    if (!res.choices || res.choices.length === 0) {
                        log("AI未返回内容");
                        return;
                    }
                    continue;
                }
                toolRound += 1;
                const responseMessage = res.choices[0].message;
                log("AI返回工具调用，内容：-----", res.choices[0]);
                // 先处理对话
                if (toolRound >= 10 && toolRound % 10 === 0) {
                    await sendOutputText(message, `AI正在连续调用工具，第 ${toolRound} 轮处理中，请稍等`);
                }
                messages.push(responseMessage);
                log("模型决定调用工具：", responseMessage.tool_calls);
                if (cfg.toolConfig.toolPromptSwitch === "1") {
                    const useToolsMessage = responseMessage.tool_calls.map((toolCall) => {
                        return `工具调用: ${toolCall.function.name}(${cfg.toolConfig.toolPromptArgsSwitch === "1" ? toolCall.function.arguments : ""})`;
                    });
                    const msgId = await sendOutputText(message, useToolsMessage.join("\n"));
                    if (cfg.toolConfig.toolPromptRevokeSwitch === "1") {
                        // 10秒后撤回工具调用提示
                        setTimeout(() => {
                            const messageId = msgId?.[0]?.data?.message_id;
                            if (messageId && typeof message?.delete === "function") {
                                message.delete({ messageId });
                            }
                        }, 10000);
                    }
                }
                const toolMessages = [];
                for (const toolCall of responseMessage.tool_calls) {
                    const functionName = toolCall.function.name;
                    let functionArgs = {};
                    try {
                        functionArgs = toolCall.function.arguments
                            ? JSON.parse(toolCall.function.arguments)
                            : {};
                    }
                    catch (err) {
                        console.error(`工具参数解析失败：${functionName}`, err);
                        functionArgs = {};
                    }
                    const functionToCall = availableTools[functionName];
                    let functionResult;
                    if (!functionToCall) {
                        console.error(`未找到函数：${functionName}`);
                        functionResult = {
                            ok: false,
                            error: `未找到函数：${functionName}`,
                        };
                    }
                    else {
                        try {
                            if ((await redisClient.getToolStatus(e.guid, functionName)) === "1") {
                                console.error(`工具被禁用：${functionName}`);
                                functionResult = {
                                    ok: false,
                                    error: `工具被禁用：${functionName}`,
                                };
                            }
                            else {
                                functionResult = await functionToCall(functionArgs);
                            }
                        }
                        catch (err) {
                            console.error(`工具执行失败：${functionName}`, err);
                            functionResult = {
                                ok: false,
                                error: err?.message || String(err) || "工具执行失败",
                            };
                        }
                    }
                    if (typeof message?.sendToolResult === "function") {
                        await message.sendToolResult(functionName, functionResult);
                    }
                    const toolContent = JSON.stringify(typeof functionResult === "undefined"
                        ? { ok: true, result: null }
                        : functionResult);
                    // 把工具执行结果作为 tool role 消息加回对话
                    const toolMessage = {
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: functionName,
                        content: toolContent,
                        reasoning_content: responseMessage.reasoning_content || "",
                    };
                    messages.push(toolMessage);
                    toolMessages.push(toolMessage);
                }
                await redisClient.addAIChatHistoryBatch(e.guid, [
                    responseMessage,
                    ...toolMessages,
                ]);
                const guidanceMessages = await appendPendingGuidanceMessages(e.guid, e.Platform, messages);
                if (guidanceMessages.length > 0) {
                    log("工具调用期间收到补充引导：", guidanceMessages.length);
                }
                messages = await prepareCapiMessagesForRequest(e.guid, systemMessage, messages);
                const params = {
                    model: cfg.config.model,
                    messages: messages,
                    tools: cfg.toolConfig.cApiToolList,
                    tool_choice: "auto",
                };
                const deepThoughtReasoning = getDeepThoughtReasoning(cfg);
                Object.assign(params, deepThoughtReasoning);
                // log("重新请求AI，参数：", params);
                // 重新请求
                res = await requestChatCompletion(params, messages);
                // 检查是否还有工具调用需要处理
                if (!res.choices || res.choices.length === 0) {
                    log("AI未返回内容");
                    return;
                }
            }
        }
        finally {
            await redisClient.setAIToolLoopProcessing(e.guid, false, e.Platform);
        }
        // 如果没有工具调用，处理最终回复
        let reply = res.choices?.[0]?.message?.content?.trim() || `${cfg.botName}:[]`;
        if (reply === `${cfg.botName}:[]`) {
            log("AI选择不回复");
            return;
        }
        console.log("AI回复原文:\n", JSON.stringify(res, null, 2));
        // 处理消息
        // 提取ai发送的消息有多少条
        const aireply = await sendAIReply(reply, cfg, e, message);
        const assistantMessage = res.choices?.[0]?.message;
        if (assistantMessage) {
            await redisClient.addAIChatHistory(e.guid, assistantMessage);
        }
        return {
            next: aireply.nextCommands.length > 0,
            commands: aireply.nextCommands[0] ? aireply.nextCommands : undefined,
        };
    }
    catch (error) {
        await redisClient.setAIToolLoopProcessing(e.guid, false, e.Platform);
        console.error("AI回复出错", error);
        await sendOutputText(message, "AI回复出错了\n" + error);
        return {
            next: true,
        };
    }
};

export { CApiReply, selects };
