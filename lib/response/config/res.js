import redisClient from '../../config.js';
import { toolSessionController } from '../../api/tool-session-controller.js';
import { loadSkills } from '../../api/loadSkill.js';
import App from '../../image/conponent/AiConfig.js';
import { Text, Image } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';
import { renderComponentIsHtmlToBuffer } from 'jsxp';
import OpenAi from 'openai';
import { getOpenAIProxyFetch } from '../../api/openaiProxy.js';
import { getAiChatConfigValue } from '../../config/app.js';

const selects = onSelects(["message.create", "private.message.create"]);
const parseArchiveSummary = (content) => {
    const summaryMatch = content.match(/摘要:(.*?)(?:详细信息:|$)/s);
    const detailMatch = content.match(/详细信息:(.*)/s);
    return {
        summary: summaryMatch ? summaryMatch[1].trim() : "",
        detail: detailMatch ? detailMatch[1].trim() : "",
    };
};
const archiveCurrentConversation = async (guid, reason, aiConfig) => {
    const history = await redisClient.getAIChatHistory(guid);
    if (history.length === 0) {
        return null;
    }
    if (aiConfig?.model) {
        try {
            const openai = new OpenAi({
                baseURL: aiConfig.host,
                apiKey: aiConfig.key,
                timeout: 300000,
                fetch: getOpenAIProxyFetch(getAiChatConfigValue().httpProxy, redisClient.isAIProxyEnabled(aiConfig)),
            });
            const summaryPrompt = "请总结一下我们之前的聊天内容。请严格按以下格式输出：\n摘要:<一句到两句的简短总结>\n详细信息:<尽可能完整的要点整理，方便之后继续对话>";
            const response = await openai.chat.completions.create({
                model: aiConfig.model,
                messages: [
                    ...history,
                    {
                        role: "user",
                        content: summaryPrompt,
                    },
                ],
                stream: false,
            });
            const content = response.choices[0].message.content || "";
            const { summary, detail } = parseArchiveSummary(content);
            return await redisClient.archiveAIChatHistory(guid, {
                reason,
                summary,
                detail,
            });
        }
        catch (error) {
            console.error("对话归档总结失败，改用本地摘要：", error);
        }
    }
    return await redisClient.archiveAIChatHistory(guid, {
        reason,
    });
};
const statusNumberFormatter = new Intl.NumberFormat("zh-CN");
const formatNumberValue = (value) => {
    return typeof value === "number" && Number.isFinite(value)
        ? statusNumberFormatter.format(value)
        : "未知";
};
const formatTokenValue = (value) => {
    return formatNumberValue(value);
};
const formatContextLimit = (tokens) => {
    if (tokens >= 1000000 && tokens % 1000000 === 0) {
        return `${tokens / 1000000}m`;
    }
    if (tokens >= 1000 && tokens % 1000 === 0) {
        return `${tokens / 1000}k`;
    }
    return `${tokens}`;
};
const formatHttpProxyStatus = (enabled, configured, aiName) => {
    const target = aiName ? `当前AI ${aiName}` : "当前AI";
    if (!enabled)
        return `代理: ${target} 直连（${configured ? "已配置" : "未配置"}）`;
    return configured
        ? `代理: ${target} 已开启`
        : `代理: ${target} 已开启（未配置，当前不生效）`;
};
const formatAIContextStatus = (stats, capiContextLimit) => {
    if (!stats) {
        return `当前会话还没有 CAPI 上下文统计。\nCAPI上下文长度: ${formatContextLimit(capiContextLimit)}`;
    }
    const updatedAt = new Date(stats.updatedAt).toLocaleString("zh-CN", {
        hour12: false,
    });
    const usageNote = stats.usageAvailable
        ? ""
        : "提示: 最近一次请求未返回 usage, 实际 token 统计可能不完整。";
    const divider = "················";
    return [
        "当前AI状态：",
        divider,
        `模式: ${stats.mode.toUpperCase()}`,
        `模型: ${stats.model || "未知"}`,
        `更新时间: ${updatedAt}`,
        `请求次数: ${formatNumberValue(stats.requestCount)}`,
        divider,
        "最近一次上下文：",
        `CAPI上下文长度: ${formatContextLimit(capiContextLimit)}`,
        `消息数: ${formatNumberValue(stats.contextMessageCount)}`,
        `上下文字符数: ${formatNumberValue(stats.contextCharLength)}`,
        `上下文估算token: ${formatTokenValue(stats.estimatedContextTokens)}`,
        `输入token: ${formatTokenValue(stats.promptTokens)}`,
        `输出token: ${formatTokenValue(stats.completionTokens)}`,
        `总token: ${formatTokenValue(stats.totalTokens)}`,
        `缓存命中token: ${formatTokenValue(stats.cachedTokens)}`,
        `缓存未命中token: ${formatTokenValue(stats.cacheMissTokens)}`,
        divider,
        "当前会话累计：",
        `输入token: ${formatTokenValue(stats.totalPromptTokens)}`,
        `输出token: ${formatTokenValue(stats.totalCompletionTokens)}`,
        `总token: ${formatTokenValue(stats.totalTokensUsed)}`,
        `缓存命中token: ${formatTokenValue(stats.totalCachedTokens)}`,
        `缓存未命中token: ${formatTokenValue(stats.totalCacheMissTokens)}`,
        usageNote,
    ]
        .filter((line) => line !== "")
        .join("\n");
};
var res = onResponse(selects, async (e, next) => {
    // 创建
    const [message] = useMessage(e);
    const config = await redisClient.getAIConfig(e.guid);
    // 查看AI状态
    if (/^(\/|#)ai状态$/i.test(e.msg)) {
        const toolStatus = await toolSessionController.getStatus(e.guid);
        const currentAI = await redisClient.getCurrentAI(e.guid);
        const httpProxyEnabled = redisClient.isAIProxyEnabled(config);
        const httpProxyConfigured = Boolean(String(getAiChatConfigValue().httpProxy || "").trim());
        const httpProxyStatus = formatHttpProxyStatus(httpProxyEnabled, httpProxyConfigured, currentAI);
        if (toolStatus.tool !== "default") {
            message.send(format(Text([
                "当前AI状态：",
                `当前工具: ${toolStatus.toolLabel}`,
                `当前AI: ${currentAI || "未设置"}`,
                `模型: ${toolStatus.model || "未设置"}`,
                httpProxyStatus,
                `权限: ${toolStatus.permissionLabel}`,
                `当前会话: ${toolStatus.title || "未创建"}`,
                `会话ID: ${toolStatus.sessionId || "未创建"}`,
            ].join("\n"))));
            return;
        }
        const stats = await redisClient.getAIContextStats(e.guid);
        const capiContextLimit = await redisClient.getCAPIContextLimit(e.guid);
        message.send(format(Text(`当前工具: ${toolStatus.toolLabel}\n${httpProxyStatus}\n${formatAIContextStatus(stats, capiContextLimit)}`)));
        return;
    }
    // 查看AI配置
    if (/^(\/|#)(ai配置|当前提示词|查看提示词)$/i.test(e.msg)) {
        const complexResponse = (await redisClient.getComplexOutput(e.guid)) || "1"; // 复杂输出
        const affectionIsOpen = await redisClient.getAffectionSwitch(e.guid); // 好感度开关
        const isOpenTTSReply = await redisClient.getTTSResponseSwitch(e.guid); // TTS回复开关
        const toolsIsOpen = await redisClient.getToolSwitch(e.guid); // 工具开关
        const deepThinkingIsOpen = await redisClient.getDeepThoughtSwitch(e.guid); // 深度思考开关
        const atTriggerSwitch = await redisClient.getAtTriggerSwitch(e.guid); // 仅艾特触发
        const imageBedSwitch = await redisClient.getImageBedSwitch(e.guid); // 全局图床开关
        const currentAI = await redisClient.getCurrentAI(e.guid); // 当前AI名称
        const aiList = await redisClient.getAIList();
        const skillList = loadSkills();
        const toolList = await redisClient.getAllToolStatus(e.guid);
        const toolPromptSwitch = await redisClient.getToolPromptSwitch(e.guid); // 工具提示开关
        const toolPromptRevokeSwitch = await redisClient.getToolPromptRevokeSwitch(e.guid); // 工具提示撤回开关
        const toolPromptArgsSwitch = await redisClient.getToolPromptArgsSwitch(e.guid); // 工具提示传参开关
        const toolCallContentSwitch = await redisClient.getToolCallContentSwitch(e.guid); // 工具调用内容发送开关
        const capiContextLimit = await redisClient.getCAPIContextLimit(e.guid);
        // 发送消息
        try {
            const scale = await redisClient.getRenderPrecision(e.guid);
            const img = await renderComponentIsHtmlToBuffer(App, {
                switch: config.model != "",
                tools: toolsIsOpen == "1",
                complex: complexResponse == "1",
                affection: affectionIsOpen == "1",
                tts: isOpenTTSReply == "1",
                deep: deepThinkingIsOpen == "1",
                model: config.model,
                prompt: config.systemPrompt,
                atTrigger: atTriggerSwitch == "1",
                imageBedSwitch: imageBedSwitch == "1",
                aiList: aiList,
                currentAI: currentAI,
                skillList,
                toolList: toolList,
                toolPromptSwitch: toolPromptSwitch == "1",
                toolPromptRevokeSwitch: toolPromptRevokeSwitch == "1",
                toolPromptArgsSwitch: toolPromptArgsSwitch == "1",
                toolCallContentSwitch: toolCallContentSwitch == "1",
                capiContextLimit: formatContextLimit(capiContextLimit),
            }, {
                playwright: {
                    context: { deviceScaleFactor: scale },
                },
            });
            if (img) {
                message.send(format(Image(img)));
            }
            else {
                message.send(format(Text(`当前AI配置：\n`), Text(`总开关: ${config.model != "" ? "开启" : "关闭"}\n`), Text(`工具: ${toolsIsOpen == "1" ? "开启" : "关闭"}\n`), Text(`工具调用内容: ${toolCallContentSwitch == "1" ? "开启" : "关闭"}\n`), Text(`CAPI上下文长度: ${formatContextLimit(capiContextLimit)}\n`), Text(`复杂输出: ${complexResponse == "1" ? "开启" : "关闭"}\n`), Text(`好感度开关: ${affectionIsOpen == "1" ? "开启" : "关闭"}\n`), Text(`TTS回复开关: ${isOpenTTSReply == "1" ? "开启" : "关闭"}\n`), Text(`深度思考: ${deepThinkingIsOpen == "1" ? "默认" : "关闭"}\n`), Text(`仅艾特触发: ${atTriggerSwitch == "1" ? "开启" : "关闭"}\n`), Text(`全局图床开关: ${imageBedSwitch == "1" ? "开启" : "关闭"}\n`), Text(`模型: ${config.model || "未设置"}\n`), Text(`提示词: ${config.systemPrompt || "未设置"}\n`), Text(`当前AI: ${currentAI || "未设置"}\n`), Text(`AI数量: ${aiList.length ? aiList.length : "暂无AI配置"}`)));
            }
        }
        catch (error) {
            message.send(format(Text(`当前AI配置：\n`), Text(`总开关: ${config.model != "" ? "开启" : "关闭"}\n`), Text(`工具: ${toolsIsOpen == "1" ? "开启" : "关闭"}\n`), Text(`工具调用内容: ${toolCallContentSwitch == "1" ? "开启" : "关闭"}\n`), Text(`CAPI上下文长度: ${formatContextLimit(capiContextLimit)}\n`), Text(`复杂输出: ${complexResponse == "1" ? "开启" : "关闭"}\n`), Text(`好感度开关: ${affectionIsOpen == "1" ? "开启" : "关闭"}\n`), Text(`TTS回复开关: ${isOpenTTSReply == "1" ? "开启" : "关闭"}\n`), Text(`深度思考: ${deepThinkingIsOpen == "1" ? "默认" : "关闭"}\n`), Text(`仅艾特触发: ${atTriggerSwitch == "1" ? "开启" : "关闭"}\n`), Text(`全局图床开关: ${imageBedSwitch == "1" ? "开启" : "关闭"}\n`), Text(`模型: ${config.model || "未设置"}\n`), Text(`提示词: ${config.systemPrompt || "未设置"}\n`), Text(`当前AI: ${currentAI || "未设置"}\n`), Text(`AI数量: ${aiList.length ? aiList.length : "暂无AI配置"}`)));
        }
    }
    // 查看AI列表
    if (/^(\/|#)ai列表$/i.test(e.msg)) {
        const ailist = await redisClient.getAIList();
        const numberedAIList = ailist.map((name, index) => `${index + 1}. ${name}`);
        message.send(format(Text("当前AI列表：\n"), Text(numberedAIList.length ? numberedAIList.join("\n") : "暂无AI配置")));
    }
    // 查看提示词列表
    if (/^(\/|#)提示词列表$/i.test(e.msg)) {
        const prompts = await redisClient.getPromptList();
        message.send(format(Text("当前提示词列表：\n"), Text(prompts.length ? prompts.join("\n") : "暂无提示词")));
    }
    // 清空对话
    if (/^(\/|#)清空对话$/i.test(e.msg)) {
        message.send(format(Text("正在归档并清空当前对话，请稍等...")));
        const archived = await archiveCurrentConversation(e.guid, "clear", config);
        await redisClient.clearAIChatHistory(e.guid);
        await redisClient.deleteSessionId(e.guid);
        message.send(format(Text(archived ? "当前对话已归档并清空" : "对话已清空")));
    }
    // 删除对话
    if (/^(\/|#)删除对话$/i.test(e.msg)) {
        await redisClient.clearAIChatHistory(e.guid);
        await redisClient.deleteSessionId(e.guid);
        message.send(format(Text("当前对话已删除")));
    }
    // 清空所有对话
    if (/^(\/|#)清空(所有|全部)对话$/i.test(e.msg) && e.IsMaster) {
        await redisClient.clearAIChatHistory();
        message.send(format(Text("所有对话已清空")));
    }
    // get请求一个地址
    if (/^(\/|#)get (.+)$/i.test(e.msg)) {
        const match = e.msg.match(/^(\/|#)get (.+)$/i);
        if (!match) {
            message.send(format(Text("格式错误，请按照 格式：/get <url> 进行请求")));
            return;
        }
        const [, , url] = match;
        try {
            const res = await fetch(url);
            const text = await res.text();
            message.send(format(Text(`GET ${url} 的响应：\n${text}`)));
        }
        catch (error) {
            message.send(format(Text(`请求 ${url} 失败：${error}`)));
        }
    }
    next();
});

export { res as default, selects };
