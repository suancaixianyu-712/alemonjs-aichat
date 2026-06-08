import { useMessage, Text, Audio, ImageURL, ImageFile, Mention } from 'alemonjs';
import { log } from 'console';
import OpenAi from 'openai';
import { TTSClient } from '../../api/tts.js';
import { availableTools } from '../../api/aitools.js';
import redisClient from '../../config.js';
import { getChatConfig, shouldSkipAIReply, buildUserMessage, getDeepThoughtReasoning } from './getChatConfig.js';
import { createTTSMessage } from './tts.js';
import { parseAIReply } from './tools.js';

const selects = onSelects(["message.create", "private.message.create"]);
let currentModel = "派蒙-默认"; // 默认音色
const sendAIReply = async (reply, cfg, e, message) => {
    const aireply = await parseAIReply(reply, cfg, e, message);
    console.log("aireply", aireply);
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
const appendPendingGuidanceMessages = async (guid, messages) => {
    const queuedMessages = await redisClient.drainAIGuidanceMessages(guid);
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
        estimatedContextTokens: Math.ceil(contextCharLength / 4),
        promptTokens,
        completionTokens,
        totalTokens: getNumber(usage?.total_tokens),
        cachedTokens: extractCachedTokens(usage),
        cacheMissTokens: extractCacheMissTokens(usage, promptTokens),
        usageAvailable: Boolean(usage),
    });
};
const CApiReply = async (e) => {
    console.log("e.UserId", e.UserId, e.bot);
    const cfg = await getChatConfig(e);
    if (await shouldSkipAIReply(e, cfg)) {
        return {
            next: true,
        };
    }
    // 创建消息
    const [message] = useMessage(e);
    const usermessage = await buildUserMessage(e, cfg, "capi");
    try {
        const openai = new OpenAi({
            baseURL: cfg.config.host,
            apiKey: cfg.config.key,
            timeout: 300000,
        });
        let messages = [
            {
                role: "system",
                content: cfg.systemPrompt + `\n性格约束:${cfg.config.systemPrompt}`,
            },
            ...cfg.historyMessages,
            usermessage,
        ];
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
        createParams["stream"] = false;
        // log("请求AI，参数：", createParams);
        const stream = (await openai.chat.completions.create(createParams));
        await recordCapiContextStats(e.guid, cfg.config.model, messages, stream);
        log("AI回复原始数据:\n", JSON.stringify(stream, null, 2));
        let fullContent = "";
        let toolCalls = [];
        const completion = stream;
        const aiReplyMessage = completion?.choices?.[0]?.message;
        if (aiReplyMessage?.content) {
            fullContent = aiReplyMessage.content;
        }
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
            await redisClient.setAIToolLoopProcessing(e.guid, true);
        }
        try {
            while (true) {
                if (!res.choices[0].message?.tool_calls?.length) {
                    const pendingGuidanceMessages = await appendPendingGuidanceMessages(e.guid, messages);
                    if (pendingGuidanceMessages.length === 0) {
                        break;
                    }
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
                    res = await openai.chat.completions.create(params);
                    await recordCapiContextStats(e.guid, cfg.config.model, messages, res);
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
                    await message.send(format(Text(`AI正在连续调用工具，第 ${toolRound} 轮处理中，请稍等`)));
                }
                messages.push(responseMessage);
                log("模型决定调用工具：", responseMessage.tool_calls);
                if (cfg.toolConfig.toolPromptSwitch === "1") {
                    const useToolsMessage = responseMessage.tool_calls.map((toolCall) => {
                        return `工具调用: ${toolCall.function.name}(${cfg.toolConfig.toolPromptArgsSwitch === "1" ? toolCall.function.arguments : ""})`;
                    });
                    const msgId = await message.send(format(Text(useToolsMessage.join("\n"))));
                    if (cfg.toolConfig.toolPromptRevokeSwitch === "1") {
                        // 10秒后撤回工具调用提示
                        setTimeout(() => {
                            message.delete({ messageId: msgId[0].data.message_id });
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
                const guidanceMessages = await appendPendingGuidanceMessages(e.guid, messages);
                if (guidanceMessages.length > 0) {
                    log("工具调用期间收到补充引导：", guidanceMessages.length);
                }
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
                res = await openai.chat.completions.create(params);
                await recordCapiContextStats(e.guid, cfg.config.model, messages, res);
                // 检查是否还有工具调用需要处理
                if (!res.choices || res.choices.length === 0) {
                    log("AI未返回内容");
                    return;
                }
            }
        }
        finally {
            await redisClient.setAIToolLoopProcessing(e.guid, false);
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
        await redisClient.setAIToolLoopProcessing(e.guid, false);
        console.error("AI回复出错", error);
        message.send(format(Text("AI回复出错了\n" + error)));
        return {
            next: true,
        };
    }
};

export { CApiReply, selects };
