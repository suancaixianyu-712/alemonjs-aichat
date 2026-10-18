import { Image, Text } from "alemonjs";
import { useMessage } from "@src/utils/command-message";
import { renderComponentIsHtmlToBuffer } from "jsxp";
import Help from "@src/image/conponent/help";
import redisClient from "@src/config";
import {
  getHelpText,
  getHelpView,
  HELP_COMMAND_PATTERN,
} from "@src/utils/help-menu";

export const selects = onSelects(["message.create", "private.message.create"]);
export default onResponse(selects, async (e) => {
  const [message] = useMessage(e);
  const send = async (item: ReturnType<typeof Text> | ReturnType<typeof Image>) => {
    const results = await message.send(format(item));
    for (const result of results ?? []) {
      if (result.code !== 2000) {
        logger.warn({ message: "帮助菜单发送失败", result });
      }
    }
  };
  const command = String(e.MessageText || e.msg || "").trim();
  const view = getHelpView(command.match(HELP_COMMAND_PATTERN)?.[1]);
  if (view.kind === "error") {
    await send(Text(view.message));
    return;
  }

  const scale = await redisClient.getRenderPrecision(e.guid);
  let img: Buffer | null = null;
  try {
    img = await renderComponentIsHtmlToBuffer(Help, { view }, {
      screenshot: {
        type: "jpeg",
        quality: 80,
        encoding: "base64",
      },
      playwright: {
        context: { deviceScaleFactor: scale },
      },
    });
  } catch (error) {
    logger.error({ message: "帮助菜单渲染失败", error });
  }
  await send(img ? Image(img) : Text(getHelpText(view)));

  if (view.kind !== "home") return;
  const config = await redisClient.getAIConfig(e.guid);
  if (
    config.host.trim() === "" ||
    config.key.trim() === "" ||
    config.model.trim() === ""
  ) {
    await send(Text("当前配置不完整，请使用 #切换AI 指令切换到可用的配置"));
  }

  return;
});
