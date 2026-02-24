import {
  clearAIChatHistory,
  getAIConfig,
  getAIList,
  getPromptList,
} from "@src/config";
import { Text, useMessage } from "alemonjs";
import { Regular } from "alemonjs/utils";
export const selects = onSelects(["message.create", "private.message.create"]);

const regular$1 = /(\/|#)(ai配置|当前提示词|查看提示词)?$/i;
const regular$2 = /(\/|#)ai列表$/i;
const regular$3 = /(\/|#)提示词列表$/i;
const regular$4 = /(\/|#)清空对话$/i;
const regular$5 = /(\/|#)清空(所有|全部)对话$/i;

const get = /(\/|#)get (.+)$/i;

export const regular = Regular.or(
  regular$1,
  regular$2,
  regular$3,
  regular$4,
  regular$5,
  get,
);

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

  // 清空所有对话
  if (regular$5.test(e.msg) && e.IsMaster) {
    await clearAIChatHistory();
    message.send(format(Text("所有对话已清空")));
  }

  // get请求一个地址
  if (get.test(e.msg)) {
    const match = e.msg.match(get);
    if (!match) {
      message.send(format(Text("格式错误，请按照 格式：/get <url> 进行请求")));
      return;
    }
    const [, , url] = match;
    try {
      const res = await fetch(url);
      const text = await res.text();
      message.send(format(Text(`GET ${url} 的响应：\n${text}`)));
    } catch (error) {
      message.send(format(Text(`请求 ${url} 失败：${error}`)));
    }
  }

  next();
});
