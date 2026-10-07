import { useMessage, Text, Image, ImageURL, ImageFile, Mention } from 'alemonjs';
import { log } from 'console';
import OpenAi from 'openai';
import { isImageUrlToolContent } from '../../api/image-url-tool.js';
import { sendSpeechToolResult } from '../../api/speech.js';
import { getOpenAIProxyFetch } from '../../api/openaiProxy.js';
import { getAiChatConfigValue } from '../../config/app.js';
import { beginAITurn, throwIfAITurnAborted, awaitWithAITurnAbort, isAITurnAbortError } from '../../api/ai-turn.js';
import { removePublicIpFromOutput, availableTools, assertGroupFullToolAccess, assertAgentToolAccess, removePublicIpFromToolArguments } from '../../api/aitools.js';
import redisClient, { DEFAULT_CAPI_CONTEXT_LIMIT } from '../../config.js';
import { getChatConfig, shouldSkipAIReply, buildUserMessage, getDeepThoughtReasoning, bindDescribeImageUrl } from './getChatConfig.js';
import { executeAlemonCommand } from '../../routes/commands.js';
import { removeThinkContent, parseAIReply, sendAIReplyToOutput } from './tools.js';
import { shouldSuppressFollowupReply } from './followup-reply.js';
import { requestRapiCompletion } from './rapi.js';
import { getProviderBuiltinToolParams } from './provider-tools.js';
import { createScbbsProgress } from './scbbs-progress.js';
import { buildXianyuGameSession } from '../../api/xianyu-game.js';
import { getLockedAIMessage } from '../../api/ai-lock.js';
import { annotatePermissionBoundary } from '../../api/user-permission.js';

const selects = onSelects(["message.create", "private.message.create"]);
const CAPI_CONTEXT_COMPRESSION_RATIO = 0.9;
const CAPI_CONTEXT_RETAIN_RATIO = 0.35;
const AUTO_SUMMARY_DETAIL_MAX_LENGTH = 2000;
const applyProviderBuiltinTools = (params, cfg) => {
    const native = getProviderBuiltinToolParams(cfg.config);
    if (cfg.config.apiMode === "rapi") {
        params.builtinTools = native.rapiTools;
        params.builtinIncludes = native.include;
    }
    else {
        Object.assign(params, native.capiParams ?? {});
    }
    return params;
};
const sendAIReply = async (reply, cfg, e, message) => {
    const safeReply = removePublicIpFromOutput(reply, e.IsMaster === true);
    const aireply = await parseAIReply(safeReply, cfg, e, message);
    console.log("aireply", aireply);
    if (await sendAIReplyToOutput(message, aireply)) {
        return aireply;
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
const sendOutputText = async (message, text, isMaster) => {
    const safeText = removePublicIpFromOutput(text, isMaster === true);
    if (typeof message?.sendText === "function") {
        return await message.sendText(safeText);
    }
    return await message.send(format(Text(safeText)));
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
    const content = removeThinkContent(extractTextValue(message?.content));
    if (content.trim() !== "") {
        return content;
    }
    const reasoningContent = extractTextValue(message?.reasoning_content ??
        message?.reasoningContent ??
        message?.reasoning);
    const closingThinkTags = [...reasoningContent.matchAll(/<\/think\s*>/gi)];
    const lastClosingThinkTag = closingThinkTags.at(-1);
    if (!lastClosingThinkTag || lastClosingThinkTag.index === undefined) {
        return "";
    }
    return removeThinkContent(reasoningContent.slice(lastClosingThinkTag.index + lastClosingThinkTag[0].length));
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
    // 截断可能切在 tool 组中间，必须再清洗一次
    return redisClient.sanitizeChatMessages(kept);
};
const normalizeAssistantToolCalls = (toolCalls) => {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        return [];
    }
    return toolCalls
        .filter((item) => item?.function?.name)
        .map((item, index) => ({
        id: String(item.id || "").trim() || `call_${Date.now()}_${index}`,
        type: item.type || "function",
        function: {
            name: String(item.function.name),
            arguments: typeof item.function.arguments === "string"
                ? item.function.arguments
                : JSON.stringify(item.function.arguments ?? {}),
        },
    }));
};
const stripRapiMetadata = (messages) => messages.map((message) => {
    if (!message ||
        typeof message !== "object" ||
        !("_rapiOutput" in message)) {
        return message;
    }
    const { _rapiOutput: _ignored, ...cleanMessage } = message;
    return cleanMessage;
});
const buildToolResultMessage = (toolCall, functionName, functionResult) => {
    if (isImageUrlToolContent(functionResult)) {
        return {
            role: "tool",
            tool_call_id: String(toolCall?.id || "").trim(),
            name: functionName,
            content: "图片已转换，图片内容见下一条输入。",
        };
    }
    const toolContent = JSON.stringify(annotatePermissionBoundary(typeof functionResult === "undefined"
        ? { ok: true, result: null }
        : functionResult));
    return {
        role: "tool",
        tool_call_id: String(toolCall?.id || "").trim(),
        name: functionName,
        content: toolContent,
    };
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
    const compressedSeed = [buildAutoSummaryMessage(archived), ...keptHistory];
    await redisClient.setAIChatHistory(guid, compressedSeed);
    // set 后重新读取，确保与 sanitize 后的 redis 历史一致，避免本地未清洗副本
    const compressedHistory = await redisClient.getAIChatHistory(guid);
    const pendingMessages = currentMessages.slice(Math.max(1 + history.length, 1));
    const rebuiltMessages = redisClient.sanitizeChatMessages([
        systemMessage,
        ...compressedHistory,
        ...pendingMessages,
    ]);
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
const recordCapiContextStats = async (guid, model, messages, completion, mode = "capi") => {
    const usage = completion?.usage;
    const promptTokens = getNumber(usage?.prompt_tokens ?? usage?.input_tokens);
    const completionTokens = getNumber(usage?.completion_tokens ?? usage?.output_tokens);
    const contextCharLength = getTextLength(messages);
    await redisClient.recordAIContextStats(guid, {
        mode,
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
    if (e.IsMaster !== true && e.__allowLockedAI !== true) {
        const currentAI = await redisClient.getCurrentAI(e.guid);
        if (currentAI && (!await redisClient.canUseLockedAI(e.guid, e.name !== "private.message.create", currentAI))) {
            const [message] = outputMessage ? [outputMessage] : useMessage(e);
            await message.send(format(Text(getLockedAIMessage(currentAI))));
            return { next: false };
        }
    }
    const cfg = await getChatConfig(e);
    const internalAllowedToolNames = Array.isArray(e.__allowedToolNames)
        ? new Set(e.__allowedToolNames
            .map((name) => String(name ?? "").trim())
            .filter(Boolean))
        : null;
    const getTurnTools = () => internalAllowedToolNames
        ? cfg.toolConfig.cApiToolList.filter((tool) => internalAllowedToolNames.has(String(tool?.function?.name ?? "")))
        : cfg.toolConfig.cApiToolList;
    if (await shouldSkipAIReply(e, cfg)) {
        return {
            next: true,
        };
    }
    // 创建消息
    const [message] = outputMessage ? [outputMessage] : useMessage(e);
    const usermessage = await buildUserMessage(e, cfg);
    const currentImageUrls = Array.isArray(usermessage.validImageUrls)
        ? usermessage.validImageUrls
        : [];
    const describedCurrentImageUrls = new Set();
    const generatedCurrentImageUrls = new Set();
    console.log("发送给AI的当前消息:\n", JSON.stringify(usermessage, null, 2));
    const turnUserID = String(e.UserId || "");
    const acquiredTurnLock = await redisClient.acquireAIToolLoop(e.guid, turnUserID, e.Platform);
    if (!acquiredTurnLock) {
        return {
            next: false,
            busy: true,
        };
    }
    const aiTurn = beginAITurn(e.guid, e.Platform, turnUserID);
    const progress = createScbbsProgress(e);
    let progressStatus = "completed";
    try {
        const openai = new OpenAi({
            baseURL: cfg.config.host,
            apiKey: cfg.config.key,
            timeout: 300000,
            fetch: getOpenAIProxyFetch(getAiChatConfigValue().httpProxy, redisClient.isAIProxyEnabled(cfg.config)),
        });
        const shouldStreamToOutput = typeof outputMessage?.streamTextDelta === "function";
        const requestChatCompletion = async (params, requestMessages) => {
            throwIfAITurnAborted(aiTurn.signal);
            if (cfg.config.apiMode === "rapi") {
                const completion = await requestRapiCompletion({
                    client: openai,
                    params,
                    signal: aiTurn.signal,
                    onTextDelta: shouldStreamToOutput
                        ? (text) => outputMessage.streamTextDelta(text)
                        : undefined,
                });
                throwIfAITurnAborted(aiTurn.signal);
                await recordCapiContextStats(e.guid, cfg.config.model, requestMessages, completion, "rapi");
                return completion;
            }
            if (!shouldStreamToOutput) {
                const completion = await openai.chat.completions.create({ ...params, messages: stripRapiMetadata(params.messages || []) }, {
                    signal: aiTurn.signal,
                });
                throwIfAITurnAborted(aiTurn.signal);
                await recordCapiContextStats(e.guid, cfg.config.model, requestMessages, completion);
                return completion;
            }
            const streamParams = {
                ...params,
                messages: stripRapiMetadata(params.messages || []),
                stream: true,
            };
            const stream = (await openai.chat.completions.create(streamParams, {
                signal: aiTurn.signal,
            }));
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
                throwIfAITurnAborted(aiTurn.signal);
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
            const normalizedToolCalls = normalizeAssistantToolCalls(toolCalls);
            return {
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content,
                            ...(reasoningContent
                                ? { reasoning_content: reasoningContent }
                                : {}),
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
            content: `${cfg.systemPrompt}\n性格约束:${cfg.config.systemPrompt}\n\n${cfg.userPermissionPrompt}\n${cfg.botIdentityPrompt}`,
        };
        let messages = redisClient.sanitizeChatMessages([
            systemMessage,
            ...cfg.historyMessages,
            usermessage,
        ]);
        messages = await prepareCapiMessagesForRequest(e.guid, systemMessage, messages);
        messages = redisClient.sanitizeChatMessages(messages);
        const createParams = {
            model: cfg.config.model,
            messages: messages,
        };
        if (cfg.toolConfig.toolSwitch === "1") {
            createParams["tools"] = getTurnTools();
            createParams["tool_choice"] = "auto";
        }
        const deepThoughtReasoning = getDeepThoughtReasoning(cfg);
        Object.assign(createParams, deepThoughtReasoning);
        applyProviderBuiltinTools(createParams, cfg);
        if (!shouldStreamToOutput) {
            createParams["stream"] = false;
        }
        // log("请求AI，参数：", createParams);
        const stream = await requestChatCompletion(createParams, messages);
        let fullContent = "";
        let toolCalls = [];
        const completion = stream;
        const aiReplyMessage = completion?.choices?.[0]?.message;
        fullContent = getToolCallDisplayContent(aiReplyMessage);
        toolCalls = normalizeAssistantToolCalls(aiReplyMessage?.tool_calls);
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
        // 检查是否有工具调用需要处理
        let toolRound = 0;
        try {
            while (true) {
                throwIfAITurnAborted(aiTurn.signal);
                if (!res.choices[0].message?.tool_calls?.length) {
                    const pendingGuidanceMessages = await appendPendingGuidanceMessages(e.guid, e.Platform, messages);
                    if (pendingGuidanceMessages.length === 0) {
                        break;
                    }
                    messages = await prepareCapiMessagesForRequest(e.guid, systemMessage, messages);
                    messages = redisClient.sanitizeChatMessages(messages);
                    log("工具调用完成后收到补充引导，继续请求模型：", pendingGuidanceMessages.length);
                    const params = {
                        model: cfg.config.model,
                        messages: messages,
                    };
                    if (cfg.toolConfig.toolSwitch === "1") {
                        params.tools = getTurnTools();
                        params.tool_choice = "auto";
                    }
                    Object.assign(params, getDeepThoughtReasoning(cfg));
                    applyProviderBuiltinTools(params, cfg);
                    res = await requestChatCompletion(params, messages);
                    if (!res.choices || res.choices.length === 0) {
                        log("AI未返回内容");
                        return;
                    }
                    continue;
                }
                toolRound += 1;
                const rawResponseMessage = res.choices[0].message;
                const normalizedToolCalls = normalizeAssistantToolCalls(rawResponseMessage?.tool_calls);
                if (normalizedToolCalls.length === 0) {
                    log("工具调用列表无效，跳过本轮工具处理");
                    break;
                }
                const responseMessage = {
                    ...rawResponseMessage,
                    role: "assistant",
                    tool_calls: normalizedToolCalls,
                };
                log("AI返回工具调用，内容：-----", responseMessage);
                const toolCallDisplayContent = toolRound === 1
                    ? fullContent
                    : getToolCallDisplayContent(responseMessage);
                if (cfg.toolConfig.toolCallContentSwitch === "1" &&
                    toolCallDisplayContent.trim() !== "") {
                    const summary = removePublicIpFromOutput(toolCallDisplayContent, e.IsMaster === true);
                    if (!(await progress.append(summary))) {
                        await sendAIReply(toolCallDisplayContent, cfg, e, message);
                    }
                }
                // 先处理对话
                if (toolRound >= 10 && toolRound % 10 === 0) {
                    const statusText = `AI正在连续调用工具，第 ${toolRound} 轮处理中，请稍等`;
                    if (!(await progress.append(statusText, "status"))) {
                        await sendOutputText(message, statusText, e.IsMaster === true);
                    }
                }
                messages.push(responseMessage);
                log("模型决定调用工具：", responseMessage.tool_calls);
                if (cfg.toolConfig.toolPromptSwitch === "1") {
                    const useToolsMessage = responseMessage.tool_calls.map((toolCall) => {
                        return `工具调用: ${toolCall.function.name}(${cfg.toolConfig.toolPromptArgsSwitch === "1" ? toolCall.function.arguments : ""})`;
                    });
                    const toolPrompt = useToolsMessage.join("\n");
                    if (!(await progress.append(toolPrompt, "tool"))) {
                        const msgId = await sendOutputText(message, toolPrompt, e.IsMaster === true);
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
                }
                const toolMessages = [];
                for (const toolCall of responseMessage.tool_calls) {
                    throwIfAITurnAborted(aiTurn.signal);
                    const functionName = toolCall.function.name;
                    await redisClient.pushAIToolLoopTool(e.guid, functionName, e.Platform, turnUserID);
                    try {
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
                        // DescribeImage 优先使用当前消息中的真实图片地址
                        if (functionName === "DescribeImage" &&
                            functionArgs &&
                            typeof functionArgs === "object") {
                            bindDescribeImageUrl(functionArgs, currentImageUrls, describedCurrentImageUrls);
                            if (!String(functionArgs.guid || "").trim()) {
                                functionArgs.guid = e.guid;
                            }
                        }
                        // GPT 画图只在模型选择传图时进入编辑模式，并校正为本轮真实 URL
                        if (functionName === "GPTGenerateImage" &&
                            functionArgs &&
                            typeof functionArgs === "object" &&
                            String(functionArgs.image_url || "").trim()) {
                            bindDescribeImageUrl(functionArgs, currentImageUrls, generatedCurrentImageUrls);
                        }
                        // 下一条消息订阅只能绑定当前会话和当前发言用户，禁止模型伪造目标
                        if (functionName === "SubscribeNextUserMessage" &&
                            functionArgs &&
                            typeof functionArgs === "object") {
                            functionArgs.guid = e.guid;
                            functionArgs.userID = String(e.UserId || "");
                            functionArgs.platform = e.Platform;
                            functionArgs.isGroup = e.name !== "private.message.create";
                        }
                        if (functionName === "ScheduleAITask" &&
                            functionArgs &&
                            typeof functionArgs === "object") {
                            functionArgs.userID = String(e.UserId || "");
                            functionArgs.platform = e.Platform;
                            functionArgs.spaceId = e.SpaceId;
                            functionArgs.isPrivate = e.name === "private.message.create";
                        }
                        if ((functionName === "RunOpencode" || functionName === "RunCodex") &&
                            functionArgs &&
                            typeof functionArgs === "object") {
                            functionArgs.userID = turnUserID;
                        }
                        // 子agent绑定真实会话与用户：通知目标和结果回传都以真实事件为准
                        if (functionName === "SubAgent" &&
                            functionArgs &&
                            typeof functionArgs === "object") {
                            functionArgs.userID = turnUserID;
                            functionArgs.platform = e.Platform;
                            functionArgs.spaceId = e.SpaceId;
                            functionArgs.isPrivate = e.name === "private.message.create";
                        }
                        // 框架指令绑定当前真实事件，并在工具调用期间直接执行。
                        // 捕获到的文字和图片链接会作为本次工具结果返回给 AI。
                        if (functionName === "ExecuteAlemonCommand" &&
                            functionArgs &&
                            typeof functionArgs === "object") {
                            functionArgs.commandExecutor = (command, sendToUser) => executeAlemonCommand(e, command, { sendToUser });
                        }
                        if (functionName === "XianyuGame" &&
                            functionArgs &&
                            typeof functionArgs === "object") {
                            // 覆盖式注入真实会话作用域：模型无法伪造，AI 新建的扫雷对局
                            // 会写入这个作用域，和用户在会话里直接 #扫雷 得到的棋盘一致。
                            functionArgs.session = buildXianyuGameSession(e);
                            functionArgs.progressReporter = async (update) => {
                                const summary = String(update?.summary ?? "").trim();
                                if (!summary)
                                    return false;
                                if (update.final) {
                                    await message.send(update.image
                                        ? format(Text(summary), Image(update.image))
                                        : format(Text(summary)));
                                    return true;
                                }
                                if (update.image &&
                                    (await progress.appendImage(summary, update.image))) {
                                    return true;
                                }
                                if (!update.image && (await progress.append(summary, "result"))) {
                                    return true;
                                }
                                await message.send(update.image
                                    ? format(Text(summary), Image(update.image))
                                    : format(Text(summary)));
                                return true;
                            };
                        }
                        const functionToCall = availableTools[functionName];
                        let functionResult;
                        if (internalAllowedToolNames &&
                            !internalAllowedToolNames.has(functionName)) {
                            functionResult = {
                                ok: false,
                                error: `当前系统任务不允许调用工具：${functionName}`,
                            };
                        }
                        else if (!functionToCall) {
                            console.error(`未找到函数：${functionName}`);
                            functionResult = {
                                ok: false,
                                error: `未找到函数：${functionName}`,
                            };
                        }
                        else {
                            try {
                                const groupFullAccess = await assertGroupFullToolAccess(e, functionName, functionArgs);
                                const toolGuid = await assertAgentToolAccess(functionName, e.guid, functionArgs?.scope, e.IsMaster === true, groupFullAccess);
                                if ((await redisClient.getToolStatus(e.guid, functionName)) === "1") {
                                    console.error(`工具被禁用：${functionName}`);
                                    functionResult = {
                                        ok: false,
                                        error: `工具被禁用：${functionName}`,
                                    };
                                }
                                else {
                                    // 覆盖式注入主人权限标识（alemonjs 框架的 e.IsMaster），防止模型伪造参数；主人执行指令无需审核
                                    if (functionArgs && typeof functionArgs === "object") {
                                        functionArgs.isMaster = e.IsMaster === true;
                                        functionArgs.groupFullAccess = groupFullAccess;
                                    }
                                    // 公共知识库仅映射工作目录；审核配置仍绑定真实会话。
                                    if (functionArgs && typeof functionArgs === "object") {
                                        functionArgs.guid = toolGuid;
                                        if (functionName === "RunServerCommand" ||
                                            groupFullAccess ||
                                            functionArgs.scope === "public" ||
                                            functionArgs.scope === "root") {
                                            functionArgs.reviewGuid = e.guid;
                                        }
                                    }
                                    removePublicIpFromToolArguments(functionName, functionArgs, e.IsMaster === true);
                                    functionResult = await awaitWithAITurnAbort(functionToCall(functionArgs), aiTurn.signal);
                                    throwIfAITurnAborted(aiTurn.signal);
                                }
                            }
                            catch (err) {
                                if (isAITurnAbortError(err, aiTurn.signal)) {
                                    throw err;
                                }
                                console.error(`工具执行失败：${functionName}`, err);
                                functionResult = {
                                    ok: false,
                                    error: err?.message || String(err) || "工具执行失败",
                                };
                            }
                        }
                        throwIfAITurnAborted(aiTurn.signal);
                        if (typeof message?.sendToolResult === "function") {
                            await message.sendToolResult(functionName, functionResult);
                        }
                        else if (functionName === "GenerateSpeech" ||
                            functionName === "MiniMaxVoice") {
                            await sendSpeechToolResult(message, functionResult);
                        }
                        // 只保留 OpenAI 合法字段，避免把 reasoning_content 塞进 tool 消息
                        const toolMessage = buildToolResultMessage(toolCall, functionName, functionResult);
                        messages.push(toolMessage);
                        toolMessages.push(toolMessage);
                        if (isImageUrlToolContent(functionResult)) {
                            const imageMessage = {
                                role: "user",
                                content: functionResult,
                            };
                            messages.push(imageMessage);
                            toolMessages.push(imageMessage);
                        }
                    }
                    finally {
                        await redisClient.popAIToolLoopTool(e.guid, e.Platform, turnUserID, functionName);
                    }
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
                messages = redisClient.sanitizeChatMessages(messages);
                const params = {
                    model: cfg.config.model,
                    messages: messages,
                };
                if (cfg.toolConfig.toolSwitch === "1") {
                    params.tools = cfg.toolConfig.cApiToolList;
                    params.tool_choice = "auto";
                }
                const deepThoughtReasoning = getDeepThoughtReasoning(cfg);
                Object.assign(params, deepThoughtReasoning);
                applyProviderBuiltinTools(params, cfg);
                // log("重新请求AI，参数：", params);
                // 重新请求
                throwIfAITurnAborted(aiTurn.signal);
                res = await requestChatCompletion(params, messages);
                // 检查是否还有工具调用需要处理
                if (!res.choices || res.choices.length === 0) {
                    log("AI未返回内容");
                    return;
                }
            }
        }
        finally {
            await redisClient.releaseAIToolLoop(e.guid, turnUserID, e.Platform);
        }
        // 如果没有工具调用，处理最终回复
        let reply = res.choices?.[0]?.message?.content?.trim() || `${cfg.botName}:[]`;
        reply = removePublicIpFromOutput(reply, e.IsMaster === true);
        if (e["followupJudgement"] &&
            shouldSuppressFollowupReply(removeThinkContent(reply), cfg.botName)) {
            log("一分钟跟进: AI选择不回复，已丢弃静默标记或括号旁白");
            return;
        }
        if (reply === `${cfg.botName}:[]`) {
            log("AI选择不回复");
            return;
        }
        // 处理消息
        // 提取ai发送的消息有多少条
        await sendAIReply(reply, cfg, e, message);
        if (e.name !== "private.message.create" &&
            e.UserId &&
            String(e.UserId) !== String(e.bot?.user_id || "")) {
            await redisClient.markFollowupWatch(e.guid, String(e.UserId), e.Platform);
            log("已开始监听该用户一分钟内的后续发言", e.UserId);
        }
        const assistantMessage = res.choices?.[0]?.message;
        if (assistantMessage) {
            await redisClient.addAIChatHistory(e.guid, {
                ...assistantMessage,
                content: reply,
            });
        }
        return {
            next: false,
        };
    }
    catch (error) {
        progressStatus = isAITurnAbortError(error, aiTurn.signal)
            ? "interrupted"
            : "failed";
        await redisClient.releaseAIToolLoop(e.guid, turnUserID, e.Platform);
        if (isAITurnAbortError(error, aiTurn.signal)) {
            log(`当前 AI 回复已停止: ${e.guid}`);
            return {
                next: false,
                stopped: true,
            };
        }
        console.error("AI回复出错", error);
        await sendOutputText(message, "AI回复出错了\n" + error, e.IsMaster === true);
        return {
            next: true,
        };
    }
    finally {
        await progress.finish(progressStatus);
        await redisClient.releaseAIToolLoop(e.guid, turnUserID, e.Platform);
        aiTurn.finish();
    }
};

export { CApiReply, selects };
