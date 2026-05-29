import { useMessage } from 'alemonjs';
import OpenAi from 'openai';
import { getChatConfig, shouldSkipAIReply, buildUserMessage } from './getChatConfig.js';
import redisClient from '../../config.js';
import { availableTools } from '../../api/aitools.js';
import { parseAIOutput, renderMessages } from './tools.js';
import { log } from 'console';

const drainPendingGuidanceInputs = async (guid) => {
    const queuedMessages = await redisClient.drainAIGuidanceMessages(guid);
    if (!queuedMessages.length) {
        return [];
    }
    return queuedMessages
        .map((item) => item?.rapiMessage || item)
        .filter(Boolean);
};
const RApiReply = async (e) => {
    const cfg = await getChatConfig(e);
    if (await shouldSkipAIReply(e, cfg)) {
        return {
            next: true,
        };
    }
    const [message] = useMessage();
    const openai = new OpenAi({
        baseURL: cfg.config.host,
        apiKey: cfg.config.key,
        timeout: 300000,
    });
    const usermessage = await buildUserMessage(e, cfg, "rapi");
    let previousResponseId = (await redisClient.getSessionId(e.guid)) ?? undefined;
    console.log("当前会话id:", previousResponseId, "\n消息构建成功:", usermessage);
    // ===============================
    // 工具循环（RAPI版核心）
    // ===============================
    try {
        while (true) {
            const stream = await openai.responses.create({
                model: cfg.config.model,
                input: [usermessage],
                instructions: cfg.RapiSystemPrompt,
                previous_response_id: previousResponseId,
                tools: cfg.toolConfig.rApiToolList,
                stream: true,
                reasoning: {
                    effort: "minimal",
                },
            });
            let fullText = "";
            const toolCalls = [];
            const toolCallMap = new Map();
            // ===============================
            // 1. 解析流式输出
            // ===============================
            for await (const event of stream) {
                // 文本输出
                if (event.type === "response.output_text.delta") {
                    const text = event.delta ?? "";
                    fullText += text;
                }
                // 更稳妥：从 output_item.done 读取完整 function_call
                if (event.type === "response.output_item.done" &&
                    event.item?.type === "function_call") {
                    const callId = event.item.call_id;
                    if (callId) {
                        toolCallMap.set(callId, {
                            id: callId,
                            name: event.item.name,
                            arguments: event.item.arguments ?? "{}",
                        });
                    }
                }
                // 兼容：部分模型会发 function_call_arguments.done
                if (event.type === "response.function_call_arguments.done") {
                    const callId = event.call_id ?? event.item?.call_id;
                    if (callId) {
                        const prev = toolCallMap.get(callId) ?? {};
                        toolCallMap.set(callId, {
                            id: callId,
                            name: event.name ?? event.item?.name ?? prev.name,
                            arguments: event.arguments ?? prev.arguments ?? "{}",
                        });
                    }
                }
                // 更新 response id
                if (event.type === "response.completed") {
                    previousResponseId = event.response?.id ?? previousResponseId;
                }
            }
            if (fullText.trim() !== "") {
                const output1 = parseAIOutput(fullText);
                renderMessages(output1, message);
            }
            toolCalls.push(...toolCallMap.values());
            console.log("fullText", fullText);
            // ===============================
            // 2. 没有工具调用 → 直接结束
            // ===============================
            if (!toolCalls.length) {
                break;
            }
            console.log("模型触发工具调用：", toolCalls);
            await redisClient.setAIToolLoopProcessing(e.guid, true);
            // ===============================
            // 3. 执行工具
            // ===============================
            const toolOutputs = [];
            for (const toolCall of toolCalls) {
                const functionName = toolCall.name;
                let functionArgs = {};
                try {
                    functionArgs = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
                }
                catch (err) {
                    functionArgs = {};
                }
                const functionToCall = availableTools[functionName];
                let result;
                if (!functionToCall) {
                    result = { ok: false, error: `未找到工具: ${functionName}` };
                }
                else {
                    try {
                        result = await functionToCall(functionArgs);
                    }
                    catch (err) {
                        result = { ok: false, error: err.message || String(err) };
                    }
                }
                toolOutputs.push({
                    type: "function_call_output",
                    call_id: toolCall.id,
                    output: JSON.stringify(result),
                });
                // 可选：工具提示
                if (cfg.toolConfig.toolPromptSwitch === "1") {
                }
            }
            // ===============================
            // 4. 回填工具结果，继续下一轮
            // ===============================
            const guidanceInputs = await drainPendingGuidanceInputs(e.guid);
            if (guidanceInputs.length > 0) {
                log("RAPI 工具调用期间收到补充引导：", guidanceInputs.length);
            }
            const toolResponse = await openai.responses.create({
                model: cfg.config.model,
                previous_response_id: previousResponseId,
                input: [...toolOutputs, ...guidanceInputs],
                tools: cfg.toolConfig.rApiToolList,
                stream: true,
                reasoning: {
                    effort: "minimal",
                },
            });
            let newText = "";
            for await (const event of toolResponse) {
                if (event.type === "response.output_text.delta") {
                    newText += event.delta;
                }
                if (event.type === "response.completed") {
                    previousResponseId = event.response.id;
                }
            }
            // 如果这一轮没有新的工具调用 → 结束
            if (newText && toolOutputs.length > 0) {
                log("工具回填后模型回复：", newText);
                const output2 = parseAIOutput(newText);
                renderMessages(output2, message);
                break;
            }
        }
    }
    finally {
        await redisClient.setAIToolLoopProcessing(e.guid, false);
    }
    // ===============================
    // 6. 存 session
    // ===============================
    if (previousResponseId) {
        await redisClient.setSessionId(e.guid, previousResponseId);
    }
};

export { RApiReply };
