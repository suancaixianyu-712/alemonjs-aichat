import { getTimeString } from "@src/api/format";
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
  格式:
  ${botName}:消息内容
  
  #### 消息叠加:
  你可以使用多个叠加, 来模拟发送多条消息, 让聊天显得更真实, 例如:
  ${botName}:早上好
  ${botName}:吃过早饭了吗

  #### 执行框架指令:
  你可以在回复中添加<command=指令内容>来执行框架指令, 每次只能执行一个指令, 例如:
  用户:帮助
  ${botName}:<command=#ai帮助> 正在获取帮助指令, 请稍等
  用户:看看配置
  ${botName}:<command=#ai配置> 正在获取配置, 请稍等

  #### 撤回消息:
  你可以使用<revoke=消息id>来撤回消息, 例如:
  [私聊]酸菜味小咸鱼(3501869534)(10:00)(msgid:ans65c2):帮我撤回这条消息
  ${botName}:<revoke=ans65c2> 已经帮你撤回了哦

  ### 艾特:
  当你需要艾特用户时, 可以使用<at=用户id>的方式来艾特, 例如:
  ${botName}:<at=3501869534> 你来啦~

  ${
    toolConfig.toolPromptSwitch === "1"
      ? `
  #### 获取用户信息
  在聊天开始时, 你可以通过MemoryOperation工具获取用户的基本信息, 包括用户的兴趣爱好, 重要事件等, 以便更好地了解用户并提供个性化的回复.
  在聊天过程中, 你也可以随时通过MemoryOperation工具修改对这个人的印象, 例如当用户说了一些让你不开心的话时, 你可以调用这个工具来记录用户的行为, 以便在后续的对话中调整你的回复策略
  `
      : ""
  }

  ${
    complexOutputIsOpen === "1"
      ? `
  #### 发送图片:
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
      ? `\n#### 语音回复:
  此能力只能在onebot平台使用, 其他平台请勿使用, 否则会回复失败
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

  #### 拒绝回复:
  在讨论中如果你觉得不适合回复或觉得与你无关又或者不感兴趣, 可以直接回复"[]"来拒绝本次回复, 例如:
  ${botName}:[]
  
  #### 基础状态信息:
  这里的信息会实时变化,根据需要进行获取使用
  当前群时间:${getTimeString()}
  当前群号:${e.guid}
  当前群名称:${e.GroupName || "无"}
  当前聊天平台:${e.Platform}
  当前框架:alemonjs
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
) => {
  const cfg = await getChatConfig(e);
  // 如果是命令则跳过
  if (
    e.msg.startsWith("/") ||
    e.msg.startsWith("#") ||
    e.UserId == e.bot.user_id
  ) {
    return true;
  }
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

  const text = `${e.nickname}(${getTimeString()}): ${rawMessage}`;

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
