import redisClient from '../../config.js';
import { Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';
import { resolveBuiltinToolName, getSupportedBuiltinTools, getProviderBuiltinToolParams, BUILTIN_TOOL_LABELS } from '../zreply/provider-tools.js';

const selects = onSelects(["message.create", "private.message.create"]);
var res = onResponse(selects, async (e, next) => {
    const match = String(e.msg || "")
        .trim()
        .match(/^(#|\/)(关闭|开启)(ai)?内置工具 ?(.*)$/i);
    if (!match)
        return next();
    const [message] = useMessage(e);
    const enable = match[2] === "开启";
    const argument = String(match[4] || "").trim();
    const tool = argument ? resolveBuiltinToolName(argument) : null;
    if (argument && !tool) {
        await message.send(format(Text(`未知的内置工具：${argument}\n可用名称：网页搜索、网页提取、X搜索`)));
        return;
    }
    const config = await redisClient.switchCurrentAIBuiltinTools(e.guid, enable, tool ?? undefined);
    if (!config) {
        await message.send(format(Text("当前没有可用的 AI 配置。")));
        return;
    }
    const supported = getSupportedBuiltinTools(config);
    const enabledTools = getProviderBuiltinToolParams(config).enabled;
    const target = tool ? BUILTIN_TOOL_LABELS[tool] : "全部内置工具";
    const status = supported.length
        ? supported
            .map((name) => `${BUILTIN_TOOL_LABELS[name]}：${enabledTools.includes(name) ? "开启" : "关闭"}`)
            .join("\n")
        : "当前厂商、模型或接口模式未识别到可适配的内置工具。";
    await message.send(format(Text(`已${enable ? "开启" : "关闭"}${target}，配置会随当前 AI 保留。\n${status}`)));
});

export { res as default };
