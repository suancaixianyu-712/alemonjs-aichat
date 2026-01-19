import { getAIConfig } from "@src/config";
import { Text, useMessage } from "alemonjs";
export const selects = onSelects(["message.create", "private.message.create"]);

const regular$1 = /(\/|#)(ai)(指令|帮助|菜单|功能)$/i;

export const regular = /.*/;

export default onResponse(selects, async (e, next) => {
  // 创建
  const [message] = useMessage(e);

  // 查看指令帮助
  if (regular$1.test(e.msg)) {
    message.send(
      format(
        Text("当前支持的指令有：\n"),
        Text("/ai配置 - 查看当前AI配置\n"),
        Text("/ai列表 - 查看当前AI列表\n"),
        Text("/切换ai - 切换AI\n"),
        Text("/提示词列表 - 查看当前提示词列表\n"),
        Text("/添加提示词 - 添加新的设定\n"),
        Text("/清空对话 - 清空与AI的对话记录\n"),
        Text("/好感度 - 查看当前用户的好感度\n"),
      ),
    );

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
  }

  next();
});
