import { Image } from "alemonjs";
import { useMessage } from "@src/utils/command-message";
import { renderComponentIsHtmlToBuffer } from "jsxp";
import SystemStatus from "@src/image/conponent/SystemStatus";
import { collectSystemStatus } from "@src/utils/system-status";
import redisClient from "@src/config";

export const selects = onSelects(["message.create", "private.message.create"]);

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

const resolveBot = (event: any) => {
  const botId = String(
    event.bot?.user_id ?? event.self_id ?? event.BotId ?? "",
  );
  const platformAvatar = firstString(
    event.bot?.avatar,
    event.bot?.avatar_url,
    event.bot?.avatarUrl,
    event.value?.toUser?.avatar,
    event.value?.toUser?.avatarUrl,
  );

  return {
    nickname: firstString(event.bot?.nickname, event.bot?.name) || "机器人",
    avatar:
      platformAvatar ||
      (event.Platform === "onebot" && botId
        ? `https://q1.qlogo.cn/g?b=qq&s=640&nk=${encodeURIComponent(botId)}`
        : undefined),
  };
};

export default onResponse(selects, async (event) => {
  const [message] = useMessage(event);
  const [status, scale] = await Promise.all([
    collectSystemStatus(),
    redisClient.getRenderPrecision(event.guid),
  ]);
  const img = await renderComponentIsHtmlToBuffer(
    SystemStatus,
    { bot: resolveBot(event), status },
    {
      screenshot: {
        type: "jpeg",
        quality: 85,
      } as any,
      playwright: {
        context: { deviceScaleFactor: scale },
      },
    },
  );

  if (img) await message.send(format(Image(img)));
});
