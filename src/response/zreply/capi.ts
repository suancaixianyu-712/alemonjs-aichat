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
  shouldSkipAIReply,
} from "./getChatConfig";
import { createTTSMessage } from "./tts";

const value = getConfigValue().aiChat || {};

export const selects = onSelects(["message.create", "private.message.create"]);
let ttsClient: TTSClient;

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
    if (cfg.deepThoughtSwitch === "0") {
      createParams["verbosity"] = "low";
    }

    createParams["stream"] = true;

    const stream = (await openai.chat.completions.create(createParams)) as any;

    let fullContent = "";
    let toolCalls: any[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        fullContent += delta.content;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.index !== undefined) {
            if (!toolCalls[tc.index]) {
              toolCalls[tc.index] = {
                id: tc.id || "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[tc.index].id = tc.id;
            if (tc.function?.name)
              toolCalls[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments)
              toolCalls[tc.index].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    let res: any = {
      choices: [
        {
          message: {
            role: "assistant",
            content: fullContent || null,
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

    // 检查是否有工具调用需要处理
    while (res.choices[0].message?.tool_calls?.length) {
      const responseMessage = res.choices[0].message as any;

      // 先处理对话
      messages.push(responseMessage);
      await redisClient.addAIChatHistory(e.guid, responseMessage);

      console.log("模型决定调用工具：", responseMessage.tool_calls);

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
        });

        // 记录工具调用结果
        await redisClient.addAIChatHistory(e.guid, {
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolContent,
        });
      }

      // 重新请求
      res = await openai.chat.completions.create({
        model: cfg.config.model,
        messages: messages,
        tools: cfg.toolConfig.cApiToolList,
        tool_choice: "auto",
      });

      // 检查是否还有工具调用需要处理
      if (!res.choices || res.choices.length === 0) {
        log("AI未返回内容");
        return;
      }
    }

    // 如果没有工具调用，处理最终回复
    let reply =
      res.choices?.[0]?.message?.content?.trim() || `${cfg.botName}:[]`;
    if (reply === `${cfg.botName}:[]`) {
      log("AI选择不回复");
      return;
    }

    console.log("AI回复:\n", reply);

    // 处理消息
    // 提取ai发送的消息有多少条
    const replyMessages = reply
      .split(new RegExp(`${cfg.botName}:`, "g"))
      .slice(1);

    const replymessages: { text: string; images: string[]; at: string[] }[] =
      [];
    const ttsMessages: { text: string; model: string }[] = [];
    const nextCommands: string[] = [];
    const atTargets: string[] = [];

    for (const replyMessage of replyMessages) {
      // 从消息中提取图片
      const imageRegex = /<img=(.*?)>/g;
      let match;
      const imgUrls: string[] = [];
      while ((match = imageRegex.exec(replyMessage)) !== null) {
        imgUrls.push(match[1].trim().replace(/\\/g, "\/"));
      }

      // 处理好感度变化（通用和特定用户）
      const affectionRegex = /<([^<>]*?)好感([+-]\d+)>/g;
      let affectionMatch: RegExpExecArray | null;
      while ((affectionMatch = affectionRegex.exec(replyMessage)) !== null) {
        const nickname = affectionMatch[1] || (e.UserName as string);
        const change = parseInt(affectionMatch[2], 10);
        if (!isNaN(change) && change !== 0) {
          console.log(`检测到对${nickname}的好感变化: ${change}`);
          await redisClient.incrementAffectionLevel(e.guid, nickname, change);
        }
      }

      // 处理ai将要执行的其他指令
      const commandRegex = /<command=(.*?)>/g;
      let commandMatch: RegExpExecArray | null;
      while ((commandMatch = commandRegex.exec(replyMessage)) !== null) {
        const command = commandMatch[1].trim();
        if (command) {
          console.log(`检测到AI指令: ${command}`);
          nextCommands.push(command);
        }
      }

      // 处理撤回指令
      const revokeRegex = /<revoke=(.*?)>/g;
      let revokeMatch: RegExpExecArray | null;
      while ((revokeMatch = revokeRegex.exec(replyMessage)) !== null) {
        const revokeTarget = revokeMatch[1].trim();
        if (revokeTarget) {
          await message.delete({ messageId: revokeTarget });
        }
      }

      // 处理艾特指令
      const atRegex = /<at=(.*?)>/g;
      let atMatch: RegExpExecArray | null;
      while ((atMatch = atRegex.exec(replyMessage)) !== null) {
        const atTarget = atMatch[1].trim();
        if (atTarget) {
          console.log(`检测到艾特指令: ${atTarget}`);
          atTargets.push(atTarget);
        }
      }

      // 处理语音回复
      const ttsRegex = /<(tts|音色)=([^>]+)>/gi;
      let ttsMatch: RegExpExecArray | null;

      while ((ttsMatch = ttsRegex.exec(replyMessage)) !== null) {
        console.log("检测到语音回复");

        const isTTS = ttsMatch[1].toLowerCase() === "tts";
        const content = ttsMatch[2].trim();
        if (isTTS) {
          ttsMessages.push({ text: content, model: currentModel });
        } else {
          currentModel = content;
        }
      }

      // 组合消息,添加到replymessages数组中
      replymessages.push({
        text: replyMessage
          .replace(imageRegex, "")
          .replace(ttsRegex, "")
          .replace(commandRegex, "")
          .replace(revokeRegex, "")
          .replace(atRegex, "")
          .trim(),
        images: imgUrls,
        at: atTargets,
      });
    }
    // 记录对话
    await redisClient.addAIChatHistory(e.guid, res.choices?.[0].message);

    // 发送消息
    if (cfg.isOpenTTSReply === "1") {
      // 提前发送语音消息避免等待时间过长
      ttsClient = new TTSClient();
      console.log("发送语音", ttsMessages);

      for (const ttsMessage of ttsMessages) {
        const audioUrl = await createTTSMessage(
          ttsMessage.text,
          ttsClient,
          ttsMessage.model,
        );
        if (audioUrl !== "") {
          await message.send(format(Audio(audioUrl)));
        }
      }
    }

    // 发送消息
    for (let i = 0; i < replymessages.length; i++) {
      const { text, images, at } = replymessages[i];
      const components: any[] = i === 0 ? [Mention(e.UserId)] : [];

      components.push(Text(text));

      for (const img of images) {
        const isNetworkImage = /^https?:\/\//.test(img);
        let finalImg: string | null = img;

        // 👉 scbbs 平台处理（下载再上传）
        if (e.Platform == "scbbs" && isNetworkImage) {
          const uploadedUrl = await uploadImageToR2(
            img.replace(
              "https://imgen.x.ai",
              value.xaiImgProxy || "https://imgen.x.ai",
            ),
          );
          finalImg = uploadedUrl || null;
        }

        // 👉 审核逻辑（只在开启时执行）
        if (cfg.isOpenR18 !== "1" && finalImg) {
          try {
            const imgres = await imageReview(finalImg);

            if (imgres?.conclusion === "不合规") {
              components.push(ImageFile(errorimg));
              continue;
            }
          } catch (err) {}
        }

        // 👉 正常图片逻辑
        if (finalImg) {
          const imageComponent = isNetworkImage
            ? ImageURL(finalImg)
            : ImageFile(finalImg);
          components.push(imageComponent);
        } else {
          // 上传失败 fallback
          components.push(ImageFile(errorimg));
        }
      }

      for (const atTarget of at) {
        components.push(Mention(atTarget));
      }

      // 随机 1-3 秒延迟
      const delay = Math.random() * 2000 + 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      await message.send(format(...components));
    }
    return {
      next: nextCommands.length > 0,
      commands: nextCommands,
    };
  } catch (error) {
    console.error("AI回复出错", error);
    // 清理聊天记录
    await redisClient.clearLastNChatHistory(e.guid, 2);
    message.send(
      format(Text("AI回复出错了, 已清理最近2条聊天记录~\n" + error)),
    );
    return {
      next: true,
    };
  }
};
