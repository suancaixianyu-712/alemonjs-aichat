import { emojiMap } from "@src/emoji";
import { uploadImageToR2 } from "@src/s3";
import {
  ImageFile,
  ImageURL,
  Mention,
  Text,
  useMessage,
} from "alemonjs";
import { log } from "console";
import OpenAi from "openai";
import { isImageUrlToolContent } from "@src/api/image-url-tool";
import { sendSpeechToolResult } from "@src/api/speech";
import { getOpenAIProxyFetch } from "../../api/openaiProxy";
import { getAiChatConfigValue } from "@src/config/app";
import { getGroupTimeString, getMessageTimeString } from "@src/api/format";
import {
  availableTools,
  removePublicIpFromOutput,
  removePublicIpFromToolArguments,
  assertAgentToolAccess,
  tools,
} from "@src/api/aitools";
import { loadSkills } from "@src/api/loadSkill";
import redisClient from "@src/config";
import {
  extractFilesFromReplySegments,
  formatFileBlock,
  resolveFileContent,
  type FileMediaItem,
} from "@src/api/fileMessage";
import errorimg from "@src/assets/error.png";
import { buildXianyuGameSession } from "@src/api/xianyu-game";
import { isNonVisionModel } from "./getChatConfig";
import {
  annotatePermissionBoundary,
  buildUserPermissionPrompt,
} from "@src/api/user-permission";
import { toolSessionController } from "@src/api/tool-session-controller";

const value = getAiChatConfigValue();

export const selects = onSelects(["message.create", "private.message.create"]);

export default onResponse(selects, async (e, next) => {
  console.log("e.UserId", e.UserId, e.bot);

  // 如果是命令则跳过
  if (
    e.msg.startsWith("/") ||
    e.msg.startsWith("#") ||
    e.UserId == e.bot.user_id
  ) {
    next();
    return;
  }
  const config = await redisClient.getAIConfig(e.guid);
  const complexOutputIsOpen = await redisClient.getComplexOutput(e.guid); // 复杂输出
  const affectionIsOpen = await redisClient.getAffectionSwitch(e.guid); // 好感度开关
  const isOpenR18 = await redisClient.getR18Switch(e.guid); // R18开关
  const proactiveSwitch = await redisClient.getProactiveSwitch(e.guid); // 主动搭话开关
  const deepThoughtSwitch = await redisClient.getDeepThoughtSwitch(e.guid); // 深度思考开关
  const fileMessageSwitch = await redisClient.getFileMessageSwitch(e.guid); // 文件消息开关
  console.log(
    "isOpenR18",
    isOpenR18,
    "proactiveSwitch",
    proactiveSwitch,
    "deepThoughtSwitch",
    deepThoughtSwitch,
  );

  const skills = loadSkills(); // 加载技能列表
  const relevantMemoryContext = await redisClient.getRelevantMemoryContext(
    e.guid,
    String(e.UserId || ""),
    e.msg || "",
    3,
  );
  // 创建消息
  const [message] = useMessage(e);
  const historyMessages = await redisClient.getAIChatHistory(e.guid);
  const affections = await redisClient.getAffectionLevelAll(e.guid);
  const imgs: string[] = [];
  let rawMessage = e.value.raw_message || e.raw_message || e.msg;

  // 收集文件消息（普通文件消息 / 群文件上传 / 私聊离线文件 / 引用中的文件）
  const isFileNoticeEvent =
    e.tag === "NOTICE_GROUP_UPLOAD" || e.tag === "NOTICE_OFFLINE_FILE";
  const fileItems: FileMediaItem[] =
    fileMessageSwitch === "1"
      ? [
          ...(e.MessageMedia || []),
          ...extractFilesFromReplySegments(e.reply?.message),
        ].filter((item) =>
          ["file", "audio", "video"].includes(String(item.Type)),
        )
      : [];
  const botName = e.bot.nickname || "小咸鱼";
  const userPermissionPrompt = buildUserPermissionPrompt({
    isMaster: e.IsMaster === true,
    isAdmin: (e as { isAdmin?: boolean }).isAdmin === true,
    isPrivate:
      e.name === "private.message.create" ||
      (e as { Name?: string }).Name === "private.message.create",
    agentEnabled: (await redisClient.getAgentSwitch(e.guid)) === "1",
    opencodeActive:
      (await toolSessionController.getCurrentTool(e.guid)) === "opencode",
    opencodePermission: await toolSessionController.getPermission(e.guid),
  });
  const systemPrompt = `
# AI助手回复规范
请严格按照以下规范进行回复, 不要添加任何不必要的内容, 也不要删除或修改规范中的任何内容, 以确保回复能够被正确解析和处理

## 技能
在遇到用户需要执行特定操作时,先获取对应的技能,如果有可用技能,获取该技能,并严格按照技能文档要求的格式调用, 不要添加任何多余的内容, 也不要删除或修改规范中的任何内容, 以确保技能能够被正确解析和处理
当没有技能可以应对需求时, 就自行挑选合适的工具函数来完成用户的需求
如果用户在继续之前的话题、问你记不记得、提到上次/刚才/之前聊过的内容，先参考系统自动检索到的相关记忆；如果还不够，再调用 MemoryOperation，优先使用 chatHistory 的 search:关键词 或 guid:id 补充历史上下文

调用执行脚本类型的工具时, 务必确保脚本安全, 不得执行对服务器有伤害的脚本
${userPermissionPrompt}
---
技能列表:
${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}
---
${relevantMemoryContext ? `\n系统预检索记忆:\n${relevantMemoryContext}\n---\n` : ""}

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
  fileMessageSwitch === "1"
    ? `
文件消息:
用户发送文件时, 消息中会包含 [文件] 文件名 (大小) 与下载链接, 文本类文件会附带文件内容
对于附带内容的文件, 直接阅读内容并回答; 对于只有下载链接的文件, 如需读取内容可调用 ReadRemoteFile 工具按链接获取
用户上传文件后, 可以自然地评价或讨论这个文件, 不需要复述下载链接
`
    : ""
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
当前群时间:${getGroupTimeString()}
当前群号:${e.guid}
当前群名称:${e.GroupName || "无"}
当前聊天平台:${e.Platform}
当前框架:alemonjs
${e.ClientError ? `当前错误信息:${e.ClientError}` : ""}
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
    next();
    return;
  }

  // 正则触发的消息跳过概率过滤，直接响应
  if (e["regexTriggered"]) {
    console.log("正则规则匹配, 直接触发AI回复");
  } else if (fileItems.length > 0 || isFileNoticeEvent) {
    // 文件消息直接响应, 不做概率过滤
    console.log("文件消息, 直接触发AI回复");
  } else {
    // 当e.at不存在时,只给20%概率继续执行, 当e.at存在时,概率为40%,当e.atBot存在时,概率为100%
    const rand = Math.random();

    if (e.Name !== "private.message.create") {
      if (proactiveSwitch !== "1" && e.at && !e.atBot) {
        console.log("未开启主动搭话, 跳过AI回复");
        next();
        return;
      }
      if ((!e.at && rand > 0.1) || (e.at && !e.atBot && rand > 0.2)) {
        console.log("跳过AI回复");
        next();
        return;
      }
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

  // 处理文件消息
  let fileBlocks = "";
  if (fileItems.length > 0) {
    console.log("有文件消息", fileItems.length, "个");
    const resolvedFiles = (
      await Promise.all(fileItems.map((item) => resolveFileContent(item, e)))
    ).filter((file) => file !== null);

    // 图片类型的文件复用图片管线
    for (const file of resolvedFiles) {
      if (file.kind === "image" && file.url) {
        imgs.push(file.url);
      }
    }

    fileBlocks = resolvedFiles.map(formatFileBlock).join("\n\n");
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

  // console.log("validImageUrls", validImageUrls);

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
  rawMessage = rawMessage.replace(/\[CQ:file,[^\]]+\]/g, "[文件]");
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

  // 注入文件信息块
  if (fileBlocks) {
    rawMessage = `${rawMessage ? rawMessage + "\n" : ""}${fileBlocks}`;
  } else if (isFileNoticeEvent && !rawMessage.trim()) {
    // 群文件上传/私聊离线文件事件没有文本, 合成提示
    rawMessage = "发送了一个文件";
  }

  // 处理表情,转为[emojiMap[id]]
  rawMessage = rawMessage.replace(
    /\[CQ:face,id=(\d+),[^\]]+\]/g,
    (_match, p1) => {
      return `[${emojiMap[p1]}]`;
    },
  );

  console.log("处理后的消息内容:\n", rawMessage);

  const senderName = e.nickname || e.UserName || "用户";
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
                [`${senderName}(${getMessageTimeString()})`]: rawMessage,
              })
            : `${senderName}(${getMessageTimeString()}): ${rawMessage}`,
      },
    ],
  };

  console.log("处理后的消息", JSON.stringify(usermessage, null, 2));
  console.log("好感度列表", affections);

  try {
    const openai = new OpenAi({
      baseURL: config.host,
      apiKey: config.key,
      timeout: 300000,
      fetch: getOpenAIProxyFetch(
        value.httpProxy,
        redisClient.isAIProxyEnabled(config),
      ),
    });

    let messages = redisClient.sanitizeChatMessages([
      {
        role: "system",
        content: `${systemPrompt}\n性格约束:${config.systemPrompt}\n\n${userPermissionPrompt}`,
      },
      ...historyMessages,
      { ...usermessage },
    ]);

    const isTool = await redisClient.getToolSwitch(e.guid);

    const createParams: any = {
      model: config.model,
      messages: messages,
    };

    if (isTool === "1") {
      const availableTools = await redisClient.getAvailableTools(e.guid);
      createParams["tools"] = availableTools.filter(
        (tool) =>
          isNonVisionModel(config.model) ||
          tool.function?.name !== "DescribeImage",
      );
      createParams["tool_choice"] = "auto";
    }
    if (deepThoughtSwitch === "0") {
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

    const normalizeToolCalls = (items: any[]) =>
      (Array.isArray(items) ? items : [])
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

    const normalizedInitialToolCalls = normalizeToolCalls(toolCalls);

    let res: any = {
      choices: [
        {
          message: {
            role: "assistant",
            content: fullContent || null,
            tool_calls:
              normalizedInitialToolCalls.length > 0
                ? normalizedInitialToolCalls
                : undefined,
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
    while (res.choices[0].message?.tool_calls?.length) {
      const rawResponseMessage = res.choices[0].message as any;
      const normalizedToolCalls = normalizeToolCalls(
        rawResponseMessage?.tool_calls,
      );

      if (normalizedToolCalls.length === 0) {
        break;
      }

      const responseMessage = {
        ...rawResponseMessage,
        role: "assistant",
        tool_calls: normalizedToolCalls,
      };

      // 先处理对话
      messages.push(responseMessage);

      console.log("模型决定调用工具：", responseMessage.tool_calls);
      const useToolsMessage = responseMessage.tool_calls.map((toolCall) => {
        return `工具调用: ${toolCall.function.name}(${toolCall.function.arguments})`;
      });
      const msgId = await message.send(
        format(
          Text(
            removePublicIpFromOutput(
              useToolsMessage.join("\n"),
              e.IsMaster === true,
            ),
          ),
        ),
      );
      // 30秒后撤回消息
      setTimeout(() => {
        message.delete({ messageId: msgId[0].data.message_id });
      }, 30000);
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

        if (
          functionName === "ScheduleAITask" &&
          functionArgs &&
          typeof functionArgs === "object"
        ) {
          functionArgs.userID = String(e.UserId || "");
          functionArgs.platform = e.Platform;
          functionArgs.spaceId = e.SpaceId;
          functionArgs.isPrivate = e.name === "private.message.create";
        }

        if (
          (functionName === "RunOpencode" || functionName === "RunCodex") &&
          functionArgs &&
          typeof functionArgs === "object"
        ) {
          functionArgs.userID = String(e.UserId || "");
        }

        if (
          functionName === "XianyuGame" &&
          functionArgs &&
          typeof functionArgs === "object"
        ) {
          // 覆盖式注入真实会话作用域：AI 新建的扫雷对局写入该作用域，
          // 而不是依赖上一次 #扫雷 留下的旧会话。
          functionArgs.session = buildXianyuGameSession(e);
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
            const toolGuid = await assertAgentToolAccess(
              functionName,
              e.guid,
              functionArgs?.scope,
              e.IsMaster === true,
            );
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
              // 公共知识库仅映射工作目录；审核配置仍绑定真实会话。
              if (functionArgs && typeof functionArgs === "object") {
                functionArgs.guid = toolGuid;
                if (
                  functionName === "RunServerCommand" ||
                  functionArgs.scope === "public" ||
                  functionArgs.scope === "root"
                ) {
                  functionArgs.reviewGuid = e.guid;
                }
              }
              removePublicIpFromToolArguments(
                functionName,
                functionArgs,
                e.IsMaster === true,
              );
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

        if (
          functionName === "GenerateSpeech" ||
          functionName === "MiniMaxVoice"
        ) {
          await sendSpeechToolResult(message, functionResult);
        }

        const toolContent = isImageUrlToolContent(functionResult)
          ? "图片已转换，图片内容见下一条输入。"
          : JSON.stringify(
              annotatePermissionBoundary(
                typeof functionResult === "undefined"
                  ? { ok: true, result: null }
                  : functionResult,
              ),
            );

        // 把工具执行结果作为 tool role 消息加回对话（仅保留合法字段）
        const toolMessage = {
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolContent,
        };
        messages.push(toolMessage);
        toolMessages.push(toolMessage);
        if (isImageUrlToolContent(functionResult)) {
          const imageMessage = {
            role: "user" as const,
            content: functionResult,
          };
          messages.push(imageMessage);
          toolMessages.push(imageMessage);
        }
      }

      await redisClient.addAIChatHistoryBatch(e.guid, [
        responseMessage,
        ...toolMessages,
      ]);

      messages = redisClient.sanitizeChatMessages(messages);

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
    reply = removePublicIpFromOutput(reply, e.IsMaster === true);
    if (reply === `${botName}:[]`) {
      log("AI选择不回复");
      return;
    }

    console.log("AI回复:\n", reply);

    // 处理消息
    // 提取ai发送的消息有多少条
    const replyMessages = reply.split(new RegExp(`${botName}:`, "g")).slice(1);

    const replymessages: { text: string; images: string[] }[] = [];

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
          await redisClient.incrementAffectionLevel(e.guid, nickname, change);
        }
      }

      // 组合消息,添加到replymessages数组中
      replymessages.push({
        text: replyMessage.replace(imageRegex, "").trim(),
        images: imgUrls,
      });
    }
    // 记录对话
    await redisClient.addAIChatHistory(e.guid, {
      ...res.choices?.[0].message,
      content: reply,
    });

    // 处理消息
    for (let i = 0; i < replymessages.length; i++) {
      const { text, images } = replymessages[i];
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
        if (isOpenR18 !== "1" && finalImg) {
          try {
            if (res?.conclusion === "不合规") {
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

      // 随机 1-3 秒延迟
      const delay = Math.random() * 2000 + 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      await message.send(format(...components));
    }
    return;
  } catch (error) {
    console.error("AI回复出错", error);
    // 清理聊天记录
    await redisClient.clearLastNChatHistory(e.guid, 5);
    message.send(format(Text("AI回复出错了, 已清理聊天记录~\n" + error)));
    next();
  }
});
