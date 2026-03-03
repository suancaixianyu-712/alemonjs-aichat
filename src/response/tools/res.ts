import { availableTools } from "@src/api";
import { redis } from "@src/redis";
import { getConfigValue, Image, Text, ImageURL, useMessage } from "alemonjs";
import { Regular } from "alemonjs/utils";
import OpenAi from "openai";
import { API as BubbleAPI } from "@alemonjs/bubble";
import { getAIConfig } from "@src/config";

export const selects = onSelects(["message.create", "private.message.create"]);
const regular$1 = /(\/|#)(ai)?(pt|p图|ps|修图)(.*)$/i;
const regular$2 = /(\/|#)(ai)?(画图)(.*)$/i;

export const regular = Regular.or(regular$1, regular$2);

export default onResponse(selects, async (e) => {
  const configValue = getConfigValue();
  // 创建
  const [message] = useMessage(e);
  if (regular$1.test(e.msg)) {
    const match = e.msg.match(regular$1);
    const [, , , , content] = match;
    if (!content.trim()) {
      message.send(format(Text("请提供修图内容，例如：\n#修图 换个背景")));
      return;
    }

    const imgs: string[] = [];

    if (e.reply) {
      const replyImages = e.reply.message
        .filter((item) => item.type === "image")
        .map((item) => item.data.url);
      imgs.push(...replyImages);
    }

    // 处理图片
    if (e.img && e.img.length > 0) {
      console.log("有图片");

      for (const imgUrl of e.img) {
        imgs.push(imgUrl);
      }
    }

    console.log("imgs", imgs);

    message.send(format(Text("开始修图喵~")));

    const res = await availableTools.AIPS({
      image_url: imgs,
      instruction: content,
    });

    if (res && typeof res === "object" && res.length > 0) {
      message.send(format(Text("修图完成喵~"), ImageURL(res[0].url)));
    } else {
      try {
        const json = JSON.parse(res);
        console.log("res", json);
        message.send(format(Text(json.error)));
      } catch (error) {
        message.send(format(Text("图片过于色情被和谐了喵~")));
      }
    }
  }

  if (regular$2.test(e.msg)) {
    const match = e.msg.match(regular$2);
    const [, , , , content] = match;
    if (!content.trim()) {
      message.send(format(Text("请提供画图内容，例如：\n#画图 画一只猫")));
      return;
    }
    message.send(format(Text("开始画图喵~")));

    const aiConfig = await getAIConfig(e.guid);
    if (!aiConfig) {
      const res = await availableTools.StableDiffusionGenerateImage({
        prompt: content,
        base64: true,
      });
      if (res && typeof res === "object" && res.length > 0) {
        message.send(format(Text("画图完成喵~"), Image(res[0])));
      }
      return;
    }
    const openai = new OpenAi({
      baseURL: aiConfig.host,
      apiKey: aiConfig.key,
      timeout: 300000,
    });
    try {
      const response = await openai.chat.completions.create({
        model: aiConfig.model,
        messages: [
          {
            role: "system",
            content:
              "你是一个sd画图助手，协助用户将文字描述转换为提示词。描述中会出现一些动漫或游戏角色的名字, 请使用他们的英文名作为提示词, 请直接输出翻译后的提示词",
          },
          { role: "user", content: content },
        ],
      });
      const prompt = response.choices[0].message?.content?.trim();
      console.log("prompt", prompt);

      if (prompt) {
        const res = await availableTools.StableDiffusionGenerateImage({
          prompt,
          base64: true,
        });
        if (res && typeof res === "object" && res.length > 0) {
          message.send(format(Text("画图完成喵~"), Image(res[0])));
        }
      }
    } catch (error) {
      console.error("Error generating image:", error);
      message.send(format(Text("画图失败了喵~")));
    }
  }
});
