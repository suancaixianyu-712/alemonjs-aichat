import { getGroupTimeString, getMessageTimeString } from '../../api/format.js';
import { loadSkills } from '../../api/loadSkill.js';
import redisClient from '../../config.js';
import { emojiMap } from '../../emoji.js';
import { uploadImageToR2 } from '../../s3.js';

/**
 * 将 tools 在 CAPI / RAPI 之间转换
 */
const normalizeTools = (tools, mode) => {
    if (!Array.isArray(tools))
        return [];
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
/**
 * 明确不支持看图（无 vision / 多模态输入）的模型关键词
 * 匹配规则：model 名小写后 includes 任一关键词
 * 注意：若同时命中 VISION_MODEL_KEYWORDS，则视为可看图（如 deepseek-vl、qwen-vl）
 */
const NON_VISION_MODEL_KEYWORDS = [
    // DeepSeek 文本/推理/代码（不含 vl）
    "deepseek",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-r1",
    "deepseek-v3",
    "deepseek-v2",
    "deepseek-coder",
    // OpenAI 纯文本 / 无图推理
    "gpt-3.5",
    "gpt-35",
    "gpt-4-32k",
    "o1-mini",
    "o1-preview",
    "o3-mini",
    "o4-mini",
    // 通义千问文本（vl 由 VISION 列表排除）
    "qwen-turbo",
    "qwen-plus",
    "qwen-max",
    "qwen-long",
    "qwen2.5",
    "qwen2-",
    "qwen-coder",
    "qwq",
    // 月之暗面 Kimi / Moonshot 文本
    "moonshot",
    "kimi",
    "moonshot-v1",
    // 智谱 GLM 文本（glm-4v 可看图）
    "glm-4-flash",
    "glm-4-air",
    "glm-4-plus",
    "glm-4-long",
    "glm-4-0520",
    "glm-4",
    "chatglm",
    // 文心一言文本
    "ernie-3.5",
    "ernie-4.0",
    "ernie-speed",
    "ernie-lite",
    "ernie-tiny",
    "ernie-character",
    "ernie-novel",
    // 豆包文本（vision 型号会走 VISION 覆盖）
    "doubao",
    "doubao-pro",
    "doubao-lite",
    "doubao-1.5",
    // 百川 / 零一 / MiniMax
    "baichuan",
    "yi-large",
    "yi-medium",
    "yi-spark",
    "yi-lightning",
    "minimax",
    "abab6",
    "abab5",
    // 讯飞星火 / 腾讯混元 文本向
    "spark",
    "generalv3",
    "generalv3.5",
    "hunyuan",
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
const VISION_MODEL_KEYWORDS = [
    "-vl",
    "vl-",
    "vl.",
    "vision",
    "omni",
    "gpt-4o",
    "gpt-4.1",
    "gpt-4-turbo",
    "gpt-4-vision",
    "chatgpt-4o",
    "claude-3",
    "claude-4",
    "claude-sonnet",
    "claude-opus",
    "claude-haiku",
    "gemini",
    "qwen-vl",
    "qwen2-vl",
    "qwen2.5-vl",
    "qwen3-vl",
    "glm-4v",
    "glm-4.1v",
    "glm-4.5v",
    "cogvlm",
    "internvl",
    "llava",
    "pixtral",
    "kimi-vl",
    "step-1v",
    "yi-vision",
    "doubao-vision",
    "doubao-1.5-vision",
    "sensechat-vision",
    "ernie-vilg",
    "ernie-4.0-8k-preview-vl",
];
const normalizeModelId = (model) => String(model || "")
    .toLowerCase()
    .trim();
/**
 * 是否为明确无法直接看图的模型
 * - 先排除明显 vision 型号
 * - 再匹配 NON_VISION_MODEL_KEYWORDS
 */
const isNonVisionModel = (model) => {
    const normalized = normalizeModelId(model);
    if (!normalized) {
        return false;
    }
    if (VISION_MODEL_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
        return false;
    }
    return NON_VISION_MODEL_KEYWORDS.some((keyword) => normalized.includes(keyword));
};
/** @deprecated 请使用 isNonVisionModel；保留别名避免外部引用报错 */
const isDeepSeekModel = isNonVisionModel;
const extractImageUrlFromPart = (part) => {
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
const extractTextFromPart = (part) => {
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
const appendImageLinksToText = (text, urls) => {
    const base = String(text || "");
    const missing = (urls || []).filter((url) => typeof url === "string" && url.trim() && !base.includes(url));
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
const bindDescribeImageUrl = (args, currentImageUrls, usedImageUrls) => {
    if (!args || typeof args !== "object") {
        return args;
    }
    const urls = [...new Set((currentImageUrls || []).filter(Boolean))];
    if (!urls.length) {
        return args;
    }
    const requestedUrl = String(args.image_url || "").trim();
    const requestedIsCurrent = urls.includes(requestedUrl);
    const selectedUrl = requestedIsCurrent && !usedImageUrls.has(requestedUrl)
        ? requestedUrl
        : urls.find((url) => !usedImageUrls.has(url)) ||
            (requestedIsCurrent ? requestedUrl : urls[0]);
    args.image_url = selectedUrl;
    usedImageUrls.add(selectedUrl);
    return args;
};
/** 给 RAPI 本地执行链保留图片 URL，但不将内部字段序列化给模型 API */
const attachImageUrls = (message, urls) => {
    Object.defineProperty(message, "validImageUrls", {
        value: urls,
        enumerable: false,
    });
    return message;
};
/**
 * 将多模态 content 中的图片压成文本链接
 * （无法看图的模型不支持 image_url / input_image）
 */
const flattenMultimodalContentToText = (content) => {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return extractTextFromPart(content);
    }
    const textParts = [];
    const imageUrls = [];
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
        if (type === "text" ||
            type === "input_text" ||
            type === "output_text" ||
            !type) {
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
const adaptHistoryMessagesForModel = (historyMessages, model) => {
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
        const hasImagePart = message.content.some((part) => part?.type === "image_url" ||
            part?.type === "input_image" ||
            Boolean(extractImageUrlFromPart(part)));
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
const getChatConfig = async (e) => {
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
    /** 历史消息（无法看图时把多模态图片压成链接文本，避免 vision 400） */
    const historyMessages = adaptHistoryMessagesForModel(await redisClient.getAIChatHistory(e.guid), config.model);
    /** CAPI 自动压缩上下文长度 */
    const capiContextLimit = await redisClient.getCAPIContextLimit(e.guid);
    /** 好感度信息 */
    const affections = await redisClient.getAffectionLevelAll(e.guid);
    /** 工具相关配置 */
    const toolConfig = {
        /** 工具开关 */
        toolSwitch: await redisClient.getToolSwitch(e.guid),
        /** 工具列表 */
        cApiToolList: await redisClient.getAvailableTools(e.guid),
        rApiToolList: normalizeTools(await redisClient.getAvailableTools(e.guid), "rapi"),
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
    const relevantMemoryContext = await redisClient.getRelevantMemoryContext(e.guid, String(e.UserId || ""), e.msg || "", 3);
    /** 机器人昵称 */
    const botName = e.bot.nickname || "小咸鱼";
    /** 识图 AI（主模型无法看图时用） */
    const ocrAIName = await redisClient.getOCRAIName(e.guid);
    const ocrAIConfig = await redisClient.getOCRAIConfig(e.guid);
    const textOnlyVision = isNonVisionModel(config.model);
    const memoryPrompt = relevantMemoryContext
        ? `
  ## 系统预检索记忆
  以下内容是系统根据当前话题自动检索到的相关长期记忆和历史归档, 回答时优先参考与当前话题直接相关的部分; 如果与用户本轮最新表述冲突, 以用户本轮消息为准
  ${relevantMemoryContext}
  `
        : "";
    const nonVisionImagePrompt = textOnlyVision
        ? `
  ## 图片理解（当前主模型 ${config.model} 无法直接看图）
  - 用户消息里的图片只会以文本链接出现，例如 https://... 或 [图片链接N] https://...
  - 你不能假装已经看到图片。凡是需要理解图片内容、读图中文字、或回答与图片相关的问题，必须先调用工具 DescribeImage
  - 调用时：image_url=消息中的完整图片URL；guid=下方「当前群号(reviewGuid)」；question=可选的关注点
  - 拿到工具返回的 description 后，再基于描述回答用户
  ${ocrAIConfig
            ? `- 已配置识图 AI：${ocrAIConfig.name}（模型 ${ocrAIConfig.model}）`
            : ocrAIName
                ? `- 识图 AI 名称「${ocrAIName}」已记录，但配置无效或不完整，请用户重新 /设置识图ai <AI列表名称>`
                : `- 尚未配置识图 AI。若工具返回未配置，请提示用户发送：/设置识图ai <AI列表名称>（需支持多模态/vision 的模型）`}
  `
        : ocrAIConfig
            ? `
  ## 图片理解
  需要更仔细地描述图片、OCR 读字时，可调用 DescribeImage（guid 传当前群号）。当前识图 AI：${ocrAIConfig.name}（${ocrAIConfig.model}）
  `
            : "";
    /** 系统提示词 */
    const systemPrompt = `
  # AI助手回复规范
  请严格按照以下规范进行回复, 不要添加任何不必要的内容, 也不要删除或修改规范中的任何内容, 以确保回复能够被正确解析和处理
  
  ## 技能
  在遇到用户需要执行特定操作时,先获取对应的技能,如果有可用技能,获取该技能,并严格按照技能文档要求的格式调用, 不要添加任何多余的内容, 也不要删除或修改规范中的任何内容, 以确保技能能够被正确解析和处理
  当没有技能可以应对需求时, 就自行挑选合适的工具函数来完成用户的需求
  如果用户提到本地仓库、知识库、参考项目、之前克隆过的项目，或者你准备说"本地没有"、"仓库里没有"、"没找到"之类的话，必须先检查 public/{guid} 内现有内容，优先搜索 knowledge/ 目录；至少先调用一次 AgentSearchFiles、AgentListFiles 或读取相关技能后再下结论
  如果你不知道之前项目所在的 guid，先调用 AgentListWorkspaces 找到 public/ 下已有工作目录，再继续用 AgentListFiles、AgentSearchFiles 或 AgentReadFileLines；不要用 exec 查 public/{guid}，因为 exec 的默认工作目录不是那里
  如果用户需要直接执行服务器运维指令、查看服务状态、管理 Docker/PM2/systemctl、查看日志或部署服务，使用 RunServerCommand；它会自动审核指令安全，不要改用 exec。调用 RunServerCommand 时 reviewGuid 必填，必须传下方环境信息里的“当前群号(reviewGuid)”，不要传 public/{guid} 工作目录ID
  如果用户要查看分支、确认当前分支、查看远端或切换分支，优先使用 AgentGitOperation，不要自己拼 git commit、push、pull、merge、rebase、reset 等命令
  如果用户在继续之前的话题、问你记不记得、提到上次/刚才/之前聊过的内容，先参考“系统预检索记忆”；如果系统预检索内容还不够，再调用 MemoryOperation，优先使用 chatHistory 的 search:关键词 或 guid:id 去补充历史上下文，然后再回答
  ${nonVisionImagePrompt}
  调用执行脚本类型的工具时, 务必确保脚本安全, 不得执行对服务器有伤害的脚本
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
  #### 艾特用户
  ${botName}:<at=用户id>消息内容
  #### 撤回消息
  ${botName}:<revoke=消息id>
  ${complexOutputIsOpen === "1" && isOpenTTSReply === "1"
        ? `#### 语音
  ${botName}:<tts=你好这是一个语音消息>
  #### 切换音色
  ${botName}:<音色=派蒙-默认><tts=这是派蒙的默认声音哦>`
        : "#### 语音回复: 当前不可用"}
  ${isOpenR18 === "1"
        ? "#### NSFW内容: 不限制"
        : `
  #### NSFW内容:
  当用户发送的消息中包含敏感词时, 提醒用户注意言辞, 并且不回答用户的问题, 务必遵守国家法律法规
  `}
  
  ${affectionIsOpen === "1" && complexOutputIsOpen === "1"
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
        : ""}
  
  #### 基础状态信息:
  这里的信息会实时变化,根据需要进行获取使用
  当前群时间:${getGroupTimeString()}
  当前群号(reviewGuid):${e.guid}
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
${memoryPrompt ? `\n【系统预检索记忆】\n${relevantMemoryContext}\n` : ""}
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
const shouldSkipAIReply = async (e, cfg) => {
    // 正则触发时直接必定回复，忽略后续所有判断
    if (e["regexTriggered"]) {
        console.log("正则规则匹配, 跳过 shouldSkipAIReply 检查, 必定回复");
        return false;
    }
    // 如果是命令则跳过
    if (e.msg.startsWith("/") ||
        e.msg.startsWith("#") ||
        e.UserId == e.bot.user_id) {
        return true;
    }
    cfg ??= await getChatConfig(e);
    // 如果没有配置AI,则不处理
    if (cfg.config.host.trim() === "" ||
        cfg.config.key.trim() === "" ||
        cfg.config.model.trim() === "") {
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
/**
 * 打包消息内容（兼容 CAPI / RAPI）
 */
const buildUserMessage = async (e, cfg, mode = "capi") => {
    const imgs = [];
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
    const validImageUrls = imageurls.filter(Boolean);
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
    rawMessage = rawMessage.replace(/\[CQ:face,id=(\d+),[^\]]+\]/g, (_, id) => `[${emojiMap[id]}]`);
    const text = `${e.nickname}(${getMessageTimeString()}): ${rawMessage}`;
    // =========================
    // 🔥 CAPI (chat.completions)
    // =========================
    if (mode === "capi") {
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
    }
    // =========================
    // 🔥 RAPI (responses API)
    // =========================
    if (textOnlyImages) {
        return attachImageUrls({
            role: "user",
            content: [
                {
                    type: "input_text",
                    text,
                },
            ],
        }, validImageUrls);
    }
    return attachImageUrls({
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
    }, validImageUrls);
};
const getDeepThoughtReasoning = (cfg) => {
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
    }
    else {
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

export { NON_VISION_MODEL_KEYWORDS, VISION_MODEL_KEYWORDS, adaptHistoryMessagesForModel, bindDescribeImageUrl, buildUserMessage, getChatConfig, getDeepThoughtReasoning, isDeepSeekModel, isNonVisionModel, normalizeTools, shouldSkipAIReply };
