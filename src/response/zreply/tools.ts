import {
  format,
  Text,
  Mention,
  ImageFile,
  ImageURL,
} from "alemonjs";

import redisClient from "@src/config";

import { uploadImageToR2 } from "@src/s3";
import { imageReview } from "@src/api/review";
import errorimg from "@src/assets/error.png";

export const removeThinkContent = (text: string) => {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think\s*>/gi, "");
};

const extractImages = (text: string) => {
  const regex = /<img=(.*?)>/g;
  const regex2 = /!\[[^\]]+\]\(([^)]+)\)/g;
  const result: string[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    result.push(match[1].trim().replace(/\\/g, "/"));
  }

  while ((match = regex2.exec(text)) !== null) {
    result.push(match[1].trim());
  }

  return result;
};

const handleAffection = async (text: string, e: any) => {
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

const handleRevoke = async (text: string, message: any) => {
  const regex = /<revoke=(.*?)>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    await message.delete({ messageId: match[1].trim() });
  }
};

const cleanMessage = (text: string) => {
  return text
    .replace(/<img=(.*?)>/g, "")
    .replace(/<command=(.*?)>/g, "")
    .replace(/<revoke=(.*?)>/g, "")
    .replace(/<at=(.*?)>/g, "")
    .replace(/!\[[^\]]+\]\([^\)]+\)/g, "")
    .trim();
};

const extractAt = (text: string, list: string[]) => {
  const regex = /<at=(.*?)>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    list.push(match[1].trim());
  }
};

const processImage = async (img: string, e: any, cfg: any) => {
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
    } catch {}
  }

  return finalImg;
};

const extractCommands = (text: string, list: string[]) => {
  const regex = /<command=(.*?)>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    list.push(match[1].trim());
  }
};

export const sendReplyMessages = async (
  replyMessages: any[],
  e: any,
  cfg: any,
  message: any,
) => {
  for (let i = 0; i < replyMessages.length; i++) {
    const { text, images, at } = replyMessages[i];

    const components: any[] = i === 0 ? [Mention(e.UserId)] : [];
    components.push(Text(text));

    for (const img of images) {
      let finalImg = await processImage(img, e, cfg);

      if (finalImg) {
        components.push(
          /^https?:\/\//.test(finalImg)
            ? ImageURL(finalImg)
            : ImageFile(finalImg),
        );
      } else {
        components.push(ImageFile(errorimg));
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

const sendParsedReplyToCustomOutput = async (message: any, aireply: any) => {
  if (typeof message?.sendAIReply !== "function") return false;
  await message.sendAIReply(aireply);
  return true;
};

export const parseAIReply = async (
  newText: string,
  cfg: any,
  e: any,
  message: any,
) => {
  const visibleText = removeThinkContent(newText);
  const replyMessages = visibleText.split(new RegExp(`${cfg.botName}:`, "g"));

  const replyMessagesResult: any[] = [];
  const nextCommands: string[] = [];
  const atTargets: string[] = [];

  for (let replyMessage of replyMessages) {
    if (replyMessage.trim() === "" || replyMessage.trim() === "[]") {
      continue;
    }
    replyMessage = replyMessage.trim();
    const imgUrls = extractImages(replyMessage);
    const messageAtTargets: string[] = [];
    await handleAffection(replyMessage, e);
    extractCommands(replyMessage, nextCommands);
    await handleRevoke(replyMessage, message);
    extractAt(replyMessage, messageAtTargets);
    atTargets.push(...messageAtTargets);

    const cleanText = cleanMessage(replyMessage);

    replyMessagesResult.push({
      text: cleanText,
      images: imgUrls,
      at: messageAtTargets,
    });
  }

  return {
    replyMessages: replyMessagesResult,
    nextCommands,
    atTargets,
  };
};

export const sendAIReplyToOutput = sendParsedReplyToCustomOutput;
