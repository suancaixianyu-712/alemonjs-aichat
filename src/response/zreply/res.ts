import { API } from "@alemonjs/onebot";
import { availableTools, getTimeString, TTSClient } from "@src/api";
import {
  addAIChatHistory,
  getAffectionLevelAll,
  getAffectionSwitch,
  getAIChatHistory,
  getAIConfig,
  getTTSResponseSwitch,
  incrementAffectionLevel,
  tools,
} from "@src/config";
import { emojiMap } from "@src/emoji";
import { redis } from "@src/redis";
import { uploadImageToR2 } from "@src/s3";
import {
  ImageFile,
  ImageURL,
  Mention,
  Text,
  useClient,
  useMessage,
} from "alemonjs";
import { log } from "console";
import OpenAi from "openai";
import { getConfigValue } from "alemonjs";
const value = getConfigValue();

export const selects = onSelects(["message.create", "private.message.create"]);
export const regular = /.*/;
let ttsClient: TTSClient;

let currentModel = "派蒙-默认"; // 默认音色

export default onResponse(selects, async (e, next) => {
  console.log("收到消息");

  console.log("e.UserId", e.UserId, e.bot.user_id);

  // 如果是命令则跳过
  if (
    e.msg.startsWith("/") ||
    e.msg.startsWith("#") ||
    e.UserId == e.bot.user_id
  ) {
    next();
    return;
  }

  const complexOutputIsOpen =
    (await redis.get(`chat:complex:response:${e.guid}`)) || "1"; // 复杂输出开关
  const affectionIsOpen = await getAffectionSwitch(e.guid); // 好感度开关
  const isOpenTTSReply = await getTTSResponseSwitch(e.guid); // TTS回复开关
  const isOpenR18 = (await redis.get(`chat:r18:response:${e.guid}`)) || "1"; // R18开关
  // 创建消息
  const [message] = useMessage(e);
  const config = await getAIConfig(e.guid);
  const historyMessages = await getAIChatHistory(e.guid);
  const affections = await getAffectionLevelAll(e.guid);
  const imgs: string[] = [];
  let rawMessage = e.value.raw_message || e.raw_message || e.msg;
  const botName = e.bot.nickname || "小咸鱼";
  const systemPrompt = `
## 关于回复格式:
### 用户发言
- 格式: [私聊]用户昵称(用户id)(发送时间):消息内容
当场景为私聊时, 用户昵称前方会出现[私聊]标识
### 你的回复格式
格式:
${botName}:消息内容

消息叠加:
你可以使用多个叠加, 来模拟发送多条消息, 让聊天显得更真实, 例如:
${botName}:早上好
${botName}:吃过早饭了吗

${
  complexOutputIsOpen === "1"
    ? `
发送图片:
你可以使用<img=图片链接>的方式来发送图片, 允许发送多张图, 例如:
${botName}:画好了<img=https://example.com/landmarks.jpg>
支持发送网络图片和相对路径图片, 例如:
${botName}:这是本地图片<img=./localimage.jpg>
${botName}:这是网络图片<img=https://example.com/image.jpg>
注意: 如果有用户问你能不能看动图时, 你要回答只能看到第一帧
`
    : ""
}

${
  complexOutputIsOpen === "1" && isOpenTTSReply === "1"
    ? `\n语音回复:
你可以使用语音回复来让你的回复更生动, 例如:
${botName}:你好呀~<tts=你好呀~>
可以通过调用GetTTSModels工具函数获取音色列表, 可使用<tts=内容,音色=派蒙-情感>的格式来指定音色,设置一次后, 后面的回复将使用相同的音色, 例如:
${botName}:这是派蒙的声音哦~<音色=派蒙-默认><tts=这是派蒙的默认声音哦>
${botName}:现在还是派蒙的声音哦~<tts=现在还是派蒙的声音哦>
注意: 语音回复会增加回复时间, 请合理使用
注意: 不可使用列表中不存在的音色, 否则会回复失败
注意: 在设置音色时只需要指定模的角色名字和情感, 例如模型是"星穹铁道-中文-花火", 则音色应该设置为"花火-情感", 而不是"星穹铁道-中文-花火-情感"
注意: 使用语音必须用${botName}:开头, 否则不会处理, 例如:
<tts=你好> 这是错误的格式, 不会被处理
${botName}:<tts=你好> 这是正确的格式, 会被处理

`
    : "语音回复: 当前不可用"
}

${
  isOpenR18 === "1"
    ? ""
    : `
R18内容:
当用户发送的消息中包含敏感词时, 提醒用户注意言辞, 并且不回答用户的问题, 务必遵守国家法律法规
`
}


${
  affectionIsOpen === "1" && complexOutputIsOpen === "1"
    ? `好感度系统:
好感度主要影响回复该用户的语气, 对低好感度的用户破口大骂, 对高好感度的用户温柔以待
例如增加:
${botName}:主人你对我真好<好感+1>
例如减少:
${botName}:滚一边去吧,傻b<好感-2>

其他情况, 例如指定修改对某个用户的好感:
${botName}:原来ta是这样的人, 人家以后再也不理ta了<用户昵称好感-1>
假设对方昵称为'哈基米':
${botName}:原来ta是这样的人, 人家以后再也不理ta了<哈基米好感-1>`
    : ""
}

拒绝回复:
在讨论中如果你觉得不适合回复或觉得与你无关又或者不感兴趣, 可以直接回复"[]"来拒绝本次回复, 例如:
${botName}:[]

基础状态信息:
这里的信息会实时变化,根据需要进行获取使用
当前群时间:${getTimeString()}
当前群号:${e.guid}
当前群名称:${e.GroupName || "无"}
`;

  // 如果没有配置AI,则不处理
  if (
    config.host.trim() === "" ||
    config.key.trim() === "" ||
    config.model.trim() === ""
  ) {
    return;
  }

  console.log("e.reply", e.reply);

  // 发消息的人是机器人自己, 则不处理
  if (e.UserId == e.bot.user_id) {
    return;
  }

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
  if (complexOutputIsOpen === "1") {
    if (e.reply) {
      const replyImages = e.reply.message
        .filter((item) => item.type === "image")
        .map((item) => item.data.url);
      imgs.push(...replyImages);
      const replyAt = e.reply.message
        .filter((item) => item.type === "at")
        .map((item) => item.data);
      const replyContent = e.reply.message
        .filter((item) => item.type === "text")
        .map((item) => item.data.text)
        .join("");

      if (replyAt.length > 0) {
        for (const atItem of replyAt) {
          const qq = atItem.qq;
          const nickname = atItem.nickname || "未知昵称";
          const cqAt = `[CQ:at,qq=${qq}]`;
          rawMessage = rawMessage.replace(cqAt, `@${nickname}`);
        }
      }

      rawMessage = rawMessage.replace(/\[CQ:image,[^\]]+\]/g, "[图片]");
      rawMessage = `[回复:${replyContent}]` + "\n" + rawMessage;
    }

    // 处理图片
    if (e.img && e.img.length > 0) {
      console.log("有图片");

      for (const imgUrl of e.img) {
        imgs.push(imgUrl);
      }
    }
  }

  console.log("开始回复");

  // 下载图片并转换为 Base64
  const imageurls = await Promise.all(
    imgs.map(async (imageUrl) => {
      return await uploadImageToR2(imageUrl);
    }),
  );
  // 过滤掉下载失败的图片
  const validImageUrls = imageurls.filter((img) => img !== null);

  console.log("validImageUrls", validImageUrls);

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

  if (/\[CQ:reply,[^\]]+\]/.test(rawMessage)) {
    rawMessage = rawMessage.replace(/\[CQ:reply,[^\]]+\]/g, "");
    validImageUrls.map((url) => {
      rawMessage += `\n![图片](${url})`;
    });
  }

  // 处理表情,转为[emojiMap[id]]
  rawMessage = rawMessage.replace(
    /\[CQ:face,id=(\d+),[^\]]+\]/g,
    (_match, p1) => {
      return `[${emojiMap[p1]}]`;
    },
  );

  console.log("处理后的消息内容:\n", rawMessage);

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
        text:
          complexOutputIsOpen === "1"
            ? JSON.stringify({
                [`${e.nickname}(${getTimeString()})`]: rawMessage,
              })
            : `${e.nickname}(${getTimeString()}): ${rawMessage}`,
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

  const isTool = await redis.get(`chat:tools:response:${e.guid}`);

  const createParams = {
    model: config.model,
    messages: messages,
  };

  if (isTool === "1") {
    createParams["tools"] = tools;
    createParams["tool_choice"] = "auto";
  }

  let res = await openai.chat.completions.create(createParams);

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

    if (
      responseMessage.tool_calls.find((tc: any) => tc.function.name === "AIPS")
    ) {
      message.send(format(Text("开始修图中~稍等一会儿哦~")));
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
  let reply = res.choices?.[0]?.message?.content?.trim() || `${botName}:[]`;
  if (reply === `${botName}:[]`) {
    log("AI选择不回复");
    return;
  }

  console.log("AI回复:\n", reply);

  // 处理消息
  // 提取ai发送的消息有多少条
  const replyMessages = reply.split(new RegExp(`${botName}:`, "g")).slice(1);

  const replymessages: { text: string; images: string[] }[] = [];
  const ttsMessages: { text: string; model: string }[] = [];

  for (const replyMessage of replyMessages) {
    // 从消息中提取图片
    const imageRegex = /<img=(.*?)>/g;
    let match;
    const imgUrls: string[] = [];
    while ((match = imageRegex.exec(replyMessage)) !== null) {
      imgUrls.push(match[1]);
    }

    // 处理好感度变化（通用和特定用户）
    const affectionRegex = /<([^<>]*?)好感([+-]\d+)>/g;
    let affectionMatch: RegExpExecArray | null;
    while ((affectionMatch = affectionRegex.exec(replyMessage)) !== null) {
      const nickname = affectionMatch[1] || (e.UserName as string);
      const change = parseInt(affectionMatch[2], 10);
      if (!isNaN(change) && change !== 0) {
        console.log(`检测到对${nickname}的好感变化: ${change}`);
        await incrementAffectionLevel(e.guid, nickname, change);
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
      text: replyMessage.replace(imageRegex, "").replace(ttsRegex, "").trim(),
      images: imgUrls,
    });
  }
  // 记录对话
  await addAIChatHistory(e.guid, res.choices?.[0].message);

  // 发送消息
  if (isOpenTTSReply === "1") {
    // 提前发送语音消息避免等待时间过长
    ttsClient = new TTSClient();
    console.log("发送语音", ttsMessages);

    for (const ttsMessage of ttsMessages) {
      sendTTSMessage(ttsMessage.text, e, ttsClient, ttsMessage.model);
    }
  }

  // 处理消息
  for (let i = 0; i < replymessages.length; i++) {
    const { text, images } = replymessages[i];
    const components: any[] = i === 0 ? [Mention(e.UserId)] : [];
    components.push(Text(text));
    for (const img of images) {
      const isNetworkImage = /^https?:\/\//.test(img);
      if (e.Platform == "scbbs" && isNetworkImage) {
        // scbbs平台不支持网络图片, 需要先下载再上传
        const uploadedUrl = await uploadImageToR2(
          img.replace(
            "https://imgen.x.ai",
            value.xaiImgProxy || "https://imgen.x.ai",
          ),
        );
        if (uploadedUrl) {
          components.push(ImageURL(uploadedUrl));
        }
      } else {
        const imageComponent = isNetworkImage ? ImageURL(img) : ImageFile(img);
        components.push(imageComponent);
      }
    }
    // 添加随机1-3秒延迟
    const delay = Math.random() * 2000 + 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    await message.send(format(...components));
  }

  return;
});

export async function sendTTSMessage(
  message: any,
  e: any,
  ttsClient: TTSClient,
  modelAndEmotion: string,
) {
  const [model, emotion] = modelAndEmotion.split("-");
  console.log("message", message, "model", model, "emotion", emotion);

  await ttsClient.setModel(model || "派蒙", emotion || "默认");
  // 发送TTS语音
  ttsClient.getAudio(message).then(async (audio) => {
    console.log("audio", audio);

    if (audio) {
      try {
        if (e.Platform == "onebot") {
          const [client] = useClient(e, API);

          await client.sendMessage({
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
      } catch (error) {
        console.log(error);
      }
    }
  });
}
