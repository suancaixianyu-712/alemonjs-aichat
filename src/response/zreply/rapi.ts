import { Events, useMessage } from "alemonjs";
import OpenAi from "openai";
import {
  buildUserMessage,
  getChatConfig,
  shouldSkipAIReply,
} from "./getChatConfig";
import redisClient from "@src/config";
import { availableTools } from "@src/api/aitools";
import { parseAIOutput, renderMessages } from "./tools";
import { log } from "console";

const drainPendingGuidanceInputs = async (guid: string) => {
  const queuedMessages = await redisClient.drainAIGuidanceMessages(guid);
  if (!queuedMessages.length) {
    return [];
  }

  return queuedMessages
    .map((item: any) => item?.rapiMessage || item)
    .filter(Boolean);
};

export const RApiReply = async (
  e: Events["message.create"] | Events["private.message.create"],
  outputMessage?: any,
) => {
  const cfg = await getChatConfig(e);
  if (await shouldSkipAIReply(e, cfg)) {
    return {
      next: true,
    };
  }

  const [message] = outputMessage ? [outputMessage] : useMessage(e);

  const openai = new OpenAi({
    baseURL: cfg.config.host,
    apiKey: cfg.config.key,
    timeout: 300000,
  });

  const usermessage = await buildUserMessage(e, cfg, "rapi");

  let previousResponseId: string | undefined =
    (await redisClient.getSessionId(e.guid)) ?? undefined;

  console.log(
    "当前会话id:",
    previousResponseId,
    "\n消息构建成功:",
    usermessage,
  );
  // ===============================
  // 工具循环（RAPI版核心）
  // ===============================
  try {
    while (true) {
      const stream = await openai.responses.create({
        model: cfg.config.model,
        input: [usermessage as any],
        instructions: cfg.RapiSystemPrompt,
        previous_response_id: previousResponseId,
        tools: cfg.toolConfig.rApiToolList as any,
        stream: true,
        reasoning: {
          effort: "minimal",
        },
      });

      let fullText = "";
      const toolCalls: any[] = [];
      const toolCallMap = new Map<string, any>();

      // ===============================
      // 1. 解析流式输出
      // ===============================
      for await (const event of stream as any) {
        // 文本输出
        if (event.type === "response.output_text.delta") {
          const text = event.delta ?? "";
          fullText += text;
          if (text && typeof message?.streamTextDelta === "function") {
            await message.streamTextDelta(text);
          }
        }

        // 更稳妥：从 output_item.done 读取完整 function_call
        if (
          event.type === "response.output_item.done" &&
          event.item?.type === "function_call"
        ) {
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
      const toolOutputs: any[] = [];

      for (const toolCall of toolCalls) {
        const functionName = toolCall.name;

        let functionArgs: any = {};
        try {
          functionArgs = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
        } catch (err) {
          functionArgs = {};
        }

        const functionToCall = availableTools[functionName];

        let result: any;

        if (!functionToCall) {
          result = { ok: false, error: `未找到工具: ${functionName}` };
        } else {
          try {
            result = await functionToCall(functionArgs);
          } catch (err: any) {
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
        tools: cfg.toolConfig.rApiToolList as any,
        stream: true,
        reasoning: {
          effort: "minimal",
        },
      });

      let newText = "";

      for await (const event of toolResponse as any) {
        if (event.type === "response.output_text.delta") {
          const text = event.delta ?? "";
          newText += text;
          if (text && typeof message?.streamTextDelta === "function") {
            await message.streamTextDelta(text);
          }
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
  } finally {
    await redisClient.setAIToolLoopProcessing(e.guid, false);
  }

  // ===============================
  // 6. 存 session
  // ===============================
  if (previousResponseId) {
    await redisClient.setSessionId(e.guid, previousResponseId);
  }
};
