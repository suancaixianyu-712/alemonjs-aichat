import { getGroupTimeString, getMessageTimeString } from "@src/api/format";
import { loadSkills } from "@src/api/loadSkill";
import redisClient from "@src/config";
import { Events } from "alemonjs";
import { emojiMap } from "@src/emoji";
import { uploadImageToR2 } from "@src/s3";

type ToolMode = "capi" | "rapi";

/**
 * 将 tools 在 CAPI / RAPI 之间转换
 */
export const normalizeTools = (tools: any[], mode: ToolMode) => {
  if (!Array.isArray(tools)) return [];

  // =========================
  // CAPI：chat.completions
  // =========================
  if (mode === "capi") {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name ?? t.function?.name,
        description: t.description ?? t.function?.description,
        parameters: t.parameters ??
          t.function?.parameters ?? {
            type: "object",
            properties: {},
          },
      },
    }));
  }

  // =========================
  // RAPI：responses API
  // =========================
  return tools.map((t) => ({
    type: "function",
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description,
    parameters: t.function?.parameters ??
      t.parameters ?? {
        type: "object",
        properties: {},
      },
  }));
};

export const getChatConfig = async (
  e: Events["message.create"] | Events["private.message.create"],
) => {
  /** 当前ai配置 */
  const config = await redisClient.getAIConfig(e.guid);
  /** 复杂输出开关 */
  const complexOutputIsOpen = await redisClient.getComplexOutput(e.guid);
  /** 好感度开关 */
  const affectionIsOpen = await redisClient.getAffectionSwitch(e.guid);
  /** TTS回复开关 */
  const isOpenTTSReply = await redisClient.getTTSResponseSwitch(e.guid);
  /** R18开关 */
  const isOpenR18 = await redisClient.getR18Switch(e.guid);
  /** 主动搭话开关 */
  const proactiveSwitch = await redisClient.getProactiveSwitch(e.guid);
  /** 深度思考开关 */
  const deepThoughtSwitch = await redisClient.getDeepThoughtSwitch(e.guid);
  /** @触发开关 */
  const atTriggerSwitch = await redisClient.getAtTriggerSwitch(e.guid);
  /** 历史消息 */
  const historyMessages = await redisClient.getAIChatHistory(e.guid);
  /** 好感度信息 */
  const affections = await redisClient.getAffectionLevelAll(e.guid);
  /** 工具相关配置 */
  const toolConfig = {
    /** 工具开关 */
    toolSwitch: await redisClient.getToolSwitch(e.guid),
    /** 工具列表 */
    cApiToolList: await redisClient.getAvailableTools(e.guid),
    rApiToolList: normalizeTools(
      await redisClient.getAvailableTools(e.guid),
      "rapi",
    ),
    /** 工具提示开关 */
    toolPromptSwitch: await redisClient.getToolPromptSwitch(e.guid),
    /** 工具提示撤回开关 */
    toolPromptRevokeSwitch: await redisClient.getToolPromptRevokeSwitch(e.guid),
    /** 工具提示传参开关 */
    toolPromptArgsSwitch: await redisClient.getToolPromptArgsSwitch(e.guid),
  };

  /** 技能列表 */
  const skills = loadSkills();
  /** 机器人昵称 */
  const botName = e.bot.nickname || "小咸鱼";
  /** 系统提示词 */
  const systemPrompt = `
  # AI助手回复规范
  请严格按照以下规范进行回复, 不要添加任何不必要的内容, 也不要删除或修改规范中的任何内容, 以确保回复能够被正确解析和处理
  
  ## 技能
  在遇到用户需要执行特定操作时,先获取对应的技能,如果有可用技能,获取该技能,并严格按照技能文档要求的格式调用, 不要添加任何多余的内容, 也不要删除或修改规范中的任何内容, 以确保技能能够被正确解析和处理
  当没有技能可以应对需求时, 就自行挑选合适的工具函数来完成用户的需求
  
  调用执行脚本类型的工具时, 务必确保脚本安全, 不得执行对服务器有伤害的脚本
  ---
  技能列表:
  ${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}
  ---
  
  ## 关于回复格式:
  ### 用户发言
  - 格式: [私聊]用户昵称(用户id)(发送时间):消息内容
  当场景为私聊时, 用户昵称前方会出现[私聊]标识
  当平台适配环境较好时,用户消息前面会包含消息id, 例如: [私聊]用户昵称(用户id)(发送时间)(msgid:消息id):消息内容
  你发送的消息内容会被框架自动加上消息id, 以便你在需要撤回消息时使用

  ### 你的回复格式
  ${botName}:消息内容
  #### 拒绝回复:
  在讨论中如果你觉得不适合回复或觉得与你无关又或者不感兴趣, 可以直接回复"[]"来拒绝本次回复, 例如:
  ${botName}:[]
  #### 图片
  ${botName}:<img=http://example.com/image.jpg>
  ${botName}:<img=./path/to/image.jpg>
  #### 艾特用户
  ${botName}:<at=用户id>消息内容
  #### 撤回消息
  ${botName}:<revoke=消息id>
  ${
    complexOutputIsOpen === "1" && isOpenTTSReply === "1"
      ? `#### 语音
  ${botName}:<tts=你好这是一个语音消息>
  #### 切换音色
  ${botName}:<音色=派蒙-默认><tts=这是派蒙的默认声音哦>`
      : "#### 语音回复: 当前不可用"
  }
  ${
    isOpenR18 === "1"
      ? ""
      : `
  #### R18内容:
  当用户发送的消息中包含敏感词时, 提醒用户注意言辞, 并且不回答用户的问题, 务必遵守国家法律法规
  `
  }
  
  ${
    affectionIsOpen === "1" && complexOutputIsOpen === "1"
      ? `#### 好感度系统:
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
  
  #### 基础状态信息:
  这里的信息会实时变化,根据需要进行获取使用
  当前群时间:${getGroupTimeString()}
  当前群号:${e.guid}
  当前群名称:${e.GroupName || "无"}
  当前聊天平台:${e.Platform}
  当前框架:alemonjs-aichat
  ${e.ClientError ? `当前错误信息:${e.ClientError}` : ""}
  `;

  const RapiSystemPrompt = `
请严格按照以下规范进行回复, 以确保回复能够被正确解析和处理
1. 文本消息：
${botName}::text<<<EOF
文本内容
EOF

2. 图片消息：
${botName}::image 图片URL

3. 语音消息：
${botName}::audio 内容

4. 指定音色语音：
${botName}::audio voice=音色 内容

=====================
【硬性规则】
=====================

- 不允许使用任何其他格式
- 不允许输出解释说明
- 不允许夹杂 markdown
- tool调用前可以先输出一行说明
- 每一条输出必须独立一行
- 允许多段输出叠加, 例如:
${botName}::text 这是第一条消息
${botName}::text 这是第二条消息
  `;

  return {
    /** AI配置 */
    config,
    /** 复杂输出开关 */
    complexOutputIsOpen,
    /** 好感度开关 */
    affectionIsOpen,
    /** TTS回复开关 */
    isOpenTTSReply,
    /** R18开关 */
    isOpenR18,
    /** 主动搭话开关 */
    proactiveSwitch,
    /** 深度思考开关 */
    deepThoughtSwitch,
    /** @ 触发开关 */
    atTriggerSwitch,
    /** 机器人昵称 */
    botName,
    /** 系统提示词 */
    systemPrompt,
    RapiSystemPrompt,
    /** 技能列表 */
    skills,
    /** 历史消息 */
    historyMessages,
    /** 好感度信息 */
    affections,
    /** 工具配置 */
    toolConfig,
  };
};

/**
 * 判断是否应该跳过AI回复
 * @param e 消息事件
 * @returns 是否跳过AI回复
 */
export const shouldSkipAIReply = async (
  e: Events["message.create"] | Events["private.message.create"],
  cfg?: Awaited<ReturnType<typeof getChatConfig>>,
) => {
  // 正则触发时直接必定回复，忽略后续所有判断
  if (e["regexTriggered"]) {
    console.log("正则规则匹配, 跳过 shouldSkipAIReply 检查, 必定回复");
    return false;
  }

  // 如果是命令则跳过
  if (
    e.msg.startsWith("/") ||
    e.msg.startsWith("#") ||
    e.UserId == e.bot.user_id
  ) {
    return true;
  }
  cfg ??= await getChatConfig(e);
  // 如果没有配置AI,则不处理
  if (
    cfg.config.host.trim() === "" ||
    cfg.config.key.trim() === "" ||
    cfg.config.model.trim() === ""
  ) {
    return true;
  }
  // 发消息的人是机器人自己, 则不处理
  if (e.UserId == e.bot.user_id) {
    return true;
  }

  // 当e.at不存在时,只给20%概率继续执行, 当e.at存在时,概率为40%,当e.atBot存在时,概率为100%
  const rand = Math.random();

  if (e.name !== "private.message.create") {
    if (cfg.proactiveSwitch !== "1" && e.at && !e.atBot) {
      console.log("未开启主动搭话, 跳过AI回复");

      return true;
    }
    if ((!e.at && rand > 0.1) || (e.at && !e.atBot && rand > 0.2)) {
      console.log("跳过AI回复");

      return true;
    }
  }

  return false;
};

type BuildMode = "capi" | "rapi";

/**
 * 打包消息内容（兼容 CAPI / RAPI）
 */
export const buildUserMessage = async (
  e: Events["message.create"] | Events["private.message.create"],
  cfg: any,
  mode: BuildMode = "capi",
) => {
  const imgs: string[] = [];
  let rawMessage = e.value.raw_message || e.raw_message || e.msg;

  // =========================
  // 回复处理
  // =========================
  if (cfg.complexOutputIsOpen === "1" && e.reply) {
    const replyImages = e.reply.message
      .filter((item) => item.type === "image")
      .map((item) => item.data.url);

    imgs.push(...replyImages);

    const replyContent = e.reply.message
      .filter((item) => item.type === "text")
      .map((item) => item.data.text)
      .join("");

    rawMessage = `[回复:${replyContent}]\n${rawMessage}`;
  }

  // =========================
  // 图片
  // =========================
  if (cfg.complexOutputIsOpen === "1" && e.img?.length) {
    imgs.push(...e.img);
  }

  // =========================
  // AT 处理
  // =========================
  if (e.at?.length) {
    for (const atItem of e.at) {
      const qq = atItem.data.qq;
      const nickname = atItem.data.nickname || "未知昵称";
      rawMessage = rawMessage.replace(`[CQ:at,qq=${qq}]`, `@${nickname}`);
    }
  }

  // =========================
  // 上传图片
  // =========================
  const imageurls = await Promise.all(imgs.map((url) => uploadImageToR2(url)));
  const validImageUrls = imageurls.filter(Boolean);

  // =========================
  // CQ 图片替换
  // =========================
  let index = 0;
  rawMessage = rawMessage.replace(/\[CQ:image,[^\]]+\]/g, () => {
    const url = validImageUrls[index++];
    return url ? url : "[图片]";
  });

  // =========================
  // 表情
  // =========================
  rawMessage = rawMessage.replace(
    /\[CQ:face,id=(\d+),[^\]]+\]/g,
    (_, id) => `[${emojiMap[id]}]`,
  );

  const text = `${e.nickname}(${getMessageTimeString()}): ${rawMessage}`;

  // =========================
  // 🔥 CAPI (chat.completions)
  // =========================
  if (mode === "capi") {
    return {
      role: "user",
      content: [
        ...validImageUrls.map((url) => ({
          type: "image_url",
          image_url: { url },
        })),
        {
          type: "text",
          text,
        },
      ],
      rawMessage,
      validImageUrls,
    };
  }

  // =========================
  // 🔥 RAPI (responses API)
  // =========================
  return {
    role: "user",
    content: [
      ...validImageUrls.map((url) => ({
        type: "input_image",
        image_url: url,
      })),
      {
        type: "input_text",
        text,
      },
    ],
  };
};

export const getDeepThoughtReasoning = (cfg: any) => {
  if (cfg.deepThoughtSwitch === "1") {
    // 开启深度思考, 深度 中等medium
    if (cfg.config.model.includes("deepseek")) {
      return {
        thinking: { type: "enabled" },
        reasoning_effort: "medium",
      };
    }
    if (cfg.config.model.includes("doubao")) {
      return {
        reasoning: {
          effort: "medium",
        },
      };
    }
    if (cfg.config.model.includes("qwen")) {
      return {
        enable_thinking: true,
      };
    }
  } else {
    // 关闭深度思考
    if (cfg.config.model.includes("deepseek")) {
      return {
        thinking: { type: "disabled" },
      };
    }
    if (cfg.config.model.includes("doubao")) {
      return {
        reasoning: {
          effort: "minimal",
        },
      };
    }
    if (cfg.config.model.includes("qwen")) {
      return {
        enable_thinking: false,
      };
    }
  }
};
