import redisClient from "@src/config";
import { CApiReply } from "@src/response/zreply/capi";

export const PANEL_BOT_ID = "aichatbot";
export const PANEL_DEFAULT_USER_ID = "webuser";

export type PanelChatMessage = {
  from: "user" | "bot" | "system";
  name: string;
  text: string;
  time: string;
  images?: string[];
  at?: string[];
};

export type PanelChatIdentity = {
  guid: string;
  userId: string;
  nickname: string;
  botId: string;
};

const PANEL_IMAGE_HIDDEN_TEXT = "图片已隐藏，图床已关闭";

export type PanelChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "clear" }
  | { type: "message"; message: PanelChatMessage }
  | { type: "replace"; message: PanelChatMessage }
  | { type: "error"; message: string }
  | { type: "done" };

const PANEL_CHAT_HISTORY_LIMIT = 80;
const PANEL_IMAGE_TOOL_NAMES = new Set([
  "StableDiffusionGenerateImage",
  "GPTGenerateImage",
  "Photoshop",
  "AgentUploadFileToR2",
]);

const withTimeout = async <T,>(
  promise: Promise<T>,
  fallback: T,
  ms = 800,
): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]).catch(() => fallback);

const normalizeIdentityValue = (value: string | undefined, fallback: string) => {
  const normalized = String(value || "").trim();
  return normalized || fallback;
};

const getCurrentPanelGuid = async () => {
  const keys = await withTimeout(redisClient.redis.keys("ai:currentAI:*"), []);
  const firstKey = keys[0];
  return firstKey ? firstKey.replace("ai:currentAI:", "") || "global" : "global";
};

export const resolvePanelChatIdentity = async (
  guid?: string,
  userId?: string,
  nickname?: string,
): Promise<PanelChatIdentity> => ({
  guid: normalizeIdentityValue(guid, await getCurrentPanelGuid()),
  userId: normalizeIdentityValue(userId, PANEL_DEFAULT_USER_ID),
  nickname: normalizeIdentityValue(
    nickname,
    normalizeIdentityValue(userId, PANEL_DEFAULT_USER_ID),
  ),
  botId: PANEL_BOT_ID,
});

const getPanelChatKey = (guid: string, userId: string) =>
  `ai:panel_chat:${guid}:${userId}`;

const getPanelTime = () =>
  new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export const getPanelChatMessages = async (
  guid: string,
  userId: string,
): Promise<PanelChatMessage[]> => {
  const raw = await withTimeout(
    redisClient.redis.get(getPanelChatKey(guid, userId)),
    null,
  );
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const getPanelChatMessagesForDisplay = async (
  guid: string,
  userId: string,
): Promise<PanelChatMessage[]> => {
  const messages = await getPanelChatMessages(guid, userId);
  return Promise.all(
    messages.map((message) => mapPanelMessageForDisplay(guid, message)),
  );
};

export const appendPanelChatMessages = async (
  guid: string,
  userId: string,
  messages: PanelChatMessage[],
) => {
  if (!messages.length) return;

  const current = await getPanelChatMessages(guid, userId);
  const next = [...current, ...messages].slice(-PANEL_CHAT_HISTORY_LIMIT);
  await withTimeout(
    redisClient.redis.set(getPanelChatKey(guid, userId), JSON.stringify(next)),
    "0",
  );
};

export const clearPanelChatMessages = async (guid: string, userId: string) => {
  await withTimeout(redisClient.redis.del(getPanelChatKey(guid, userId)), 0);
};

const extractFallbackText = (value: any): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractFallbackText).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    return extractFallbackText(
      value.text ?? value.content ?? value.value ?? value.data?.text ?? "",
    );
  }
  return "";
};

const normalizePanelImageUrl = (url: string) => {
  let value = String(url || "").trim().replace(/\\/g, "/");
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("data:image/")) {
    return value;
  }

  value = value.replace(/^\.?\//, "").replace(/^public\//, "");
  if (value.startsWith("image_out/")) return `/${value}`;
  if (value.startsWith("/")) return value;
  return value;
};

const uniquePanelImages = (images: string[]) => [
  ...new Set(images.map(normalizePanelImageUrl).filter(Boolean)),
];

const buildPanelImageProxyUrl = (guid: string, source: string) =>
  `/panel/image?guid=${encodeURIComponent(guid)}&source=${encodeURIComponent(source)}`;

const mapPanelMessageForDisplay = async (
  guid: string,
  message: PanelChatMessage,
): Promise<PanelChatMessage> => {
  const rawImages = uniquePanelImages(message.images || []);
  if (!rawImages.length) {
    return {
      ...message,
      images: [],
    };
  }

  const imageBedSwitch = await withTimeout(
    redisClient.getImageBedSwitch(guid),
    "1",
    800,
  );
  if (imageBedSwitch !== "1") {
    return {
      ...message,
      text:
        !message.text || message.text === "[图片]"
          ? PANEL_IMAGE_HIDDEN_TEXT
          : message.text,
      images: [],
    };
  }

  return {
    ...message,
    images: rawImages.map((image) => buildPanelImageProxyUrl(guid, image)),
  };
};

const isPanelImageUrl = (url: string) => {
  const value = String(url || "").trim().replace(/\\/g, "/");
  if (!value) return false;
  if (value.startsWith("data:image/")) return true;
  if (/^\.?\/?(public\/)?image_out\//i.test(value)) return true;
  return /^https?:\/\//i.test(value) && /\.(png|jpe?g|gif|webp|bmp|svg)([?#].*)?$/i.test(value);
};

const shouldCollectToolImages = (functionName: string, payload: any) => {
  if (!PANEL_IMAGE_TOOL_NAMES.has(functionName)) return false;
  if (functionName === "AgentUploadFileToR2") {
    return payload?.uploadType === "image";
  }
  return true;
};

const extractPanelImagesFromString = (text: string): string[] => {
  const images: string[] = [];
  if (isPanelImageUrl(text)) {
    images.push(text);
  }

  const imgTagRegex = /<img=([^>]+)>/g;
  const markdownRegex = /!\[[^\]]*]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = imgTagRegex.exec(text)) !== null) {
    images.push(match[1]);
  }

  while ((match = markdownRegex.exec(text)) !== null) {
    images.push(match[1]);
  }

  try {
    const parsed = JSON.parse(text);
    images.push(...extractPanelImages(parsed));
  } catch {}

  return uniquePanelImages(images);
};

const extractPanelImages = (value: any): string[] => {
  if (!value) return [];

  if (typeof value === "string") {
    return extractPanelImagesFromString(value);
  }

  if (Array.isArray(value)) {
    return uniquePanelImages(value.flatMap(extractPanelImages));
  }

  if (typeof value !== "object") return [];

  const directKeys = [
    "url",
    "image_url",
    "imageUrl",
    "path",
    "file",
    "sendText",
  ];
  const nestedKeys = ["data", "image", "images", "result", "results", "output"];
  const images: string[] = [];

  for (const key of directKeys) {
    images.push(...extractPanelImages(value[key]));
  }

  for (const key of nestedKeys) {
    images.push(...extractPanelImages(value[key]));
  }

  return uniquePanelImages(images);
};

const pushPanelMessage = (
  list: PanelChatMessage[],
  message: Omit<PanelChatMessage, "time"> & { time?: string },
) => {
  const images = uniquePanelImages(message.images || []);
  const next = {
    ...message,
    images,
    text: message.text || (images.length ? "[图片]" : ""),
    time: message.time || getPanelTime(),
  };
  list.push(next);
  return next;
};

const createPanelOutput = (
  messages: PanelChatMessage[],
  hooks?: {
    onDelta?: (text: string) => void | Promise<void>;
    onMessage?: (message: PanelChatMessage) => void | Promise<void>;
  },
) => {
  const pushedImages = new Set<string>();
  const filterNewImages = (images: string[]) => {
    const next = uniquePanelImages(images).filter((image) => {
      if (pushedImages.has(image)) return false;
      pushedImages.add(image);
      return true;
    });
    return next;
  };
  const pushOutputMessage = async (
    message: Omit<PanelChatMessage, "time"> & { time?: string },
  ) => {
    const next = pushPanelMessage(messages, message);
    await hooks?.onMessage?.(next);
    return next;
  };

  const pushToolImages = async (label: string, payload: any) => {
    const images = filterNewImages(extractPanelImages(payload));
    if (!images.length) return;

    await pushOutputMessage({
      from: "bot",
      name: PANEL_BOT_ID,
      text: label,
      images,
    });
  };

  return {
    ...(hooks?.onDelta
      ? {
          streamTextDelta: async (text: string) => {
            if (!text) return;
            await hooks.onDelta?.(text);
          },
        }
      : {}),
    sendText: async (text: string) => {
      await pushOutputMessage({
        from: "system",
        name: "系统",
        text,
      });
      return [{ data: { message_id: `web-${Date.now()}` } }];
    },
    sendAIReply: async (aireply: any) => {
      for (const item of aireply?.replyMessages || []) {
        const images = filterNewImages(item.images || []);
        if (!item.text && !images.length && !item.at?.length) continue;

        await pushOutputMessage({
          from: "bot",
          name: PANEL_BOT_ID,
          text: item.text || "",
          images,
          at: item.at || [],
        });
      }

      for (const item of aireply?.ttsMessages || []) {
        await pushOutputMessage({
          from: "bot",
          name: PANEL_BOT_ID,
          text: `[语音] ${item.text}`,
        });
      }
    },
    sendToolResult: async (functionName: string, payload: any) => {
      if (!shouldCollectToolImages(functionName, payload)) return;
      const label =
        functionName === "StableDiffusionGenerateImage" ||
        functionName === "GPTGenerateImage"
          ? "画图结果"
          : "图片结果";
      await pushToolImages(label, payload);
    },
    send: async (payload: any) => {
      const text = extractFallbackText(payload);
      const images = filterNewImages(extractPanelImages(payload));
      if (text || images.length) {
        await pushOutputMessage({
          from: "system",
          name: "系统",
          text,
          images,
        });
      }
      return [{ data: { message_id: `web-${Date.now()}` } }];
    },
    delete: async () => undefined,
  };
};

const createPanelEvent = (
  identity: PanelChatIdentity,
  message: string,
): any => ({
  name: "message.create",
  Platform: "web",
  BotId: identity.botId,
  ChannelId: identity.guid,
  UserId: identity.userId,
  UserName: identity.nickname,
  GroupName: `网页群聊 ${identity.guid}`,
  MessageText: message,
  msg: message,
  raw_message: message,
  value: {
    raw_message: message,
    message_type: "group",
    group_id: identity.guid,
    message: [{ type: "text", data: { text: message } }],
  },
  bot: {
    nickname: PANEL_BOT_ID,
    user_id: identity.botId,
  },
  nickname: identity.nickname,
  user_id: identity.userId,
  self_id: identity.botId,
  guid: identity.guid,
  uidkey: `${identity.guid}:${identity.nickname}(${identity.userId})`,
  at: [
    {
      type: "at",
      data: { qq: identity.botId, nickname: PANEL_BOT_ID },
    },
  ],
  atBot: true,
  img: [],
  originalMsg: message,
  regexTriggered: true,
  __allowLockedAI: true,
});

export const sendPanelChatMessage = async (
  guid: string,
  userId: string,
  nickname: string,
  text: string,
) => {
  const identity = await resolvePanelChatIdentity(guid, userId, nickname);
  const content = text.trim();
  const collected: PanelChatMessage[] = [];

  if (!content) {
    pushPanelMessage(collected, {
      from: "system",
      name: "系统",
      text: "消息不能为空",
    });
    await appendPanelChatMessages(identity.guid, identity.userId, collected);
    return { identity, messages: collected };
  }

  await appendPanelChatMessages(identity.guid, identity.userId, [
    {
      from: "user",
      name: identity.nickname,
      text: content,
      time: getPanelTime(),
    },
  ]);

  const aiConfig = await withTimeout(
    redisClient.getAIConfig(identity.guid),
    null,
    1200,
  );
  if (!aiConfig) {
    pushPanelMessage(collected, {
      from: "system",
      name: "系统",
      text: "Redis连接不可用，无法读取当前 guid 的 AI 配置。",
    });
    await appendPanelChatMessages(identity.guid, identity.userId, collected);
    return { identity, messages: collected };
  }

  if (!aiConfig.host.trim() || !aiConfig.key.trim() || !aiConfig.model.trim()) {
    pushPanelMessage(collected, {
      from: "system",
      name: "系统",
      text: `群号 ${identity.guid} 还没有可用 AI 配置，请先在配置页为这个 guid 切换 AI。`,
    });
    await appendPanelChatMessages(identity.guid, identity.userId, collected);
    return { identity, messages: collected };
  }

  const event = createPanelEvent(identity, content);
  const output = createPanelOutput(collected);

  try {
    await CApiReply(event, output);
  } catch (error) {
    pushPanelMessage(collected, {
      from: "system",
      name: "系统",
      text: `AI回复出错了\n${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (!collected.length) {
    pushPanelMessage(collected, {
      from: "system",
      name: "系统",
      text: "AI没有返回可显示内容",
    });
  }

  await appendPanelChatMessages(identity.guid, identity.userId, collected);
  return { identity, messages: collected };
};

export const sendPanelChatMessageStream = async (
  guid: string,
  userId: string,
  nickname: string,
  text: string,
  emit: (event: PanelChatStreamEvent) => void | Promise<void>,
) => {
  const identity = await resolvePanelChatIdentity(guid, userId, nickname);
  const content = text.trim();
  const collected: PanelChatMessage[] = [];
  let streamedText = "";
  let hasStreamedDelta = false;
  let clearedStreamMessage = false;
  let replacedStreamMessage = false;

  const clearStreamMessage = async () => {
    if (!hasStreamedDelta || clearedStreamMessage || replacedStreamMessage) {
      return;
    }

    clearedStreamMessage = true;
    await emit({ type: "clear" });
  };

  const emitMessage = async (message: PanelChatMessage) => {
    if (message.from === "bot") {
      await clearStreamMessage();
    }

    await emit({
      type: "message",
      message: await mapPanelMessageForDisplay(identity.guid, message),
    });
  };

  const pushSystemMessage = async (message: string) => {
    const item = pushPanelMessage(collected, {
      from: "system",
      name: "系统",
      text: message,
    });
    await emitMessage(item);
  };

  if (!content) {
    await pushSystemMessage("消息不能为空");
    await appendPanelChatMessages(identity.guid, identity.userId, collected);
    await emit({ type: "done" });
    return { identity, messages: collected };
  }

  await appendPanelChatMessages(identity.guid, identity.userId, [
    {
      from: "user",
      name: identity.nickname,
      text: content,
      time: getPanelTime(),
    },
  ]);

  const aiConfig = await withTimeout(
    redisClient.getAIConfig(identity.guid),
    null,
    1200,
  );
  if (!aiConfig) {
    await pushSystemMessage("Redis连接不可用，无法读取当前 guid 的 AI 配置。");
    await appendPanelChatMessages(identity.guid, identity.userId, collected);
    await emit({ type: "done" });
    return { identity, messages: collected };
  }

  if (!aiConfig.host.trim() || !aiConfig.key.trim() || !aiConfig.model.trim()) {
    await pushSystemMessage(
      `群号 ${identity.guid} 还没有可用 AI 配置，请先在配置页为这个 guid 切换 AI。`,
    );
    await appendPanelChatMessages(identity.guid, identity.userId, collected);
    await emit({ type: "done" });
    return { identity, messages: collected };
  }

  const event = createPanelEvent(identity, content);
  const output = createPanelOutput(collected, {
    onDelta: async (delta) => {
      hasStreamedDelta = true;
      streamedText += delta;
      await emit({ type: "delta", text: delta });
    },
    onMessage: emitMessage,
  });

  try {
    await CApiReply(event, output);
  } catch (error) {
    await pushSystemMessage(
      `AI回复出错了\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!collected.length && streamedText.trim()) {
    const message = pushPanelMessage(collected, {
      from: "bot",
      name: PANEL_BOT_ID,
      text: streamedText.trim(),
    });
    if (!replacedStreamMessage && !clearedStreamMessage) {
      await emit({ type: "replace", message });
      replacedStreamMessage = true;
    } else {
      await emitMessage(message);
    }
  }

  if (!collected.length) {
    await pushSystemMessage("AI没有返回可显示内容");
  }

  await appendPanelChatMessages(identity.guid, identity.userId, collected);
  await emit({ type: "done" });
  return { identity, messages: collected };
};
