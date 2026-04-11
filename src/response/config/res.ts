import redisClient from "@src/config";
import AiConfig from "@src/image/conponent/AiConfig";
import { Text, useMessage, Image } from "alemonjs";
import { renderComponentIsHtmlToBuffer } from "jsxp";
export const selects = onSelects(["message.create", "private.message.create"]);

// inline regex used directly in condition checks
const get = /^(\/|#)get (.+)$/i;

export default onResponse(selects, async (e, next) => {
  // 创建
  const [message] = useMessage(e);
  const config = await redisClient.getAIConfig(e.guid);

  // 查看AI配置
  if (/^(\/|#)(ai配置|当前提示词|查看提示词)$/i.test(e.msg)) {
    const complexResponse = (await redisClient.getComplexOutput(e.guid)) || "1"; // 复杂输出
    const affectionIsOpen = await redisClient.getAffectionSwitch(e.guid); // 好感度开关
    const isOpenTTSReply = await redisClient.getTTSResponseSwitch(e.guid); // TTS回复开关
    const toolsIsOpen = await redisClient.getToolSwitch(e.guid); // 工具开关
    const deepThinkingIsOpen = await redisClient.getDeepThoughtSwitch(e.guid); // 深度思考开关
    const atTriggerSwitch = await redisClient.getAtTriggerSwitch(e.guid); // 仅艾特触发
    const currentAI = await redisClient.getCurrentAI(e.guid); // 当前AI名称
    const aiList = await redisClient.getAIList();

    // 发送消息

    const img = await renderComponentIsHtmlToBuffer(AiConfig, {
      switch: config.model != "",
      tools: toolsIsOpen == "1",
      complex: complexResponse == "1",
      affection: affectionIsOpen == "1",
      tts: isOpenTTSReply == "1",
      deep: deepThinkingIsOpen == "1",
      model: config.model,
      prompt: config.systemPrompt,
      atTrigger: atTriggerSwitch == "1",
      aiList: aiList,
      currentAI: currentAI,
    });
    if (img) {
      message.send(format(Image(img)));
    } else {
      message.send(
        format(
          Text(`当前AI配置：\n`),
          Text(`总开关: ${config.model != "" ? "开启" : "关闭"}\n`),
          Text(`工具: ${toolsIsOpen == "1" ? "开启" : "关闭"}\n`),
          Text(`复杂输出: ${complexResponse == "1" ? "开启" : "关闭"}\n`),
          Text(`好感度开关: ${affectionIsOpen == "1" ? "开启" : "关闭"}\n`),
          Text(`TTS回复开关: ${isOpenTTSReply == "1" ? "开启" : "关闭"}\n`),
          Text(`深度思考: ${deepThinkingIsOpen == "1" ? "默认" : "关闭"}\n`),
          Text(`仅艾特触发: ${atTriggerSwitch == "1" ? "开启" : "关闭"}\n`),
          Text(`模型: ${config.model || "未设置"}\n`),
          Text(`提示词: ${config.systemPrompt || "未设置"}\n`),
          Text(`当前AI: ${currentAI || "未设置"}\n`),
          Text(`AI数量: ${aiList.length ? aiList.length : "暂无AI配置"}`),
        ),
      );
    }
  }

  // 查看AI列表
  if (/^(\/|#)ai列表$/i.test(e.msg)) {
    const ailist = await redisClient.getAIList();
    message.send(
      format(
        Text("当前AI列表：\n"),
        Text(ailist.length ? ailist.join("\n") : "暂无AI配置"),
      ),
    );
  }

  // 查看提示词列表
  if (/^(\/|#)提示词列表$/i.test(e.msg)) {
    const prompts = await redisClient.getPromptList();
    message.send(
      format(
        Text("当前提示词列表：\n"),
        Text(prompts.length ? prompts.join("\n") : "暂无提示词"),
      ),
    );
  }

  // 清空对话
  if (/^(\/|#)清空对话$/i.test(e.msg)) {
    await redisClient.clearAIChatHistory(e.guid);
    message.send(format(Text("对话已清空")));
  }

  // 清空所有对话
  if (/^(\/|#)清空(所有|全部)对话$/i.test(e.msg) && e.IsMaster) {
    await redisClient.clearAIChatHistory();
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
