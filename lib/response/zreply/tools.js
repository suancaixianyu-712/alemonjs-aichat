import { Mention, Text, ImageURL, ImageFile, Audio, format } from 'alemonjs';
import redisClient from '../../config.js';
import { uploadImageToR2 } from '../../s3.js';
import { imageReview } from '../../api/review.js';
import fileUrl from '../../assets/error.png.js';

const removeThinkContent = (text) => {
    return text
        .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
        .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
        .replace(/<\/think\s*>/gi, "");
};
const extractImages = (text) => {
    const regex = /<img=(.*?)>/g;
    const regex2 = /!\[[^\]]+\]\(([^)]+)\)/g;
    const result = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        result.push(match[1].trim().replace(/\\/g, "/"));
    }
    while ((match = regex2.exec(text)) !== null) {
        result.push(match[1].trim());
    }
    return result;
};
/** 提取 <audio=url> 标签中的音频链接（导出供单测）。 */
const extractAudios = (text) => {
    const regex = /<audio=(.*?)>/g;
    const result = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const url = match[1].trim();
        if (url)
            result.push(url);
    }
    return result;
};
const handleAffection = async (text, e) => {
    const regex = /<([^<>]*?)好感([+-]\d+)>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const nickname = match[1] || e.UserName;
        const change = parseInt(match[2], 10);
        if (!isNaN(change) && change !== 0) {
            await redisClient.incrementAffectionLevel(e.guid, nickname, change);
        }
    }
};
const handleRevoke = async (text, message) => {
    const regex = /<revoke=(.*?)>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        await message.delete({ messageId: match[1].trim() });
    }
};
const cleanMessage = (text) => {
    return text
        .replace(/<img=(.*?)>/g, "")
        .replace(/<audio=(.*?)>/g, "")
        .replace(/<command=(.*?)>/g, "")
        .replace(/<revoke=(.*?)>/g, "")
        .replace(/<at=(.*?)>/g, "")
        .replace(/!\[[^\]]+\]\([^\)]+\)/g, "")
        .trim();
};
const extractAt = (text, list) => {
    const regex = /<at=(.*?)>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        list.push(match[1].trim());
    }
};
const processImage = async (img, e, cfg) => {
    const isNetwork = /^https?:\/\//.test(img);
    let finalImg = img;
    if (e.Platform === "scbbs" && isNetwork) {
        finalImg = await uploadImageToR2(img);
    }
    if (cfg.isOpenR18 !== "1" && finalImg) {
        try {
            const res = await imageReview(finalImg);
            if (res?.conclusion === "不合规") {
                return null;
            }
        }
        catch { }
    }
    return finalImg;
};
const extractCommands = (text, list) => {
    const regex = /<command=(.*?)>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        list.push(match[1].trim());
    }
};
const sendReplyMessages = async (replyMessages, e, cfg, message) => {
    for (let i = 0; i < replyMessages.length; i++) {
        const { text, images, audios = [], at } = replyMessages[i];
        const components = i === 0 ? [Mention(e.UserId)] : [];
        components.push(Text(text));
        for (const img of images) {
            let finalImg = await processImage(img, e, cfg);
            if (finalImg) {
                components.push(/^https?:\/\//.test(finalImg)
                    ? ImageURL(finalImg)
                    : ImageFile(finalImg));
            }
            else {
                components.push(ImageFile(fileUrl));
            }
        }
        for (const audioUrl of audios) {
            const url = String(audioUrl || "").trim();
            if (/^https?:\/\//.test(url)) {
                components.push(Audio(url));
            }
        }
        for (const atTarget of at) {
            components.push(Mention(atTarget));
        }
        const delay = Math.random() * 2000 + 1000;
        await new Promise((r) => setTimeout(r, delay));
        await message.send(format(...components));
    }
};
const sendParsedReplyToCustomOutput = async (message, aireply) => {
    if (typeof message?.sendAIReply !== "function")
        return false;
    await message.sendAIReply(aireply);
    return true;
};
const parseAIReply = async (newText, cfg, e, message) => {
    const visibleText = removeThinkContent(newText);
    const replyMessages = visibleText.split(new RegExp(`${cfg.botName}:`, "g"));
    const replyMessagesResult = [];
    const nextCommands = [];
    const atTargets = [];
    for (let replyMessage of replyMessages) {
        if (replyMessage.trim() === "" || replyMessage.trim() === "[]") {
            continue;
        }
        replyMessage = replyMessage.trim();
        const imgUrls = extractImages(replyMessage);
        const audioUrls = extractAudios(replyMessage);
        const messageAtTargets = [];
        await handleAffection(replyMessage, e);
        extractCommands(replyMessage, nextCommands);
        await handleRevoke(replyMessage, message);
        extractAt(replyMessage, messageAtTargets);
        atTargets.push(...messageAtTargets);
        const cleanText = cleanMessage(replyMessage);
        replyMessagesResult.push({
            text: cleanText,
            images: imgUrls,
            audios: audioUrls,
            at: messageAtTargets,
        });
    }
    return {
        replyMessages: replyMessagesResult,
        nextCommands,
        atTargets,
    };
};
const sendAIReplyToOutput = sendParsedReplyToCustomOutput;

export { cleanMessage, extractAudios, parseAIReply, removeThinkContent, sendAIReplyToOutput, sendReplyMessages };
