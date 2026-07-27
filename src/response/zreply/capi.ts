import {
  Events,
  ImageFile,
  ImageURL,
  Mention,
  Text,
  Audio,
  useMessage,
} from "alemonjs";
import { log } from "console";
import OpenAi from "openai";
import { TTSClient } from "@src/api/tts";
import { availableTools } from "@src/api/aitools";
import redisClient, { DEFAULT_CAPI_CONTEXT_LIMIT } from "@src/config";
import {
  bindDescribeImageUrl,
  buildUserMessage,
  getChatConfig,
  getDeepThoughtReasoning,
  shouldSkipAIReply,
} from "./getChatConfig";
import { createTTSMessage } from "./tts";
import { parseAIReply, sendAIReplyToOutput } from "./tools";

export const selects = onSelects(["message.create", "private.message.create"]);
let currentModel = "派蒙-默认"; // 默认音色
const CAPI_CONTEXT_COMPRESSION_RATIO = 0.9;
const CAPI_CONTEXT_RETAIN_RATIO = 0.35;
const AUTO_SUMMARY_DETAIL_MAX_LENGTH = 2000;

const sendAIReply = async (
  reply: string,
  cfg: any,
  e: Events["message.create"] | Events["private.message.create"],
  message: any,
) => {
  const aireply = await parseAIReply(reply, cfg, e, message);
  console.log("aireply", aireply);

  if (await sendAIReplyToOutput(message, aireply)) {
    return aireply;
  }

  if (aireply?.ttsMessages) {
    for (const ttsMsg of aireply.ttsMessages) {
      const ttsMessage = await createTTSMessage(
        ttsMsg.text,
        new TTSClient(),
        ttsMsg.model ?? currentModel,
      );
      await message.send(format(Audio(ttsMessage)));
    }
  }

  if (aireply?.replyMessages) {
    for (const msg of aireply.replyMessages) {
      await message.send(
        format(
          Text(msg.text),
          ...(msg.images || []).map((img) => {
            return /^https?:\/\//.test(img) ? ImageURL(img) : ImageFile(img);
          }),
          ...(msg.at || []).map((uid) => Mention(uid)),
        ),
      );
    }
  }

  return aireply;
};

const sendOutputText = async (message: any, text: string) => {
  if (typeof message?.sendText === "function") {
    return await message.sendText(text);
  }

  return await message.send(format(Text(text)));
};

const appendPendingGuidanceMessages = async (
  guid: string,
  platform: string | undefined,
  messages: any[],
) => {
  const queuedMessages = await redisClient.drainAIGuidanceMessages(
    guid,
    platform,
  );
  if (!queuedMessages.length) {
    return [];
  }

  const guidanceMessages = queuedMessages
    .map((item: any) => item?.capiMessage || item)
    .filter(Boolean);
  if (!guidanceMessages.length) {
    return [];
  }

  messages.push(...guidanceMessages);
  await redisClient.addAIChatHistoryBatch(guid, guidanceMessages);
  return guidanceMessages;
};

const extractTextValue = (value: any): string => {
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

const getToolCallDisplayContent = (message: any): string => {
  const content = extractTextValue(message?.content);
  if (content.trim() !== "") {
    return content;
  }
  return extractTextValue(
    message?.reasoning_content ??
      message?.reasoningContent ??
      message?.reasoning,
  );
};

const getTextLength = (value: any): number => {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + getTextLength(item), 0);
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (sum: number, item) => sum + getTextLength(item),
      0,
    );
  }
  return 0;
};

const estimateContextTokens = (value: any): number => {
  return Math.ceil(getTextLength(value) / 4);
};

const trimText = (text: string, maxLength: number): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
};

const takeTailMessagesWithinTokenBudget = (
  history: any[],
  tokenBudget: number,
) => {
  const kept: any[] = [];

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

const normalizeAssistantToolCalls = (toolCalls: any[] | undefined | null) => {
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
        arguments:
          typeof item.function.arguments === "string"
            ? item.function.arguments
            : JSON.stringify(item.function.arguments ?? {}),
      },
    }));
};

const buildToolResultMessage = (
  toolCall: any,
  functionName: string,
  functionResult: any,
) => {
  const toolContent = JSON.stringify(
    typeof functionResult === "undefined"
      ? { ok: true, result: null }
      : functionResult,
  );

  return {
    role: "tool" as const,
    tool_call_id: String(toolCall?.id || "").trim(),
    name: functionName,
    content: toolContent,
  };
};

const buildAutoSummaryMessage = (record: any) => {
  const summary = record?.summary || "较早对话已自动归档";
  const detail = trimText(
    record?.detail || record?.transcript || "无详细摘要",
    AUTO_SUMMARY_DETAIL_MAX_LENGTH,
  );

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

const prepareCapiMessagesForRequest = async (
  guid: string,
  systemMessage: any,
  currentMessages: any[],
) => {
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

  const minRetainBudget = Math.min(
    Math.floor(DEFAULT_CAPI_CONTEXT_LIMIT * 0.05),
    Math.floor(limit * 0.5),
  );
  const retainBudget = Math.max(
    Math.floor(limit * CAPI_CONTEXT_RETAIN_RATIO),
    minRetainBudget,
  );
  const keptHistory = takeTailMessagesWithinTokenBudget(history, retainBudget);
  const compressedSeed = [buildAutoSummaryMessage(archived), ...keptHistory];
  await redisClient.setAIChatHistory(guid, compressedSeed);
  // set 后重新读取，确保与 sanitize 后的 redis 历史一致，避免本地未清洗副本
  const compressedHistory = await redisClient.getAIChatHistory(guid);

  const pendingMessages = currentMessages.slice(
    Math.max(1 + history.length, 1),
  );
  const rebuiltMessages = redisClient.sanitizeChatMessages([
    systemMessage,
    ...compressedHistory,
    ...pendingMessages,
  ]);

  log(
    `CAPI上下文接近上限，已自动压缩：${estimatedTokens}/${limit} tokens，归档ID:${archived.id}`,
  );

  return rebuiltMessages;
};

const getNumber = (value: any): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const extractCachedTokens = (usage: any): number | null => {
  return getNumber(
    usage?.prompt_tokens_details?.cached_tokens ??
      usage?.input_tokens_details?.cached_tokens ??
      usage?.prompt_cache_hit_tokens,
  );
};

const extractCacheMissTokens = (usage: any, promptTokens: number | null) => {
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

const recordCapiContextStats = async (
  guid: string,
  model: string,
  messages: any[],
  completion: any,
) => {
  const usage = completion?.usage;
  const promptTokens = getNumber(usage?.prompt_tokens ?? usage?.input_tokens);
  const completionTokens = getNumber(
    usage?.completion_tokens ?? usage?.output_tokens,
  );
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

export const CApiReply = async (
  e: Events["message.create"] | Events["private.message.create"],
  outputMessage?: any,
) => {
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
  const currentImageUrls = Array.isArray((usermessage as any).validImageUrls)
    ? (usermessage as any).validImageUrls
    : [];
  const describedCurrentImageUrls = new Set<string>();
  console.log(
    "发送给AI的当前消息:\n",
    JSON.stringify(usermessage, null, 2),
  );

  try {
    const openai = new OpenAi({
      baseURL: cfg.config.host,
      apiKey: cfg.config.key,
      timeout: 300000,
    });
    const shouldStreamToOutput =
      typeof outputMessage?.streamTextDelta === "function";

    const requestChatCompletion = async (
      params: any,
      requestMessages: any[],
    ) => {
      if (!shouldStreamToOutput) {
        const completion = await openai.chat.completions.create(params);
        await recordCapiContextStats(
          e.guid,
          cfg.config.model,
          requestMessages,
          completion,
        );
        return completion as any;
      }

      const streamParams = {
        ...params,
        stream: true,
      };
      const stream = (await openai.chat.completions.create(streamParams)) as any;
      let content = "";
      let reasoningContent = "";
      const toolCalls: any[] = [];

      const ensureToolCall = (index: number) => {
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

        const reasoningDelta = extractTextValue(
          delta.reasoning_content ?? delta.reasoningContent ?? "",
        );
        if (reasoningDelta) {
          reasoningContent += reasoningDelta;
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const item of delta.tool_calls) {
            const indexValue = Number(item.index);
            const index = Number.isFinite(indexValue) ? indexValue : 0;
            const toolCall = ensureToolCall(index);
            if (item.id) toolCall.id = item.id;
            if (item.type) toolCall.type = item.type;
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
      content: cfg.systemPrompt + `\n性格约束:${cfg.config.systemPrompt}`,
    };

    let messages = redisClient.sanitizeChatMessages([
      systemMessage,
      ...cfg.historyMessages,
      usermessage,
    ]);
    messages = await prepareCapiMessagesForRequest(
      e.guid,
      systemMessage,
      messages,
    );
    messages = redisClient.sanitizeChatMessages(messages);

    const createParams: any = {
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
    let toolCalls: any[] = [];

    const completion: any = stream;
    const aiReplyMessage = completion?.choices?.[0]?.message;

    fullContent = getToolCallDisplayContent(aiReplyMessage);

    toolCalls = normalizeAssistantToolCalls(aiReplyMessage?.tool_calls);

    let res: any = {
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

    if (
      cfg.toolConfig.toolCallContentSwitch === "1" &&
      res.choices[0].message?.tool_calls &&
      fullContent.trim() !== ""
    ) {
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
          const pendingGuidanceMessages = await appendPendingGuidanceMessages(
            e.guid,
            e.Platform,
            messages,
          );
          if (pendingGuidanceMessages.length === 0) {
            break;
          }
          messages = await prepareCapiMessagesForRequest(
            e.guid,
            systemMessage,
            messages,
          );
          messages = redisClient.sanitizeChatMessages(messages);

          log(
            "工具调用完成后收到补充引导，继续请求模型：",
            pendingGuidanceMessages.length,
          );
          const params: any = {
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
        const rawResponseMessage = res.choices[0].message as any;
        const normalizedToolCalls = normalizeAssistantToolCalls(
          rawResponseMessage?.tool_calls,
        );

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

        // 先处理对话
        if (toolRound >= 10 && toolRound % 10 === 0) {
          await sendOutputText(
            message,
            `AI正在连续调用工具，第 ${toolRound} 轮处理中，请稍等`,
          );
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

        const toolMessages: any[] = [];

        for (const toolCall of responseMessage.tool_calls) {
          const functionName = toolCall.function.name;
          let functionArgs: any = {};

          try {
            functionArgs = toolCall.function.arguments
              ? JSON.parse(toolCall.function.arguments)
              : {};
          } catch (err) {
            console.error(`工具参数解析失败：${functionName}`, err);
            functionArgs = {};
          }

          // DescribeImage 未带 guid 时自动注入当前群号，便于读取识图 AI 配置
          if (
            functionName === "DescribeImage" &&
            functionArgs &&
            typeof functionArgs === "object"
          ) {
            bindDescribeImageUrl(
              functionArgs,
              currentImageUrls,
              describedCurrentImageUrls,
            );
            if (!String(functionArgs.guid || "").trim()) {
              functionArgs.guid = e.guid;
            }
          }

          const functionToCall = availableTools[functionName];
          let functionResult: any;

          if (!functionToCall) {
            console.error(`未找到函数：${functionName}`);
            functionResult = {
              ok: false,
              error: `未找到函数：${functionName}`,
            };
          } else {
            try {
              if (
                (await redisClient.getToolStatus(e.guid, functionName)) === "1"
              ) {
                console.error(`工具被禁用：${functionName}`);
                functionResult = {
                  ok: false,
                  error: `工具被禁用：${functionName}`,
                };
              } else {
                // 覆盖式注入主人权限标识（alemonjs 框架的 e.IsMaster），防止模型伪造参数；主人执行指令无需审核
                if (functionArgs && typeof functionArgs === "object") {
                  functionArgs.isMaster = e.IsMaster === true;
                }
                functionResult = await functionToCall(functionArgs);
              }
            } catch (err: any) {
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

          // 只保留 OpenAI 合法字段，避免把 reasoning_content 塞进 tool 消息
          const toolMessage = buildToolResultMessage(
            toolCall,
            functionName,
            functionResult,
          );
          messages.push(toolMessage);
          toolMessages.push(toolMessage);
        }

        await redisClient.addAIChatHistoryBatch(e.guid, [
          responseMessage,
          ...toolMessages,
        ]);

        const guidanceMessages = await appendPendingGuidanceMessages(
          e.guid,
          e.Platform,
          messages,
        );
        if (guidanceMessages.length > 0) {
          log("工具调用期间收到补充引导：", guidanceMessages.length);
        }

        messages = await prepareCapiMessagesForRequest(
          e.guid,
          systemMessage,
          messages,
        );
        messages = redisClient.sanitizeChatMessages(messages);

        const params: any = {
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
    } finally {
      await redisClient.setAIToolLoopProcessing(e.guid, false, e.Platform);
    }

    // 如果没有工具调用，处理最终回复
    let reply =
      res.choices?.[0]?.message?.content?.trim() || `${cfg.botName}:[]`;
    if (reply === `${cfg.botName}:[]`) {
      log("AI选择不回复");
      return;
    }

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
  } catch (error) {
    await redisClient.setAIToolLoopProcessing(e.guid, false, e.Platform);
    console.error("AI回复出错", error);
    await sendOutputText(message, "AI回复出错了\n" + error);
    return {
      next: true,
    };
  }
};
