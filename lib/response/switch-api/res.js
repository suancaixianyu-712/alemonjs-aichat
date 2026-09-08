import redisClient from '../../config.js';
import { Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';

const selects = onSelects(["message.create", "private.message.create"]);
var res = onResponse(selects, async (e, next) => {
    const match = String(e.msg || "")
        .trim()
        .match(/^(#|\/)切换接口(?:\s+(capi|rapi))?$/i);
    if (!match)
        return next();
    const [message] = useMessage(e);
    const requestedMode = String(match[2] || "").toLowerCase();
    if (!requestedMode) {
        const config = await redisClient.getAIConfig(e.guid);
        const currentMode = config.apiMode === "rapi" ? "RAPI" : "CAPI";
        await message.send(format(Text(`当前接口：${currentMode}\n切换指令：#切换接口 capi 或 #切换接口 rapi`)));
        return;
    }
    const config = await redisClient.switchCurrentAIAPI(e.guid, requestedMode);
    if (!config) {
        await message.send(format(Text("当前没有可用的 AI 配置。")));
        return;
    }
    await message.send(format(Text(`已将当前 AI 的接口切换为 ${requestedMode.toUpperCase()}，下次切换回该 AI 时仍会沿用。`)));
});

export { res as default };
