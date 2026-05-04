import { emojiMap } from "@src/emoji";
import { uploadImageToR2 } from "@src/s3";
import {
  Events,
  ImageFile,
  ImageURL,
  Mention,
  Text,
  Audio,
  useMessage,
  Video,
} from "alemonjs";
import { log } from "console";
import OpenAi from "openai";
import { getConfigValue } from "alemonjs";
import { TTSClient } from "@src/api/tts";
import { getTimeString } from "@src/api/format";
import { availableTools } from "@src/api/aitools";
import redisClient from "@src/config";
import errorimg from "@src/assets/error.png";
import { imageReview } from "@src/api/review";
import {
  buildUserMessage,
  getChatConfig,
  getDeepThoughtReasoning,
  shouldSkipAIReply,
} from "./getChatConfig";
import { createTTSMessage } from "./tts";
import { parseAIReply } from "./tools";

const value = getConfigValue().aiChat || {};
export const selects = onSelects(["message.create", "private.message.create"]);
let currentModel = "派蒙-默认"; // 默认音色

export const CApiReply = async (
  e: Events["message.create"] | Events["private.message.create"],
) => {
  console.log("e.UserId", e.UserId, e.bot);

  if (await shouldSkipAIReply(e)) {
    return {
      next: true,
    };
  }

  // 创建消息
  const [message] = useMessage(e);
  const cfg = await getChatConfig(e);
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
    createParams["stream"] = false;

    log("请求AI，参数：", createParams);
    const stream = (await openai.chat.completions.create(createParams)) as any;

    log("AI回复原始数据:\n", JSON.stringify(stream, null, 2));
    let fullContent = "";
    let toolCalls: any[] = [];

    const completion: any = stream;
    const aiReplyMessage = completion?.choices?.[0]?.message;

    if (aiReplyMessage?.content) {
      fullContent = aiReplyMessage.content;
    }

    if (Array.isArray(aiReplyMessage?.tool_calls)) {
      toolCalls = aiReplyMessage.tool_calls.map((tc: any) => ({
        id: tc.id || "",
        type: "function",
        function: {
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "",
        },
      }));
    }

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

    messages.push(usermessage);
    await redisClient.addAIChatHistory(e.guid, usermessage);

    if (res.choices[0].message?.tool_calls && fullContent.trim() !== "") {
      message.send(format(Text(fullContent)));
    }

    // 检查是否有工具调用需要处理
    while (res.choices[0].message?.tool_calls?.length) {
      const responseMessage = res.choices[0].message as any;
      log("AI返回工具调用，内容：-----", res.choices[0]);

      // 先处理对话
      messages.push(responseMessage);
      await redisClient.addAIChatHistory(e.guid, responseMessage);

      log("模型决定调用工具：", responseMessage.tool_calls);

      if (cfg.toolConfig.toolPromptSwitch === "1") {
        const useToolsMessage = responseMessage.tool_calls.map((toolCall) => {
          return `工具调用: ${toolCall.function.name}(${cfg.toolConfig.toolPromptArgsSwitch === "1" ? toolCall.function.arguments : ""})`;
        });
        const msgId = await message.send(
          format(Text(useToolsMessage.join("\n"))),
        );
        if (cfg.toolConfig.toolPromptRevokeSwitch === "1") {
          // 10秒后撤回工具调用提示
          setTimeout(() => {
            message.delete({ messageId: msgId[0].data.message_id });
          }, 10000);
        }
      }

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

        const toolContent = JSON.stringify(
          typeof functionResult === "undefined"
            ? { ok: true, result: null }
            : functionResult,
        );

        // 把工具执行结果作为 tool role 消息加回对话
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolContent,
          reasoning_content: responseMessage.reasoning_content || "",
        });

        // 记录工具调用结果
        await redisClient.addAIChatHistory(e.guid, {
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolContent,
          reasoning_content: responseMessage.reasoning_content || "",
        });
      }

      const params: any = {
        model: cfg.config.model,
        messages: messages,
        tools: cfg.toolConfig.cApiToolList,
        tool_choice: "auto",
      };

      const deepThoughtReasoning = getDeepThoughtReasoning(cfg);
      Object.assign(params, deepThoughtReasoning);

      log("重新请求AI，参数：", params);

      // 重新请求
      res = await openai.chat.completions.create(params);

      // 检查是否还有工具调用需要处理
      if (!res.choices || res.choices.length === 0) {
        log("AI未返回内容");
        return;
      }
    }

    // 如果没有工具调用，处理最终回复
    let reply =
      res.choices?.[0]?.message?.content?.trim() || `${cfg.botName}:[]`;
    await redisClient.addAIChatHistory(e.guid, res.choices?.[0]?.message);
    if (reply === `${cfg.botName}:[]`) {
      log("AI选择不回复");
      return;
    }

    console.log("AI回复原文:\n", JSON.stringify(res, null, 2));

    // 处理消息
    // 提取ai发送的消息有多少条
    const aireply = parseAIReply(reply, cfg, message, e);
    console.log("aireply", aireply);

    if (aireply) {
      if (aireply.ttsMessages) {
        for (const ttsMsg of aireply.ttsMessages) {
          const ttsMessage = await createTTSMessage(
            ttsMsg.text,
            new TTSClient(),
            ttsMsg.model ?? currentModel,
          );
          message.send(format(Audio(ttsMessage)));
        }
      }
      if (aireply.replyMessages) {
        for (const msg of aireply.replyMessages) {
          message.send(
            format(
              Text(msg.text),
              ...(msg.images || []).map((img) => {
                return /^https?:\/\//.test(img)
                  ? ImageURL(img)
                  : ImageFile(img);
              }),
              ...(msg.at || []).map((uid) => Mention(uid)),
            ),
          );
        }
      }
    }

    return {
      next: aireply.nextCommands.length > 0,
      commands: aireply.nextCommands[0] ? aireply.nextCommands : undefined,
    };
  } catch (error) {
    console.error("AI回复出错", error);
    message.send(format(Text("AI回复出错了\n" + error)));
    return {
      next: true,
    };
  }
};
