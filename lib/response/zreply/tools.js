import { format, Audio, Mention, Text, ImageURL, ImageFile } from 'alemonjs';
import redisClient from '../../config.js';
import { TTSClient } from '../../api/tts.js';
import { createTTSMessage } from './tts.js';
import { uploadImageToR2 } from '../../s3.js';
import { imageReview } from '../../api/review.js';
import fileUrl from '../../assets/error.png.js';

let currentModel = "派蒙-默认"; // 默认音色
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
const extractTTS = (text, list) => {
    const regex = /<(tts|音色)=([^>]+)>/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const isTTS = match[1].toLowerCase() === "tts";
        const content = match[2].trim();
        if (isTTS) {
            list.push({ text: content, model: currentModel });
        }
        else {
            currentModel = content;
        }
    }
};
const cleanMessage = (text) => {
    return text
        .replace(/<img=(.*?)>/g, "")
        .replace(/<(tts|音色)=([^>]+)>/gi, "")
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
const handleTTS = async (ttsMessages, cfg, message) => {
    if (cfg.isOpenTTSReply !== "1")
        return;
    const ttsClient = new TTSClient();
    for (const tts of ttsMessages) {
        const audioUrl = await createTTSMessage(tts.text, ttsClient, tts.model);
        if (audioUrl) {
            await message.send(format(Audio(audioUrl)));
        }
    }
};
const sendReplyMessages = async (replyMessages, e, cfg, message) => {
    for (let i = 0; i < replyMessages.length; i++) {
        const { text, images, at } = replyMessages[i];
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
    const replyMessages = newText.split(new RegExp(`${cfg.botName}:`, "g"));
    const replyMessagesResult = [];
    const ttsMessages = [];
    const nextCommands = [];
    const atTargets = [];
    for (let replyMessage of replyMessages) {
        if (replyMessage.trim() === "" || replyMessage.trim() === "[]") {
            continue;
        }
        replyMessage = replyMessage.trim();
        const imgUrls = extractImages(replyMessage);
        const messageAtTargets = [];
        await handleAffection(replyMessage, e);
        extractCommands(replyMessage, nextCommands);
        await handleRevoke(replyMessage, message);
        extractAt(replyMessage, messageAtTargets);
        atTargets.push(...messageAtTargets);
        extractTTS(replyMessage, ttsMessages);
        const cleanText = cleanMessage(replyMessage);
        replyMessagesResult.push({
            text: cleanText,
            images: imgUrls,
            at: messageAtTargets,
        });
    }
    return {
        replyMessages: replyMessagesResult,
        ttsMessages,
        nextCommands,
        atTargets,
    };
};
const sendAIReplyToOutput = sendParsedReplyToCustomOutput;

export { handleTTS, parseAIReply, sendAIReplyToOutput, sendReplyMessages };
