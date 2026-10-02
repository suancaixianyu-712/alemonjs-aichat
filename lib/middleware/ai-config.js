import { handleAddAIMessage } from '../response/add-ai/res.js';
import { handleSwitchAIMessage } from '../response/switch-ai/res.js';
import { isSpeechConfigCommand, getSpeechSessionKey, handleSpeechMessage } from '../response/speech/res.js';
import redisClient from '../config.js';

const selects = onSelects(["message.create", "private.message.create"]);
/**
 * 添加/切换 AI 都是连续会话，必须先于普通 AI 对话消费对应消息。
 */
var aiConfig = onMiddleware(selects, async (event, next) => {
    event["msg"] = event.MessageText;
    event["guid"] = event.ChannelId ?? event.UserId;
    const configSessionSuffix = `${event.Platform || "unknown"}:${event.guid}:${event.UserId || "unknown"}`;
    if (isSpeechConfigCommand(event.msg)) {
        await redisClient.redis.del(`ai:add:session:${configSessionSuffix}`, `ai:switch:session:${configSessionSuffix}`);
    }
    else if (/^(#|\/)(?:添加ai|切换(?:ai|配置))(?:\s|$)/i.test(event.msg)) {
        await redisClient.redis.del(getSpeechSessionKey(event));
    }
    if (await handleSpeechMessage(event)) {
        event["Xianyu"] = false;
        return;
    }
    const isAILockCommand = /^(#|\/)(?:锁定ai列表|(?:锁定|解锁)ai)(?:\s|$)/i.test(event.msg);
    if (isAILockCommand)
        return next();
    const isSwitchCommand = /^(#|\/)切换(?:ai|配置)(?:\s|$)/i.test(event.msg);
    const handled = isSwitchCommand
        ? await handleSwitchAIMessage(event)
        : (await handleAddAIMessage(event)) || (await handleSwitchAIMessage(event));
    if (handled) {
        event["Xianyu"] = false;
        return;
    }
    return next();
});

export { aiConfig as default };
