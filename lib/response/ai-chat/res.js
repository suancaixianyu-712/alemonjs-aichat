import { useMessage, Text, Mention } from 'alemonjs';
import redisClient from '../../config.js';
import { CApiReply } from '../zreply/capi.js';
import { getChatConfig, buildUserMessage } from '../zreply/getChatConfig.js';
import { toolSessionController } from '../../api/tool-session-controller.js';
import { getLockedAIMessage } from '../../api/ai-lock.js';

const selects = onSelects(["message.create", "private.message.create"]);
const queuedAITurnChains = new Map();
const waitForQueueRetry = () => new Promise((resolve) => setTimeout(resolve, 300));
const getAITurnQueueKey = (event) => `${event.guid}:${event.Platform || "default"}`;
const enqueueIndependentAITurn = (event, outputMessage) => {
    const key = getAITurnQueueKey(event);
    let chain = queuedAITurnChains.get(key);
    if (!chain) {
        chain = { tail: Promise.resolve(), count: 0 };
        queuedAITurnChains.set(key, chain);
    }
    chain.count += 1;
    const position = chain.count;
    const run = chain.tail
        .catch(() => undefined)
        .then(async () => {
        while (true) {
            const active = await redisClient.getAIToolLoopState(event.guid, event.Platform);
            if (active) {
                await waitForQueueRetry();
                continue;
            }
            const result = await CApiReply(event, outputMessage);
            if (!result?.busy) {
                if (result)
                    event["Xianyu"] = result.next;
                return;
            }
            await waitForQueueRetry();
        }
    });
    const completed = run.finally(() => {
        chain.count -= 1;
        if (chain.count === 0 && queuedAITurnChains.get(key) === chain) {
            queuedAITurnChains.delete(key);
        }
    });
    chain.tail = completed;
    return { position, completed };
};
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
/** 与 shouldSkipAIReply 同一套概率，用来识别“这句本来会触发回复”。 */
const wouldReplyByChance = async (event) => {
    if (event.atBot)
        return true;
    const proactiveSwitch = await redisClient.getProactiveSwitch(event.guid);
    if (proactiveSwitch !== "1" && event.at && !event.atBot)
        return false;
    const rand = Math.random();
    if ((!event.at && rand > 0.1) || (event.at && !event.atBot && rand > 0.2)) {
        return false;
    }
    return true;
};
const canPassReplyTriggerGate = async (event) => {
    if (event.UserId == event.bot?.user_id) {
        return false;
    }
    const text = String(event.msg || "");
    if (text.startsWith("/") || text.startsWith("#")) {
        return false;
    }
    if (!event.msg) {
        return false;
    }
    const isGroup = event.name !== "private.message.create";
    const userID = String(event.UserId || "");
    const watched = isGroup &&
        (await redisClient.isFollowupUserWatched(event.guid, userID, event.Platform));
    // 已监听的用户再发言必须能进入判断，不受每分钟条数限制
    if (!watched && event.IsMaster !== true) {
        const chatRateLimit = await redisClient.getChatRateLimit(event.guid);
        const allowed = await redisClient.checkChatRateLimit(event.guid, userID, chatRateLimit);
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
    if (isGroup) {
        const subscriptionTriggered = await redisClient.consumeNextUserMessageSubscription(event.guid, userID, event.Platform);
        if (subscriptionTriggered) {
            event["nextUserMessageSubscriptionTriggered"] = true;
            return true;
        }
    }
    const atTriggerSwitch = await redisClient.getAtTriggerSwitch(event.ChannelId ?? event.UserId);
    const atOnly = atTriggerSwitch === "1" &&
        event.Platform !== "testone" &&
        isGroup &&
        !event["atBot"];
    if (atOnly) {
        const regexMatched = await redisClient.matchRegexRule(event.ChannelId ?? event.UserId, event.msg || "");
        if (regexMatched) {
            event["regexTriggered"] = true;
            return true;
        }
        if (watched) {
            event["followupJudgement"] = true;
            console.log("一分钟跟进: 监听用户再次发言, 交给 AI 判断", userID);
            return true;
        }
        return false;
    }
    // 已经回复过的人，在一分钟内再发一条：只触发这个人，由 AI 决定回不回
    if (watched) {
        event["followupJudgement"] = true;
        console.log("一分钟跟进: 监听用户再次发言, 交给 AI 判断", userID);
        return true;
    }
    // 新用户艾特机器人时立即处理，不等待该用户再发一条。
    if (isGroup && event["atBot"]) {
        return true;
    }
    // 窗口内其他人的主动搭话先记下，等该用户再发一条时判断。
    if (isGroup &&
        (await redisClient.isFollowupWindowActive(event.guid, event.Platform))) {
        if (await wouldReplyByChance(event)) {
            await redisClient.markFollowupWatch(event.guid, userID, event.Platform);
            console.log("一分钟内新的触发已记下, 等待该用户再发一条", userID);
        }
        return false;
    }
    return true;
};
var res = onResponse(selects, async (event, next) => {
    const [toolMessage] = useMessage(event);
    try {
        const handledByThirdPartyTool = await toolSessionController.handleMessage(event, (text) => toolMessage.send(format(Text(text))));
        if (handledByThirdPartyTool) {
            event["Xianyu"] = false;
            return next();
        }
    }
    catch (error) {
        await toolMessage.send(format(Text(`第三方工具处理失败：${error instanceof Error ? error.message : String(error)}`)));
        event["Xianyu"] = false;
        return next();
    }
    const toolLoopState = await redisClient.getAIToolLoopState(event.guid, event.Platform);
    const currentUserID = String(event.UserId || "");
    const shouldReply = await canPassReplyTriggerGate(event);
    if (shouldReply && event.IsMaster !== true) {
        const currentAI = await redisClient.getCurrentAI(event.guid);
        if (currentAI && (!await redisClient.canUseLockedAI(event.guid, event.name !== "private.message.create", currentAI))) {
            const [message] = useMessage(event);
            await message.send(format(Text(getLockedAIMessage(currentAI))));
            event["Xianyu"] = false;
            return next();
        }
    }
    const queueKey = getAITurnQueueKey(event);
    const hasQueuedTurns = queuedAITurnChains.has(queueKey);
    const belongsToActiveTurn = toolLoopState?.userID && toolLoopState.userID === currentUserID;
    if (shouldReply &&
        ((toolLoopState && !belongsToActiveTurn) ||
            (!toolLoopState && hasQueuedTurns))) {
        const [message] = useMessage(event);
        const queued = enqueueIndependentAITurn(event, message);
        await message.send(format(Mention(event.UserId), Text(`当前任务正在执行，你的消息已加入队列（第 ${queued.position} 位）。`)));
        event["Xianyu"] = false;
        await queued.completed;
        return next();
    }
    const toolLoopProcessing = Boolean(toolLoopState);
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
        if (replyResult?.busy) {
            // 判断空闲后被其他回合（如后台任务结果回合）抢先拿到锁：排队等待，不丢消息也不并行
            const [message] = useMessage(event);
            event["Xianyu"] = false;
            await enqueueIndependentAITurn(event, message).completed;
            return next();
        }
        if (replyResult) {
            event["Xianyu"] = replyResult.next;
        }
    }
    return next();
});

export { res as default };
