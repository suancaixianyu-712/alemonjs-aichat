import { Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';
import { sendSpeechToolResult } from '../../api/speech.js';
import { dsTtsSpeak, dsTtsStatus, formatDsTtsConfigText, getDsTtsConfigView, patchDsTtsConfig } from '../../api/ds-tts/index.js';

const selects = onSelects(["message.create", "private.message.create"]);
const isDsTtsCommand = (text) => /^(#|\/)ds说/i.test(text) ||
    /^(#|\/)DS朗读(?:配置|状态)(?:\s|$)/i.test(text);
/**
 * 解析 `#DS朗读配置 key=value key2=value2` 或仅查询。
 */
const parseDsTtsConfigArgs = (raw) => {
    const out = {};
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
        const eq = token.indexOf("=");
        if (eq <= 0)
            continue;
        const key = token.slice(0, eq).trim();
        const value = token.slice(eq + 1).trim();
        if (!key)
            continue;
        if (value === "true")
            out[key] = true;
        else if (value === "false")
            out[key] = false;
        else if (/^-?\d+(\.\d+)?$/.test(value))
            out[key] = Number(value);
        else
            out[key] = value;
    }
    return out;
};
const handleDsTtsMessage = async (e) => {
    const text = String(e.msg || e.MessageText || "");
    if (!isDsTtsCommand(text))
        return false;
    const [message] = useMessage(e);
    const reply = async (value) => message.send(format(Text(value)));
    const speakMatch = text.match(/^(#|\/)ds说([\s\S]*)$/i);
    if (!speakMatch && e.IsMaster !== true) {
        await reply("该指令仅主人可用");
        return true;
    }
    try {
        if (speakMatch) {
            const content = speakMatch[2];
            if (!content.trim()) {
                await reply("请提供要说的话，例如：\n#ds说 你好");
                return true;
            }
            const result = await dsTtsSpeak({ text: content });
            if (!result.ok) {
                await reply(result.error);
                return true;
            }
            await sendSpeechToolResult(message, result);
            return true;
        }
        if (/^(#|\/)DS朗读状态\s*$/i.test(text)) {
            const status = await dsTtsStatus();
            await reply(status.text);
            return true;
        }
        const configMatch = text.match(/^(#|\/)DS朗读配置(?:\s+([\s\S]*))?$/i);
        if (configMatch) {
            const args = String(configMatch[2] || "").trim();
            if (!args) {
                await reply(formatDsTtsConfigText(await getDsTtsConfigView()));
                return true;
            }
            const patch = parseDsTtsConfigArgs(args);
            if (Object.keys(patch).length === 0) {
                await reply("格式：#DS朗读配置 voice=mira timeoutMs=120000 browserPath=/usr/bin/google-chrome\n可改：voice / maxChars / timeoutMs / cdpPort / autoLaunch / browserPath / cdpUrl / echoVerify");
                return true;
            }
            const view = await patchDsTtsConfig(patch);
            await reply(`已更新 DS 朗读配置。\n${formatDsTtsConfigText(view)}`);
            return true;
        }
        await reply("格式：\n#DS朗读配置\n#DS朗读配置 voice=mira browserPath=/usr/bin/google-chrome\n#DS朗读状态");
        return true;
    }
    catch (error) {
        await reply(error instanceof Error ? error.message : speakMatch ? "DS 语音合成失败，请重试。" : "DS 朗读配置操作失败，请重试。");
        return true;
    }
};
var res = onResponse(selects, async (e) => {
    await handleDsTtsMessage(e);
});

export { res as default, handleDsTtsMessage, isDsTtsCommand, parseDsTtsConfigArgs };
