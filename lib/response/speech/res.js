import { Text } from 'alemonjs';
import redisClient from '../../config.js';
import { useMessage } from '../../utils/command-message.js';
import { listSpeechModels, setSpeechVoice, switchSpeechModel, addSpeechModel } from '../../api/speech-config.js';
import { getSpeechVoices } from '../../api/speech.js';

const selects = onSelects(["message.create", "private.message.create"]);
const isSpeechConfigCommand = (text) => /^(#|\/)(?:添加语音配置|设置音色|切换语音模型|语音列表)(?:\s|$)/.test(text);
const getSpeechSessionKey = (e) => `ai:speech:add:session:${e.Platform || "unknown"}:${e.guid}:${e.UserId || "unknown"}`;
const menu = (names, labels) => [
    "请选择要复用地址、密钥和代理设置的 AI 配置：",
    ...names.map((name, index) => `${index + 1}. ${labels[index] || name}`),
    "回复序号或完整配置 ID，发送“取消”可终止添加。",
].join("\n");
const handleSpeechMessage = async (e) => {
    const text = String(e.msg || e.MessageText || "").trim();
    const sessionKey = getSpeechSessionKey(e);
    const raw = await redisClient.redis.get(sessionKey);
    let session = null;
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed.model === "string" && Array.isArray(parsed.names))
                session = parsed;
        }
        catch { }
        if (!session)
            await redisClient.redis.del(sessionKey);
    }
    if (!session && !isSpeechConfigCommand(text))
        return false;
    const [message] = useMessage(e);
    const reply = async (value) => message.send(format(Text(value)));
    try {
        if (isSpeechConfigCommand(text))
            await redisClient.redis.del(sessionKey);
        const add = text.match(/^(#|\/)添加语音配置(?:\s+(\S+))?\s*$/);
        if (add) {
            if (!add[2]) {
                await reply("格式：#添加语音配置 <模型id>\n例如：#添加语音配置 gpt-4o-mini-tts");
                return true;
            }
            const names = (await redisClient.getAIList()).sort((a, b) => a.localeCompare(b));
            if (!names.length) {
                await reply("还没有 AI 配置，请先使用 #添加AI。");
                return true;
            }
            session = { model: add[2], names };
            await redisClient.redis.set(sessionKey, JSON.stringify(session), "EX", 600);
            await reply(menu(names, await redisClient.getAIDisplayNames(names)));
            return true;
        }
        if (/^(#|\/)语音列表$/.test(text)) {
            const { models, current } = await listSpeechModels();
            await reply(models.length ? [
                "全局语音模型列表：",
                ...models.map((item, index) => `${index + 1}. ${item.model}${item.model === current ? " [当前]" : ""}\n   音色：${item.voice}；AI 配置：${item.aiName}`),
                "#切换语音模型 <模型id>\n#设置音色 <voice>（修改当前模型的音色）",
            ].join("\n") : "暂无语音模型，请使用 #添加语音配置 <模型id> 添加。");
            return true;
        }
        const voice = text.match(/^(#|\/)设置音色\s+(\S+)$/);
        if (voice) {
            const config = await setSpeechVoice(voice[2].toLowerCase());
            await reply(`已将全局语音模型 ${config.model} 的音色设置为 ${config.voice}。`);
            return true;
        }
        const change = text.match(/^(#|\/)切换语音模型\s+(\S+)$/);
        if (change) {
            const config = await switchSpeechModel(change[2]);
            await reply(`已切换全局语音模型：${config.model}\n音色：${config.voice}`);
            return true;
        }
        if (isSpeechConfigCommand(text)) {
            await reply("格式：\n#添加语音配置 <模型id>\n#设置音色 <voice>\n#切换语音模型 <模型id>\n#语音列表");
            return true;
        }
        if (session) {
            if (text === "取消" || /^[#/]/.test(text)) {
                await redisClient.redis.del(sessionKey);
                if (text === "取消") {
                    await reply("已取消添加语音配置。");
                    return true;
                }
                return false;
            }
            const aiName = /^\d+$/.test(text) ? session.names[Number(text) - 1]
                : session.names.find((name) => name === text);
            if (!aiName) {
                await reply(`选择无效，请回复列表中的序号或完整配置 ID。\n${menu(session.names, await redisClient.getAIDisplayNames(session.names))}`);
                return true;
            }
            const config = await addSpeechModel(session.model, aiName);
            await redisClient.redis.del(sessionKey);
            await reply(`已添加并选中全局语音模型：${config.model}\nAI 配置：${config.aiName}\n音色：${config.voice}\n可用音色：${getSpeechVoices(config.model).join("、")}\nAI 可调用 GenerateSpeech 工具生成语音。`);
            return true;
        }
    }
    catch (error) {
        await reply(error instanceof Error ? error.message : "语音配置操作失败，请重试。");
        return true;
    }
    return false;
};
var res = onResponse(selects, async (e) => { await handleSpeechMessage(e); });

export { res as default, getSpeechSessionKey, handleSpeechMessage, isSpeechConfigCommand };
