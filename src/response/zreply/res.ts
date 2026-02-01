import { API } from "@alemonjs/onebot";
import { availableTools, getTimeString, TTSClient } from "@src/api";
import {
  addAIChatHistory,
  getAffectionLevelAll,
  getAIChatHistory,
  getAIConfig,
  incrementAffectionLevel,
  tools,
} from "@src/config";
import { emojiMap } from "@src/emoji";
import { redis } from "@src/redis";
import { uploadImageToR2 } from "@src/s3";
import { ImageFile, Text, useClient, useMessage } from "alemonjs";
import { log } from "console";
import OpenAi from "openai";

export const selects = onSelects(["message.create", "private.message.create"]);
export const regular = /.*/;
let ttsClient: TTSClient;

export default onResponse(selects, async (e, next) => {
  console.log("收到消息");

  // 如果是命令则跳过
  if (e.msg.startsWith("/") || e.msg.startsWith("#")) {
    next();
    return;
  }

  // 创建消息
  const [message] = useMessage(e);
  const config = await getAIConfig(e.guid);
  const historyMessages = await getAIChatHistory(e.guid);
  const affections = await getAffectionLevelAll(e.guid);
  const imgs: string[] = [];
  let rawMessage = e.value.raw_message || e.msg;
  // 好感度开关
  const affectionIsOpen =
    (await redis.get(`ai:affection:switch:${e.guid}`)) || "1";
  const botName = e.bot.nickname || "小咸鱼";
  const systemPrompt =
    `你正在一个群聊中跟用户聊天,你的聊天昵称是'${botName}'
关于回复格式:
  用户的发言方式为: [{'用户昵称(用户id)(发送时间)':回复内容}]
  你的回复方式为JSON: [{assistant:回复内容}],你可以在数组中加入多条消息来模拟更真实的聊天
  当然你觉得当前聊的话题确定与你有关是才回复,否则你就回复空数组[]来表示不回复.请尽可能降低回复频率.
关于图片发送:
  如果你在使用画图工具后需要回复图片, 可在消息中追加image_url, 例如:
  [{'assistant':'画好啦','image_url':'图片地址'}]
  注意:图片地址必须是接口返回的完整地址, 通常是相对路径
` +
    (affectionIsOpen === "1"
      ? `当你认为对方在示好或骂你时,可添加{affections:数字}表示好感度变化,你可以根据好感度来适当改变回复语气.
示例: [{'assistant':'你人真好[好感+2]','affections':2}], 或者 [{'assistant':'我才不理你这个坏人呢[好感-1]','affections':-1}]
当对方希望和好时提出道歉条件,可以给对方一个恢复的机会.
当前群时间:${getTimeString()}\n
当前用户的好感度列表如下:\n` + JSON.stringify(affections)
      : `当前群时间:${getTimeString()}`);

  // 如果没有配置AI,则不处理
  if (
    config.host.trim() === "" ||
    config.key.trim() === "" ||
    config.model.trim() === ""
  ) {
    return;
  }

  console.log("e.reply", e.reply);

  // 当e.at不存在时,只给20%概率继续执行, 当e.at存在时,概率为40%,当e.atBot存在时,概率为100%
  const rand = Math.random();
  if (e.Name !== "private.message.create") {
    if ((!e.at && rand > 0.2) || (e.at && !e.atBot && rand > 0.4)) {
      console.log("跳过AI回复");
      return;
    }
  }
  // if (e.UserId != "3501869534") return;

  // 处理回复图片
  if (e.reply) {
    const replyImages = e.reply.message
      .filter((item) => item.type === "image")
      .map((item) => item.data.url);
    imgs.push(...replyImages);
  }

  // 处理图片
  if (e.img && e.img.length > 0) {
    console.log("有图片");

    for (const imgUrl of e.img) {
      imgs.push(imgUrl);
    }
  }

  console.log("开始回复");

  // 处理图片链接, 转为base64格式

  // 下载图片并转换为 Base64
  const imageurls = await Promise.all(
    imgs.map(async (imageUrl) => {
      return await uploadImageToR2(imageUrl);
    }),
  );
  // 过滤掉下载失败的图片
  const validImageUrls = imageurls.filter((img) => img !== null);

  // 处理艾特
  if (e.at && e.at.length > 0) {
    console.log("有艾特");
    for (const atItem of e.at) {
      const qq = atItem.data.qq;
      const nickname = atItem.data.nickname || "未知昵称";
      const cqAt = `[CQ:at,qq=${qq}]`;
      rawMessage = rawMessage.replace(cqAt, `@${nickname}`);
    }
  }

  let index = 0; // 用于跟踪当前访问的 validImageUrls 的索引
  rawMessage = rawMessage.replace(/\[CQ:image,[^\]]+\]/g, () => {
    const imageUrl = validImageUrls[index];
    index++; // 每次匹配后索引加1
    return imageUrl ? `![图片${index}](${imageUrl})` : "[图片]";
  });

  rawMessage = rawMessage.replace(/\[CQ:reply,[^\]]+\]/g, "");
  // 处理表情,转为[emojiMap[id]]
  rawMessage = rawMessage.replace(/\[CQ:face,id=(\d+)\]/g, (_match, p1) => {
    return `[${emojiMap[p1]}]`;
  });

  const usermessage = {
    role: "user",
    content: [
      ...validImageUrls.map((url) => ({
        type: "image_url",
        image_url: {
          url: url,
        },
      })),
      {
        type: "text",
        text: JSON.stringify({
          [`${e.nickname}(${getTimeString()})`]: rawMessage,
        }),
      },
    ],
  };

  console.log("处理后的消息", JSON.stringify(usermessage, null, 2));
  console.log("好感度列表", affections);

  const openai = new OpenAi({
    baseURL: config.host,
    apiKey: config.key,
    timeout: 300000,
  });

  let messages = [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "system",
      content: config.systemPrompt || "",
    },
    ...historyMessages,
    { ...usermessage },
  ];

  let res = await openai.chat.completions.create({
    model: config.model,
    tools,
    tool_choice: "auto",
    // reasoning_effort: "low",
    messages: messages,
  });

  if (!res.choices || res.choices.length === 0) {
    log("AI未返回内容");
    return;
  }

  messages.push(usermessage);
  await addAIChatHistory(e.guid, usermessage);

  // 检查是否有工具调用需要处理
  while (res.choices[0].message?.tool_calls?.length) {
    const responseMessage = res.choices[0].message as any;

    // 先处理对话
    messages.push(responseMessage);
    await addAIChatHistory(e.guid, responseMessage);

    if (
      responseMessage.tool_calls.find(
        (tc: any) => tc.function.name === "StableDiffusionImageToPrompt",
      )
    ) {
      message.send(format(Text("我瞅瞅这图片长啥样~稍等一会儿哦~")));
    }

    if (
      responseMessage.tool_calls.find(
        (tc: any) => tc.function.name === "StableDiffusionGenerateImage",
      )
    ) {
      message.send(format(Text("好的, 我这就去画图~稍等一会儿哦~")));
    }

    console.log("模型决定调用工具：", responseMessage.tool_calls);
    for (const toolCall of responseMessage.tool_calls) {
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      const functionToCall = availableTools[functionName];

      if (!functionToCall) {
        console.error(`未找到函数：${functionName}`);
        continue;
      }

      // 执行本地函数
      const functionResult = await functionToCall(functionArgs);

      // 把工具执行结果作为 tool role 消息加回对话
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: functionName,
        content: JSON.stringify(functionResult),
      });

      // 记录工具调用结果
      await addAIChatHistory(e.guid, {
        role: "tool",
        tool_call_id: toolCall.id,
        name: functionName,
        content: JSON.stringify(functionResult),
      });
    }

    // 重新请求
    res = await openai.chat.completions.create({
      model: config.model,
      messages: messages,
      tools,
      tool_choice: "auto",
    });

    // 检查是否还有工具调用需要处理
    if (!res.choices || res.choices.length === 0) {
      log("AI未返回内容");
      return;
    }
  }

  // 如果没有工具调用，处理最终回复
  const reply =
    res.choices?.[0]?.message?.content?.trim().replace(/'/g, '"') || "";
  log("AI回复内容:", reply);

  // 提取好感变化, 使用incrementAffectionLevel更新好感
  if (affectionIsOpen === "1") {
    let affectionUpdated = false;

    try {
      const aiReplys = JSON.parse(reply);
      for (const aiReply of aiReplys) {
        if (aiReply.affections) {
          const change = parseInt(aiReply.affections, 10);
          if (!isNaN(change) && change !== 0) {
            await incrementAffectionLevel(e.userKey, change);
            console.log(`更新好感度: ${e.userKey} 改变 ${change}`);
            affectionUpdated = true;
          }
        }
      }
    } catch (error) {
      console.log("解析AI好感变化失败:", error);
    }

    if (!affectionUpdated) {
      const affectionChangeRegex = /【|\[好感([+-]\d+)\]|】/g;
      let match;
      while ((match = affectionChangeRegex.exec(reply)) !== null) {
        const change = parseInt(match[1], 10);
        if (!isNaN(change) && change !== 0) {
          console.log(`检测到好感变化: ${change}`);
          await incrementAffectionLevel(e.userKey, change); // 更新好感度
        }
      }
    }
  }
  // 记录对话
  await addAIChatHistory(e.guid, res.choices?.[0].message);

  const isOpenTTSReply =
    (await redis.get(`ai:tts:reply:switch:${e.guid}`)) || "0";

  if (isOpenTTSReply === "1") {
    ttsClient = new TTSClient();
    await ttsClient.setModel("三月七", "生气");
  }

  // 解析回复内容
  try {
    const aiReplys = JSON.parse(reply);
    // ai回答
    console.log("aiReplys", JSON.stringify(aiReplys, null, 2));

    for (let i = 0; i < aiReplys.length; i++) {
      const aiReply = aiReplys[i];
      if (aiReply.assistant) {
        if (i > 0) {
          // 从第二个回复开始，添加1-4秒随机延迟
          const delay = Math.floor(Math.random() * 3000) + 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const msg = aiReply.assistant.replace(/\[CQ:[^\]]+\]/, "").trim();

        if (aiReply.image_url) {
          const replyRes = await message.send(
            format(Text(msg), ImageFile(aiReply.image_url)),
          );
          if (replyRes[0].code !== 2000) {
            console.log("发送消息失败:", replyRes);
            await message.send(format(Text(msg)));
            await message.send(format(ImageFile(aiReply.image_url)));
          }
        } else {
          message.send(format(Text(msg)));
        }
        if (isOpenTTSReply === "1") {
          sendTTSMessage(msg, e, ttsClient);
        }
      } else {
        if (aiReply.image_url) {
          await message.send(format(ImageFile(aiReply.image_url)));
        }
      }
    }
  } catch (error) {
    console.log("解析AI回复失败，发送原始内容");
    const msg = reply
      .replace(/\[CQ:[^\]]+\]/, "")
      .replace(/"}]/, "")
      .replace(/\[{"assistant":"/, "")
      .trim();
    message.send(format(Text(reply)));
    if (isOpenTTSReply === "1") {
      sendTTSMessage(msg, e, ttsClient);
    }
  }
});

function sendTTSMessage(message: any, e: any, ttsClient: TTSClient) {
  // 发送TTS语音
  ttsClient.getAudio(message).then(async (audio) => {
    console.log("audio", audio);

    if (audio) {
      if (e.Platform == "onebot") {
        const [client] = useClient(e, API);

        client.sendMessage({
          message_type: e.value.message_type,
          group_id: e.value.group_id ?? undefined,
          message: [
            {
              type: "record",
              data: {
                file: audio.audio_url,
              },
            },
          ],
        });
      }
    }
  });
}
