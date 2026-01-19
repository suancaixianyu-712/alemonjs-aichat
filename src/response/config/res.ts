import {
  clearAIChatHistory,
  getAIConfig,
  getAIList,
  getPromptList,
} from "@src/config";
import { Text, useMessage } from "alemonjs";
export const selects = onSelects(["message.create", "private.message.create"]);

const regular$1 = /(\/|#)ai配置$/i;
const regular$2 = /(\/|#)ai列表$/i;
const regular$3 = /(\/|#)提示词列表$/i;
const regular$4 = /(\/|#)清空对话$/i;

export const regular = /.*/;

export default onResponse(selects, async (e, next) => {
  // 创建
  const [message] = useMessage(e);
  const config = await getAIConfig(e.guid);

  // 查看AI配置
  if (regular$1.test(e.msg)) {
    // 发送消息
    message.send(
      format(
        Text(`当前AI配置：\n`),
        Text(`模型: ${config.model}\n`),
        Text(`提示词: ${config.systemPrompt}`),
      ),
    );
  }

  // 查看AI列表
  if (regular$2.test(e.msg)) {
    const ailist = await getAIList();
    message.send(
      format(
        Text("当前AI列表：\n"),
        Text(ailist.length ? ailist.join("\n") : "暂无AI配置"),
      ),
    );
  }

  // 查看提示词列表
  if (regular$3.test(e.msg)) {
    const prompts = await getPromptList();
    message.send(
      format(
        Text("当前提示词列表：\n"),
        Text(prompts.length ? prompts.join("\n") : "暂无提示词"),
      ),
    );
  }

  // 清空对话
  if (regular$4.test(e.msg)) {
    await clearAIChatHistory(e.guid);
    message.send(format(Text("对话已清空")));
  }

  next();
});
