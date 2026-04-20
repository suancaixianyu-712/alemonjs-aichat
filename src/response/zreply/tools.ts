import {
  format,
  Text,
  getConfigValue,
  Audio,
  Mention,
  ImageFile,
  ImageURL,
} from "alemonjs";

import redisClient from "@src/config";

import { TTSClient } from "@src/api/tts";
import { createTTSMessage } from "./tts";
import { uploadImageToR2 } from "@src/s3";
import { imageReview } from "@src/api/review";
import errorimg from "@src/assets/error.png";

let currentModel = "派蒙-默认"; // 默认音色
const value = getConfigValue().aiChat || {};

const extractImages = (text: string) => {
  const regex = /<img=(.*?)>/g;
  const result: string[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    result.push(match[1].trim().replace(/\\/g, "/"));
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

const extractTTS = (text: string, list: any[], getModel: () => string) => {
  const regex = /<(tts|音色)=([^>]+)>/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const isTTS = match[1].toLowerCase() === "tts";
    const content = match[2].trim();

    if (isTTS) {
      list.push({ text: content, model: getModel() });
    }
  }
};

const cleanMessage = (text: string) => {
  return text
    .replace(/<img=(.*?)>/g, "")
    .replace(/<(tts|音色)=([^>]+)>/gi, "")
    .replace(/<command=(.*?)>/g, "")
    .replace(/<revoke=(.*?)>/g, "")
    .replace(/<at=(.*?)>/g, "")
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

export const handleTTS = async (ttsMessages: any[], cfg: any, message: any) => {
  if (cfg.isOpenTTSReply !== "1") return;

  const ttsClient = new TTSClient();

  for (const tts of ttsMessages) {
    const audioUrl = await createTTSMessage(tts.text, ttsClient, tts.model);

    if (audioUrl) {
      await message.send(format(Audio(audioUrl)));
    }
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

export const parseAIReply = (
  newText: string,
  cfg: any,
  e: any,
  message: any,
) => {
  const replyMessages = newText
    .split(new RegExp(`${cfg.botName}:`, "g"))
    .slice(1);

  const replyMessagesResult: any[] = [];
  const ttsMessages: any[] = [];
  const nextCommands: string[] = [];
  const atTargets: string[] = [];

  let currentModel = "";

  for (const replyMessage of replyMessages) {
    const imgUrls = extractImages(replyMessage);

    handleAffection(replyMessage, e);
    extractCommands(replyMessage, nextCommands);
    handleRevoke(replyMessage, message);
    extractAt(replyMessage, atTargets);
    extractTTS(replyMessage, ttsMessages, () => currentModel);

    const cleanText = cleanMessage(replyMessage);

    replyMessagesResult.push({
      text: cleanText,
      images: imgUrls,
      at: [...atTargets],
    });
  }

  return {
    replyMessages: replyMessagesResult,
    ttsMessages,
    nextCommands,
    atTargets,
  };
};

type MessageIR =
  | { type: "text"; content: string }
  | { type: "image"; url: string }
  | { type: "audio"; text: string; voice?: string }
  | { type: "command"; value: string }
  | { type: "at"; userId: string };
export const parseAIOutput = (raw: string): MessageIR[] => {
  const result: MessageIR[] = [];

  const lines = raw.split("\n");

  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) {
      i++;
      continue;
    }

    // =========================
    // block text
    // =========================
    if (line.includes("::text<<<EOF")) {
      let content = "";
      i++;

      while (i < lines.length && !lines[i].includes("EOF")) {
        content += lines[i] + "\n";
        i++;
      }

      result.push({
        type: "text",
        content: content.trimEnd(),
      });

      i++; // skip EOF
      continue;
    }

    // =========================
    // normal line
    // =========================
    const [prefix, ...rest] = line.split("::");
    const content = rest.join("::");

    if (!content) {
      const text = line.replace(/^\w+:/, "").trim();
      if (text) result.push({ type: "text", content: text });
      i++;
      continue;
    }

    // image
    if (content.startsWith("image")) {
      result.push({
        type: "image",
        url: content.replace("image", "").trim(),
      });
      i++;
      continue;
    }

    // audio
    if (content.startsWith("audio")) {
      const match = content.match(/audio(?: voice=(\S+))?\s+(.+)/);
      if (match) {
        result.push({
          type: "audio",
          voice: match[1],
          text: match[2],
        });
      }
      i++;
      continue;
    }

    i++;
  }

  return result;
};

export const renderMessages = async (items: MessageIR[], message: any) => {
  const components: any[] = [];

  for (const item of items) {
    switch (item.type) {
      case "text":
        components.push(Text(item.content));
        break;

      case "image":
        components.push(
          item.url.startsWith("http")
            ? ImageURL(item.url)
            : ImageFile(item.url),
        );
        break;

      case "audio":
        const url = await createTTSMessage(
          item.text,
          new TTSClient(),
          item.voice || currentModel,
        );
        components.push(Audio(url));
        break;
    }
  }

  await message.send(format(...components));
};
