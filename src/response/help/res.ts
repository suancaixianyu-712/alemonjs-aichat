import { Image, Text, useMessage } from "alemonjs";
import { renderComponentIsHtmlToBuffer } from "jsxp";
import Help from "@src/image/conponent/help";
import redisClient from "@src/config";

export const selects = onSelects(["message.create", "private.message.create"]);
export default onResponse(selects, async (e) => {
  // 创建
  const [message] = useMessage(e);
  const scale = await redisClient.getRenderPrecision(e.guid);
  const img = await renderComponentIsHtmlToBuffer(Help, {}, {
    screenshot: {
      type: "jpeg",
      quality: 80,
    },
    playwright: {
      context: { deviceScaleFactor: scale },
    },
  });
  if (img) message.send(format(Image(img)));
  const config = await redisClient.getAIConfig(e.guid);
  if (
    config.host.trim() === "" ||
    config.key.trim() === "" ||
    config.model.trim() === ""
  ) {
    message.send(
      format(Text("当前配置不完整，请使用 /切换ai 指令切换到可用的配置")),
    );
  }

  return;
});
