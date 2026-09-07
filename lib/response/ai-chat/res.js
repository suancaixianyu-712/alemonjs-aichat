import { useMessage, Text } from 'alemonjs';
import redisClient from '../../config.js';
import { CApiReply } from '../zreply/capi.js';
import { getChatConfig, buildUserMessage } from '../zreply/getChatConfig.js';

const selects = onSelects(["message.create", "private.message.create"]);
const prependGuidancePrefix = (message) => ({
    ...message,
    guidance: true,
    content: Array.isArray(message?.content)
        ? message.content.map((item) => {
            if (item?.type === "text") {
                return {
                    ...item,
                    text: "[补充引导] 工具调用期间用户追加了新的消息，请结合这条消息调整后续工具调用和最终回复。\n" +
                        item.text,
                };
            }
            return item;
        })
        : message?.content,
});
const buildGuidanceMessage = async (event) => {
    const cfg = await getChatConfig(event);
    const capiMessage = prependGuidancePrefix(await buildUserMessage(event, cfg));
    return {
        guidance: true,
        capiMessage,
        createdAt: Date.now(),
        previewText: event.msg || "",
    };
};
const canPassReplyTriggerGate = async (event) => {
    if (event.UserId == event.bot?.user_id ||
        !event.msg ||
        event.msg.startsWith("/") ||
        event.msg.startsWith("#")) {
        return false;
    }
    // 聊天频率限制（每分钟最多 N 条，主人除外）
    if (event.IsMaster !== true) {
        const chatRateLimit = await redisClient.getChatRateLimit(event.guid);
        const allowed = await redisClient.checkChatRateLimit(event.guid, String(event.UserId || ""), chatRateLimit);
        if (!allowed) {
            event["rateLimited"] = true;
            return false;
        }
    }
    if (event["nextUserMessageSubscriptionTriggered"]) {
        return true;
    }
    const aiConfig = await redisClient.getAIConfig(event.guid);
    if (!aiConfig ||
        aiConfig.host.trim() === "" ||
        aiConfig.key.trim() === "" ||
        aiConfig.model.trim() === "") {
        return false;
    }
    if (event.name !== "private.message.create") {
        const subscriptionTriggered = await redisClient.consumeNextUserMessageSubscription(event.guid, String(event.UserId || ""), event.Platform);
        if (subscriptionTriggered) {
            event["nextUserMessageSubscriptionTriggered"] = true;
            return true;
        }
    }
    const atTriggerSwitch = await redisClient.getAtTriggerSwitch(event.ChannelId ?? event.UserId);
    if (atTriggerSwitch === "1" && event.Platform !== "testone") {
        if (!event["atBot"] && event.name !== "private.message.create") {
            const regexMatched = await redisClient.matchRegexRule(event.ChannelId ?? event.UserId, event.msg || "");
            if (regexMatched) {
                event["regexTriggered"] = true;
                return true;
            }
            return false;
        }
    }
    return true;
};
var res = onResponse(selects, async (event, next) => {
    const shouldReply = await canPassReplyTriggerGate(event);
    const toolLoopProcessing = (await redisClient.getAIToolLoopProcessing(event.guid, event.Platform)) ===
        "1";
    if (toolLoopProcessing && shouldReply) {
        const guidanceMessage = await buildGuidanceMessage(event);
        const queue = await redisClient.addAIGuidanceMessage(event.guid, guidanceMessage, event.Platform);
        if (queue.length === 1) {
            const [message] = useMessage(event);
            await message.send(format(Text("已收到新的补充消息，等当前工具调用完成后会一并处理。")));
        }
        event["Xianyu"] = false;
        return next();
    }
    if (!shouldReply) {
        event["Xianyu"] = false;
        return next();
    }
    const aiconfig = await redisClient.getAIConfig(event.guid);
    if (aiconfig?.model && aiconfig.key) {
        const replyResult = await CApiReply(event);
        console.log("res", replyResult);
        if (replyResult) {
            event["Xianyu"] = replyResult.next;
        }
    }
    return next();
});

export { res as default };
