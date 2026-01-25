import { getAIConfig } from "@src/config";
import { Image, Text, useMessage } from "alemonjs";
import { renderComponentToBuffer } from "jsxp";
import Help from "@src/image/conponent/help";

export const selects = onSelects(["message.create", "private.message.create"]);

export const regular = /(\/|#)(ai)?(指令|帮助|菜单|功能)$/i;

export default onResponse(selects, async (e) => {
  // 创建
  const [message] = useMessage(e);
  const img = await renderComponentToBuffer("help", Help, {});
  if (img) message.send(format(Image(img)));
  const config = await getAIConfig(e.guid);
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
