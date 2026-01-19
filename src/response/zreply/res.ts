import { uploadImage } from "@src/api";
import {
  addAIChatHistory,
  getAffectionLevelAll,
  getAIChatHistory,
  getAIConfig,
  incrementAffectionLevel,
} from "@src/config";
import { emojiMap } from "@src/emoji";
import { redis } from "@src/redis";
import { Text, useMessage } from "alemonjs";
import { log } from "console";
import OpenAi from "openai";

export const selects = onSelects(["message.create", "private.message.create"]);
export const regular = /.*/;

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
  const messages = await getAIChatHistory(e.guid);
  const affections = await getAffectionLevelAll(e.guid);
  const imgs: string[] = [];
  let rawMessage = e.value.raw_message || e.msg;
  const affectionIsOpen =
    (await redis.get(`ai:affection:switch:${e.guid}`)) || "1";
  const botName = e.bot.nickname || "小咸鱼";
  const systemPrompt =
    `你正在一个群聊中跟用户聊天,你的聊天昵称是'${botName}'
      用户的发言方式为: [{'用户昵称(用户id)(发送时间)':回复内容}]
      你的回复方式为JSON: [{assistant:回复内容}],你可以在数组中加入多条消息来模拟更真实的聊天
      当然你觉得当前聊的话题确定与你有关是才回复,否则你就回复空数组[]来表示不回复.请尽可能降低回复频率.
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
  const imageBase64 = await Promise.all(
    imgs.map(async (imageUrl) => {
      try {
        // 下载图片到本地
        const response = await fetch(imageUrl);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        return `data:image/jpeg;base64,${base64}`;
      } catch (error) {
        console.error("Error downloading image:", error);
        return null;
      }
    }),
  );
  // 过滤掉下载失败的图片
  const validImageBase64 = await uploadImage(
    imageBase64.filter((base64) => base64 !== null),
  );

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

  rawMessage = rawMessage.replace(/\[CQ:image,[^\]]+\]/g, "[图片]");
  rawMessage = rawMessage.replace(/\[CQ:reply,[^\]]+\]/g, "");
  // 处理表情,转为[emojiMap[id]]
  rawMessage = rawMessage.replace(/\[CQ:face,id=(\d+)\]/g, (_match, p1) => {
    return `[${emojiMap[p1]}]`;
  });

  const usermessage = {
    role: "user",
    content: [
      ...validImageBase64.map((base64) => ({
        type: "image_url",
        image_url: {
          url: base64,
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
  });

  const res = await openai.chat.completions.create({
    model: config.model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "system",
        content: config.systemPrompt || "",
      },
      ...messages,
      { ...usermessage },
    ],
  });

  if (!res.choices || res.choices.length === 0) {
    log("AI未返回内容");
    return;
  }
  const reply = res.choices?.[0]?.message?.content?.trim() || "AI未返回内容";
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
  await addAIChatHistory(e.guid, "user", JSON.stringify(usermessage.content));
  await addAIChatHistory(e.guid, "assistant", reply);

  // 解析回复内容
  try {
    const aiReplys = JSON.parse(reply);
    for (let i = 0; i < aiReplys.length; i++) {
      const aiReply = aiReplys[i];
      if (aiReply.assistant) {
        if (i > 0) {
          // 从第二个回复开始，添加1-4秒随机延迟
          const delay = Math.floor(Math.random() * 3000) + 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        message.send(
          format(Text(aiReply.assistant.replace(/\[CQ:[^\]]+\]/, "").trim())),
        );
      }
    }
  } catch (error) {
    console.log("解析AI回复失败，发送原始内容");
    message.send(format(Text(reply)));
  }
});

function getTimeString() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}
