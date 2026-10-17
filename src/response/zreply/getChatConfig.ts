import { getMessageTimeString } from "@src/api/format";
import { loadSkills } from "@src/api/loadSkill";
import { buildUserPermissionPrompt } from "@src/api/user-permission";
import { toolSessionController } from "@src/api/tool-session-controller";
import redisClient from "@src/config";
import { Events } from "alemonjs";
import { emojiMap } from "@src/emoji";
import { uploadImageToR2 } from "@src/s3";
import { shouldDisableLocalSearchTool } from "./provider-tools";
import {
  getDeepThoughtReasoning,
} from "@src/api/deep-thought";
export { getDeepThoughtReasoning } from "@src/api/deep-thought";

/**
 * 明确不支持看图（无 vision / 多模态输入）的模型关键词
 * 匹配规则：model 名小写后 includes 任一关键词
 * 注意：若同时命中 VISION_MODEL_KEYWORDS，则视为可看图（如 deepseek-vl、qwen-vl）
 */
export const NON_VISION_MODEL_KEYWORDS: string[] = [
  "deepseek-v4-pro",
  // OpenAI 纯文本 / 无图推理
  "gpt-3.5",
  "gpt-35",
  "gpt-4-32k",
  "o1-mini",
  "o1-preview",
  "o3-mini",
  "o4-mini",
  // 开源/常见纯文本
  "llama-3",
  "llama3",
  "llama-2",
  "llama2",
  "mistral-large",
  "mistral-medium",
  "mistral-small",
  "mistral-nemo",
  "mixtral",
  "codestral",
  "command-r",
  "command-light",
  "gemma",
  "phi-3",
  "phi-4",
  "phi3",
  "phi4",
];

/**
 * 名称中出现这些关键词时，视为支持看图，优先生效
 * （避免 deepseek-vl、qwen2.5-vl、glm-4v 等被 NON_VISION 误伤）
 */
export const VISION_MODEL_KEYWORDS: string[] = ["-vl", "vl-", "vl.", "vision"];

const normalizeModelId = (model?: string) =>
  String(model || "")
    .toLowerCase()
    .trim();

/**
 * 是否为明确无法直接看图的模型
 * - 先排除明显 vision 型号
 * - 再匹配 NON_VISION_MODEL_KEYWORDS
 */
export const isNonVisionModel = (model?: string) => {
  const normalized = normalizeModelId(model);
  if (!normalized) {
    return false;
  }

  if (VISION_MODEL_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return false;
  }

  return NON_VISION_MODEL_KEYWORDS.some((keyword) =>
    normalized.includes(keyword),
  );
};

/** @deprecated 请使用 isNonVisionModel；保留别名避免外部引用报错 */
export const isDeepSeekModel = isNonVisionModel;

const extractImageUrlFromPart = (part: any): string => {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (typeof part.image_url === "string") {
    return part.image_url.trim();
  }
  if (part.image_url && typeof part.image_url.url === "string") {
    return part.image_url.url.trim();
  }
  return "";
};

const extractTextFromPart = (part: any): string => {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (typeof part.content === "string") {
    return part.content;
  }
  return "";
};

/** 将未出现在正文中的图片 URL 追加为文本链接 */
const appendImageLinksToText = (text: string, urls: string[]) => {
  const base = String(text || "");
  const missing = (urls || []).filter(
    (url) => typeof url === "string" && url.trim() && !base.includes(url),
  );
  if (!missing.length) {
    return base;
  }
  const linkBlock = missing
    .map((url, index) => `[图片链接${index + 1}] ${url}`)
    .join("\n");
  return base ? `${base}\n${linkBlock}` : linkBlock;
};

/**
 * 校正 DescribeImage 的图片参数。
 * 当前消息带图时，优先使用本轮真实 URL，避免模型从历史消息里重复拷贝旧链接。
 */
export const bindDescribeImageUrl = (
  args: any,
  currentImageUrls: string[],
  usedImageUrls: Set<string>,
) => {
  if (!args || typeof args !== "object") {
    return args;
  }

  const urls = [...new Set((currentImageUrls || []).filter(Boolean))];
  if (!urls.length) {
    return args;
  }

  const requestedUrl = String(args.image_url || "").trim();
  const requestedIsCurrent = urls.includes(requestedUrl);
  const selectedUrl =
    requestedIsCurrent && !usedImageUrls.has(requestedUrl)
      ? requestedUrl
      : urls.find((url) => !usedImageUrls.has(url)) ||
        (requestedIsCurrent ? requestedUrl : urls[0]);

  args.image_url = selectedUrl;
  usedImageUrls.add(selectedUrl);
  return args;
};

/**
 * 将多模态 content 中的图片压成文本链接
 * （无法看图的模型不支持 image_url / input_image）
 */
const flattenMultimodalContentToText = (content: any): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return extractTextFromPart(content);
  }

  const textParts: string[] = [];
  const imageUrls: string[] = [];

  for (const part of content) {
    const imageUrl = extractImageUrlFromPart(part);
    if (imageUrl) {
      imageUrls.push(imageUrl);
      continue;
    }
    const type = String(part?.type || "");
    if (type === "image_url" || type === "input_image") {
      continue;
    }
    if (
      type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      !type
    ) {
      const text = extractTextFromPart(part);
      if (text) {
        textParts.push(text);
      }
    }
  }

  return appendImageLinksToText(textParts.join("\n"), imageUrls);
};

/**
 * 无法看图的模型：请求前适配历史消息，去掉 image_url，只保留图片链接文本
 * 不写回 Redis，仅影响本轮请求
 */
export const adaptHistoryMessagesForModel = (
  historyMessages: any[],
  model?: string,
) => {
  if (!Array.isArray(historyMessages) || !isNonVisionModel(model)) {
    return historyMessages;
  }

  return historyMessages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    if (!Array.isArray(message.content)) {
      const { validImageUrls: _v, rawMessage: _r, ...rest } = message;
      return rest;
    }

    const hasImagePart = message.content.some(
      (part: any) =>
        part?.type === "image_url" ||
        part?.type === "input_image" ||
        Boolean(extractImageUrlFromPart(part)),
    );
    if (!hasImagePart) {
      const { validImageUrls: _v, rawMessage: _r, ...rest } = message;
      return rest;
    }

    const { validImageUrls: _v, rawMessage: _r, ...rest } = message;
    return {
      ...rest,
      content: flattenMultimodalContentToText(message.content),
    };
  });
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
  /** R18开关 */
  const isOpenR18 = await redisClient.getR18Switch(e.guid);
  /** 主动搭话开关 */
  const proactiveSwitch = await redisClient.getProactiveSwitch(e.guid);
  /** 深度思考档位（并派生旧 switch） */
  const deepThoughtEffort = await redisClient.getDeepThoughtEffort(e.guid);
  const deepThoughtSwitch = deepThoughtEffort === "none" ? "0" : "1";
  /** @触发开关 */
  const atTriggerSwitch = await redisClient.getAtTriggerSwitch(e.guid);
  /** 历史消息（无法看图时把多模态图片压成链接文本，避免 vision 400） */
  const historyMessages = adaptHistoryMessagesForModel(
    await redisClient.getAIChatHistory(e.guid),
    config.model,
  );
  /** CAPI 自动压缩上下文长度 */
  const capiContextLimit = await redisClient.getCAPIContextLimit(e.guid);
  const textOnlyVision = isNonVisionModel(config.model);
  /** 好感度信息 */
  const affections = await redisClient.getAffectionLevelAll(e.guid);
  /** 工具相关配置 */
  const availableTools = await redisClient.getAvailableTools(e.guid);
  const useProviderWebSearch = shouldDisableLocalSearchTool(config);
  const toolConfig = {
    /** 工具开关 */
    toolSwitch: await redisClient.getToolSwitch(e.guid),
    /** 工具列表 */
    cApiToolList: availableTools.filter(
      (tool) =>
        (textOnlyVision || tool.function?.name !== "DescribeImage") &&
        (!useProviderWebSearch || tool.function?.name !== "LocalBrowser"),
    ),
    /** 全部工具定义（search_tools 搜索范围） */
    allToolList: await redisClient.getAllToolDefinitions(),
    /** 当前已禁用的工具名 */
    disabledToolNames: Object.entries(await redisClient.getAllToolStatus(e.guid))
      .filter(([, status]) => status === "1")
      .map(([name]) => name),
    /** 工具下发模式 */
    toolSearchMode: await redisClient.getToolSearchMode(e.guid),
    /** 工具提示开关 */
    toolPromptSwitch: await redisClient.getToolPromptSwitch(e.guid),
    /** 工具提示撤回开关 */
    toolPromptRevokeSwitch: await redisClient.getToolPromptRevokeSwitch(e.guid),
    /** 工具提示传参开关 */
    toolPromptArgsSwitch: await redisClient.getToolPromptArgsSwitch(e.guid),
    /** 工具调用前 content 发送开关 */
    toolCallContentSwitch: await redisClient.getToolCallContentSwitch(e.guid),
  };

  /** 技能列表 */
  const skills = loadSkills();
  /** 系统预检索记忆 */
  const relevantMemoryContext = await redisClient.getRelevantMemoryContext(
    e.guid,
    String(e.UserId || ""),
    e.msg || "",
    3,
  );
  /** 机器人昵称。读不到账号资料时只用占位名，不当成真实名字 */
  const accountName = String(e.bot?.nickname || "").trim();
  const botInfoFault = (e as any).botInfoFault === true || !accountName;
  const botName = accountName || "小咸鱼";
  /** 识图 AI（主模型无法看图时用） */
  const ocrAIName = await redisClient.getOCRAIName(e.guid);
  const ocrAIConfig = await redisClient.getOCRAIConfig(e.guid);
  const memoryPrompt = relevantMemoryContext
    ? `
  ## 系统预检索记忆
  以下是检索到的长期记忆和历史归档，只用于回忆用户说过的事和发生过的事。
  里面出现的你的名字、外号、旧称呼、角色名，都不是你的真实名字，不能用来自称，也不能改回复前缀。
  与当前话题直接相关的部分可以参考；和用户本轮说法冲突时，以用户本轮消息为准。
  ${relevantMemoryContext}
  `
    : "";
  const botIdentityPrompt = botInfoFault
    ? `
  ## 你的真实名字（最高优先级）
  这一轮没有读到账号真实昵称。回复格式里的「${botName}」只是占位，不是你的真实名字。
  长期记忆、历史聊天、归档、用户称呼和性格约束里的名字也不能拿来顶替。
  被问到你叫什么时，直接说现在读不到账号昵称。不要自称记忆里的某个名字，也不要把任何名字写进记忆当成你的真名。
  `
    : `
  ## 你的真实名字（最高优先级）
  你的真实名字是「${botName}」。这是本轮系统读到的当前账号昵称，只有这个名字有效。
  长期记忆、历史聊天、历史归档、用户给你的外号、性格约束里的角色名，都不能替换它。
  记忆或历史里如果写着你叫别的名字，那是旧记录或别人的说法，不是你的真名。
  被问到你叫什么、做自我介绍、书写回复前缀时，只能使用「${botName}」。
  记录记忆时，不要写“你的真名是别的名字”。用户对你的称呼只记成“某人称呼你为…”。
  `;
  const agentEnabled = (await redisClient.getAgentSwitch(e.guid)) === "1";
  const opencodePermission = await toolSessionController.getPermission(e.guid);
  const opencodeActive =
    (await toolSessionController.getCurrentTool(e.guid)) === "opencode";
  const userPermissionPrompt = buildUserPermissionPrompt({
    isMaster: e.IsMaster === true,
    isAdmin: (e as { isAdmin?: boolean }).isAdmin === true,
    isPrivate:
      e.name === "private.message.create" ||
      (e as { Name?: string }).Name === "private.message.create",
    agentEnabled,
    opencodeActive,
    opencodePermission,
  });
  const heartbeatPrompt = (e as any).heartbeat
    ? `
  ## AI 心跳
  这是一次定时心跳，不是用户刚刚发来的普通消息。你可以自主检查当前会话和用户的长期状态，选择发送一条主动消息、调用合适的工具完成有价值的事情，或在确实没有必要行动时只输出 NO_ACTION。不要为了完成心跳而强行打扰用户。需要主动发送时，直接按正常回复格式输出内容，系统会主动投递给当前用户或群聊。需要执行耗时或要多步工具调用的任务时，优先用 SubAgent 派后台子agent执行，派遣后即可结束本轮，报告会写回对话供下次处理。
  `
    : "";
  let followupPrompt = "";
  if ((e as any).followupJudgement) {
    const records = await redisClient.getFollowupMessages(e.guid, e.Platform);
    const lines =
      records.length > 0
        ? records
            .map((item) => {
              const time = new Date(item.at);
              const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(time.getSeconds()).padStart(2, "0")}`;
              return `- [${clock}] ${item.name}(${item.userID}): ${item.text}`;
            })
            .join("\n")
        : "- （这一分钟内没有记下消息）";
    followupPrompt = `
  ## 一分钟跟进判断
  你刚才已经回复过当前用户，或该用户在这一分钟内被记入监听。系统记下了这一分钟内群里的全部消息，这一轮只判断要不要回复当前这个人。
  结合下面的记录和当前用户最新发言：
  - 对方在问你、艾特你、接你刚才的话，或明确需要你参与时，按正常格式回复
  - 对方在跟别人说话、内容与你无关、只是附和或不需要接话时，只输出一行：${botName}:[]
  不要因为这一轮被触发就一定回复。其他人的发言只作为上下文，不要逐个回复。
  这一分钟内的群消息：
  ${lines}
  `;
  }
  const nonVisionImagePrompt = textOnlyVision
    ? `
  ## 图片理解
  - 用户消息里的图片只会以文本链接出现，例如 https://... 或 [图片链接N] https://...
  - 你不能假装已经看到图片。凡是需要理解图片内容、读图中文字、或回答与图片相关的问题，可调用工具 DescribeImage
  - 调用时：image_url=消息中的完整图片URL；guid=下方「当前群号(reviewGuid)」；question=可选的关注点
  - 拿到工具返回的 description 后，再基于描述回答用户
  ${
    ocrAIConfig
      ? `- 已配置识图 AI：${ocrAIConfig.name}（模型 ${ocrAIConfig.model}）`
      : ocrAIName
        ? `- 识图 AI 名称「${ocrAIName}」已记录，但配置无效或不完整，请用户重新 /设置识图ai <AI列表名称>`
        : `- 尚未配置识图 AI。若工具返回未配置，请提示用户发送：/设置识图ai <AI列表名称>（需支持多模态/vision 的模型）`
  }
  `
    : "";
  /** 系统提示词 */
  const systemPrompt = `
  # AI助手回复规范
  请严格按照以下规范进行回复, 不要添加任何不必要的内容, 也不要删除或修改规范中的任何内容, 以确保回复能够被正确解析和处理
  
  ## 工具使用总则
  - 用户需要特定操作时，优先选用合适的工具函数来完成需求
  ${
    useProviderWebSearch
      ? "- 当前已启用厂商内置网页搜索，应直接使用内置搜索；为避免重复，本轮不提供 LocalBrowser"
      : "- 搜索网页/访问网址用 LocalBrowser（search/visit）；仅能访问公网 HTTP/HTTPS 页面"
  }
  ${heartbeatPrompt}
  ${followupPrompt}
  - 读取会话现有项目：Agentxxxxx...（只读操作无需开启agent）；创建/修改/执行等写操作需主人先 #开启agent，或当前群已开启完全访问；删除权限只看下方「当前用户权限」
  - 下方「当前用户权限」是本轮实际权限。没有列出的能力不要调用；审核或权限被拒绝后，不要改命令、换工具或拆步骤再试
  - 公共知识库位于 public/knowledge/，可跨会话只读访问；能不能修改只看「当前用户权限」
  - 仅当当前用户权限写明可以访问 root 时，才用 Agent* 的 scope=root。仅当写明可以执行服务器命令时，才用 RunServerCommand，并把 workingDirectory 设为目标目录
  - 用户提到本地仓库/知识库/参考项目时，先检查 public/{guid} 现有内容（优先 knowledge/），至少搜索/列目录一次后再下结论；不确定 guid 时先 AgentListWorkspaces
  - 仅当当前用户权限写明可以执行服务器命令时才用 RunServerCommand。reviewGuid 由系统绑定；服务器凭据/密钥属机密，禁止转述或写入未授权位置
  - 查看/切换分支用 AgentGitOperation。完整 Git 只在当前用户权限写明可以时，才用 AgentProjectCommand，每次一条命令
  ${userPermissionPrompt}
  ## AlemonJS 框架指令（高优先级）
  用户要求查看/修改配置、切换模型、开关功能等需要帮忙时，必须调用 ExecuteAlemonCommand 工具来操作
  ## 后台子agent（高优先级）
  凡是"干活"类的任务——需要检索/读写文件、执行命令、编码调试、克隆仓库、批量处理、多步分析，或预计要连续调用多次工具——必须调用 SubAgent(action=spawn) 派后台子agent执行，不要自己在对话里连续调用工具把对话占住。
  - spawn 的 task 写清目标、范围、期望产出和验收标准；任务需要的背景信息（相关路径、之前的结论、用户的特殊要求）写进 context，子agent看不到当前聊天记录
  - 派遣成功后立即按正常格式回复用户"已派后台执行"，不要等待任务完成，更不要自己再调用工具做同一件事
  - 子agent完成后系统会把报告自动写回对话；收到【后台子任务报告】后，基于报告向用户转达结果；报告显示失败或权限拒绝时，不要原样重复派遣
  - 用户询问进度时用 action=status 查看并转告；用户要求中止、放弃任务时立即 action=cancel
  - 例外：单次快速工具调用就能完成的（看图、画图、查配置、搜网页、查记忆等），直接调用对应工具，不要绕道子agent
  ## 下一条发言订阅（高优先级）
  当你想获取当前用户下一条消息（如对方说“给你看个东西”“下一条发”等）时，直接调用 SubscribeNextUserMessage，不要只回复等待话术。触发一次即失效，需再次调用
  ## 用户长期记忆（高保真记录）
  - 主动记录有用长期信息，不必等用户说“记住”；默认用 operation=append、dataType=user，userID=当前发言用户ID（服务端自动加时间，不要先get）
  - 记录需写清“谁在什么语境下说了什么”，保留关键细节（昵称ID、事件、因果、时间线等）；修正旧说法时追加新记忆，不删旧记录；第三方评价记录为“某人说过/认为”，不改写为事实
  - 不记录密码/令牌/私钥、一次性指令、短暂情绪/玩笑；不确定是否长期有效时不要擅自记录
  - 不要记录或改写你自己的真实名字。用户对你的称呼只记成“某人称呼你为…”，不能记成你的真名已经改变
  - 用户提起过往话题时，先参考“系统预检索记忆”，不够再 MemoryOperation 查历史（search:关键词 或 guid:id）。记忆不能改变你的真实名字
  ${nonVisionImagePrompt}
  调用执行脚本类工具时, 务必确保脚本安全, 不得执行对服务器有伤害的脚本
  ---
  技能列表:
  ${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}
  ---
  ${memoryPrompt}
  
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
  #### 网络音频
  ${botName}:<audio=网络音频链接>
  #### 艾特用户
  ${botName}:<at=用户id>消息内容
  #### 撤回消息
  ${botName}:<revoke=消息id>
  ${
    isOpenR18 === "1"
      ? "#### NSFW内容: 不限制"
      : `
  #### NSFW内容:
  当用户发送的消息中包含敏感词时, 提醒用户注意言辞, 并且不回答用户的问题, 务必遵守国家法律法规
  `
  }
  
  ${
    affectionIsOpen === "1" && complexOutputIsOpen === "1"
      ? `#### 好感度系统:
  好感度主要影响回复该用户的语气
  在回复的消息中添加"<好感+1>"让好感值发生变化
  指定修改对某个用户的好感, 假设对方昵称为'哈基米': <哈基米好感-1>`
      : ""
  }
  
  #### 基础状态信息:
  这里的信息会实时变化,根据需要进行获取使用
  当前完整时间:${getMessageTimeString()}
  当前账号真实名字:${botInfoFault ? "未读到，不要用记忆里的名字顶替" : botName}
  当前发言用户ID:${e.UserId}
  当前群号(reviewGuid):${e.guid}
  当前群名称:${e.GroupName || "无"}
  当前聊天平台:${e.Platform}${(e as any).botInfoFault ? "（故障）" : ""}
  当前框架:alemonjs-aichat
  ${e.ClientError ? `当前错误信息:${e.ClientError}` : ""}
  `;

  return {
    /** AI配置 */
    config,
    /** 复杂输出开关 */
    complexOutputIsOpen,
    /** 好感度开关 */
    affectionIsOpen,
    /** R18开关 */
    isOpenR18,
    /** 主动搭话开关 */
    proactiveSwitch,
    /** 深度思考档位 */
    deepThoughtEffort,
    /** 深度思考开关（由 effort 派生） */
    deepThoughtSwitch,
    /** @ 触发开关 */
    atTriggerSwitch,
    /** 机器人昵称 */
    botName,
    /** 系统提示词 */
    systemPrompt,
    /** 当前用户权限。拼在性格约束之后，避免人设把权限说明盖掉 */
    userPermissionPrompt,
    /** 真实名字。拼在性格约束和记忆之后，避免旧记忆改掉账号昵称 */
    botIdentityPrompt,
    /** 技能列表 */
    skills,
    /** 历史消息 */
    historyMessages,
    /** CAPI 自动压缩上下文长度 */
    capiContextLimit,
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

  // AI 主动订阅的下一条消息必定回复，包含“仅艾特触发”模式
  if (e["nextUserMessageSubscriptionTriggered"]) {
    console.log("下一条用户消息订阅已触发, 必定回复");
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

  // 一分钟内被监听的用户再次发言：一定调用模型，由模型决定回不回
  if (e["followupJudgement"]) {
    console.log("一分钟跟进判断, 交给 AI 决定是否回复");
    return false;
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

/**
 * 打包 Chat Completions API 的用户消息内容
 */
export const buildUserMessage = async (
  e: Events["message.create"] | Events["private.message.create"],
  cfg: any,
) => {
  const imgs: string[] = [];
  let rawMessage = e.value.raw_message || e.raw_message || e.msg;
  const textOnlyImages = isNonVisionModel(cfg?.config?.model);

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
  const validImageUrls = imageurls.filter(Boolean) as string[];

  // =========================
  // CQ 图片替换
  // =========================
  let index = 0;
  rawMessage = rawMessage.replace(/\[CQ:image,[^\]]+\]/g, () => {
    const url = validImageUrls[index++];
    return url ? url : "[图片]";
  });

  // 无法看图的模型：正文补全未写入文本的图片链接（e.img / 回复图等）
  if (textOnlyImages) {
    rawMessage = appendImageLinksToText(rawMessage, validImageUrls);
  }

  // =========================
  // 表情
  // =========================
  rawMessage = rawMessage.replace(
    /\[CQ:face,id=(\d+),[^\]]+\]/g,
    (_, id) => `[${emojiMap[id]}]`,
  );

  const text = `${e.nickname}(${getMessageTimeString()}): ${rawMessage}`;

  // 无法看图：不传 image_url，只保留文本中的图片链接
  if (textOnlyImages) {
    return {
      role: "user",
      content: text,
      rawMessage,
      validImageUrls,
    };
  }

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
};

