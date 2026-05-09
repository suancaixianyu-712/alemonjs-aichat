import redisClient from "@src/config";
import AiConfig from "@src/image/conponent/AiConfig";
import { Text, useMessage, Image } from "alemonjs";
import { renderComponentIsHtmlToBuffer } from "jsxp";
import OpenAi from "openai";
export const selects = onSelects(["message.create", "private.message.create"]);

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
    const toolList = await redisClient.getAllToolStatus(e.guid);
    const toolPromptSwitch = await redisClient.getToolPromptSwitch(e.guid); // 工具提示开关
    const toolPromptRevokeSwitch = await redisClient.getToolPromptRevokeSwitch(
      e.guid,
    ); // 工具提示撤回开关
    const toolPromptArgsSwitch = await redisClient.getToolPromptArgsSwitch(
      e.guid,
    ); // 工具提示传参开关

    // 发送消息

    try {
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
        toolList: toolList,
        toolPromptSwitch: toolPromptSwitch == "1",
        toolPromptRevokeSwitch: toolPromptRevokeSwitch == "1",
        toolPromptArgsSwitch: toolPromptArgsSwitch == "1",
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
    } catch (error) {
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
    await redisClient.deleteSessionId(e.guid);
    message.send(format(Text("对话已清空")));
  }

  // 清空所有对话
  if (/^(\/|#)清空(所有|全部)对话$/i.test(e.msg) && e.IsMaster) {
    await redisClient.clearAIChatHistory();
    message.send(format(Text("所有对话已清空")));
  }

  // get请求一个地址
  if (/^(\/|#)get (.+)$/i.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)get (.+)$/i);
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

  // 新对话
  if (/(\/|#)(开启)?(new|新对话|新会话)$/i.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)(开启)?(new|新对话|新会话)$/i);
    if (!match) {
      message.send(format(Text("格式错误，请按照 格式：/new 进行开启新对话")));
      return;
    }

    // 压缩当前对话的上下文
    const aiConfig = await redisClient.getAIConfig(e.guid);
    if (aiConfig.model) {
      // 让ai总结当前聊天内容, 将其存储到redis中作为历史对话的一部分
      const openai = new OpenAi({
        baseURL: aiConfig.host,
        apiKey: aiConfig.key,
        timeout: 300000,
      });
      const history = await redisClient.getAIChatHistory(e.guid);
      const FilingID = Date.now();

      const summaryPrompt = `system:请总结一下我们之前的聊天内容，要求总结内容能够涵盖之前聊天的主要信息和细节，字数控制在200字以内。总结内容将被用作未来对话的上下文，请确保总结内容的准确性和完整性。请务必按照特定格式总总结, 格式如下

归档ID:${FilingID}
摘要:<简单描述>
详细信息:<详细描述>

归档id为框架生成
其中摘要部分要求简洁明了, 详细信息部分要求尽可能全面地涵盖之前聊天的内容, 包括重要的细节和信息点。请确保总结内容能够准确反映之前的聊天内容, 并且格式正确，以便我们在未来的对话中能够正确地使用这些总结内容。`;
      const messages = [
        ...history,
        {
          role: "user",
          content: summaryPrompt,
        },
      ];

      console.log("messages", messages);

      try {
        const response = await openai.chat.completions.create({
          model: aiConfig.model,
          messages,
          stream: false,
        });
        const summary = response.choices[0].message.content;
        if (summary) {
          const AbstractMatch = summary.match(/摘要:(.*)详细信息:/s);
          const DetailMatch = summary.match(/详细信息:(.*)/s);
          const Abstract = AbstractMatch ? AbstractMatch[1].trim() : "无摘要";
          const Detail = DetailMatch ? DetailMatch[1].trim() : "无详细信息";
          await redisClient.setSummary(e.guid, FilingID.toString(), Abstract);
          await redisClient.setSummaryDetail(
            e.guid,
            FilingID.toString(),
            Detail,
          );
          await redisClient.clearAIChatHistory(e.guid);
          await redisClient.addAIChatHistory(e.guid, {
            role: "user",
            content: `system:上一轮对话小结：${Abstract}\n详细信息：${Detail}`,
          });
          message.send(format(Text("已开启新对话")));
        }
      } catch (error) {
        console.error("对话总结失败：", error);
        message.send(
          format(Text("新对话开启失败"), Text(`\n报错内容：${error}`)),
        );
      }
    } else {
      message.send(format(Text("当前无可用的AI配置，请先设置AI配置")));
    }
  }

  next();
});
