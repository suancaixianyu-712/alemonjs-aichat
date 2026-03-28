import { availableTools, TTSClient } from "@src/api";
import {
  getConfigValue,
  Image,
  Text,
  ImageURL,
  useMessage,
  Video,
  Mention,
  useClient,
} from "alemonjs";
import { Regular } from "alemonjs/utils";
import OpenAi from "openai";
import { getAIConfig } from "@src/config";
import { redis } from "@src/redis";
import { API as OneBotApi } from "@alemonjs/onebot";
import { sendTTSMessage } from "../zreply/res";

export const selects = onSelects(["message.create", "private.message.create"]);
const regular$1 = /(\/|#)(ai)?(pt|p图|ps|修图)(.*)$/i;
const regular$2 = /(\/|#)(ai)?(画图)(.*)$/i;
const regular$3 = /(\/|#)(ai)?(生成视频)(.*)$/i;
const regular$4 = /(\/|#)(ai)?(查询)(.*)$/i;
const regular$5 = /(\/|#)(ai)?(开启|关闭)?画图提示词优化$/i;
const regular$6 = /^(\/|#)(.+)说([\s\S]*)$/i;
const regular$7 = /^(\/|#)安装语音(模型)?(.+)$/i;
const regular$8 = /^(\/|#)看魔法$/i;

export const regular = Regular.or(
  regular$1,
  regular$2,
  regular$3,
  regular$4,
  regular$5,
  regular$6,
  regular$7,
  regular$8,
);

export default onResponse(selects, async (e) => {
  const configValue = getConfigValue();
  // 创建
  const [message] = useMessage(e);

  // p图
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
      message.send(
        format(
          Text("修图完成喵~"),
          ImageURL(
            res[0].url.replace(
              "https://imgen.x.ai",
              configValue.xaiImgProxy || "https://imgen.x.ai",
            ),
          ),
        ),
      );
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

  // 画图
  if (regular$2.test(e.msg)) {
    const match = e.msg.match(regular$2);
    const [, , , , content] = match;
    if (!content.trim()) {
      message.send(format(Text("请提供画图内容，例如：\n#画图 画一只猫")));
      return;
    }
    message.send(format(Text("开始画图喵~")));

    const promptOptimization = await redis.get(
      `alemon:ai:prompt_optimization:${e.guid}`,
    );
    const aiConfig = await getAIConfig(e.guid);

    if (promptOptimization === "1" && aiConfig) {
      message.send(format(Text("正在优化提示词喵~")));

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
            message.send(
              format(Text("画图完成喵~\n"), Text(prompt), Image(res[0])),
            );
            return;
          }
        }
      } catch (error) {
        console.error("Error generating image:", error);
        message.send(format(Text("画图失败了喵~")));
      }
    }

    const res = await availableTools.StableDiffusionGenerateImage({
      prompt: content,
      base64: true,
    });
    if (res && typeof res === "object" && res.length > 0) {
      message.send(format(Text("画图完成喵~"), Image(res[0])));
    }
    return;
  }

  // 生成视频
  if (regular$3.test(e.msg)) {
    const match = e.msg.match(regular$3);
    const [, , , , content] = match;
    if (!content.trim()) {
      message.send(
        format(
          Text("请提供生成视频内容，例如：\n#生成视频 一个小猫娘玩毛线球"),
        ),
      );
      return;
    }
    message.send(format(Text("开始生成视频喵~")));

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

    const res = await availableTools.AIVideos({
      image_url: imgs,
      instruction: content,
    });
    console.log("res", res);
    if (res && typeof res === "object") {
      const request_id = res.data.request_id;
      message.send(
        format(Text("视频生成中喵~"), Text(`请求ID: ${request_id}`)),
      );

      let videoUrl = "";
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const videoRes = await availableTools.AIVideoResult({ request_id });
        if (
          videoRes &&
          typeof videoRes === "object" &&
          videoRes.status &&
          videoRes.status === "done"
        ) {
          videoUrl = videoRes.video.url;
          break;
        }
      }

      if (videoUrl) {
        message.send(
          format(
            Mention(e.UserId),
            Text("视频生成完成喵~"),
            Text(videoUrl),
            Video(videoUrl),
          ),
        );
      } else {
        message.send(format(Mention(e.UserId), Text("视频生成失败了喵~")));
      }
    } else {
      message.send(format(Mention(e.UserId), Text(res)));
    }
  }

  // 查询
  if (regular$4.test(e.msg)) {
    const match = e.msg.match(regular$4);
    const [, , , , content] = match;
    if (!content.trim()) {
      message.send(format(Text("请提供查询内容，例如：\n#查询 我的订单")));
      return;
    }
    message.send(format(Text("正在查询喵~")));

    let videoUrl = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const videoRes = await availableTools.AIVideoResult({
        request_id: content,
      });
      if (
        videoRes &&
        typeof videoRes === "object" &&
        videoRes.status &&
        videoRes.status === "done"
      ) {
        videoUrl = videoRes.video.url;
        break;
      }
    }

    if (videoUrl) {
      message.send(
        format(
          Mention(e.UserId),
          Text("查询完成喵~"),
          Text(videoUrl),
          Video(videoUrl),
        ),
      );
    } else {
      message.send(format(Mention(e.UserId), Text("查询失败了喵~")));
    }
  }

  // 开启/关闭画图提示词优化
  if (regular$5.test(e.msg)) {
    const match = e.msg.match(regular$5);
    const [, , , action] = match;
    const aiConfig = await getAIConfig(e.guid);
    if (!aiConfig) {
      redis.set(`alemon:ai:prompt_optimization:${e.guid}`, "0");
      message.send(format(Text("请先配置AI相关信息喵~")));
      return;
    }
    if (!action.trim()) {
      message.send(
        format(
          Text(
            "请提供操作，例如：\n#开启画图提示词优化 或 #关闭画图提示词优化",
          ),
        ),
      );
      return;
    }
    redis.set(
      `alemon:ai:prompt_optimization:${e.guid}`,
      action === "开启" ? "1" : "0",
    );
    message.send(format(Text(`已${action}画图提示词优化喵~`)));
  }

  // 文字合成语音
  if (regular$6.test(e.msg)) {
    const match = e.msg.match(regular$6);
    const [, , speaker, content] = match;
    console.log("speaker", speaker);
    console.log("content", content);

    if (!content.trim()) {
      message.send(format(Text("请提供要说的话，例如：\n#纳西妲说 你好")));
      return;
    }
    // message.send(format(Text("正在合成语音喵~")));

    if (!speaker.trim()) {
      message.send(format(Text("请提供说话人，例如：\n#纳西妲说 你好")));
      return;
    }
    const ttsclient = new TTSClient();
    sendTTSMessage(content, e, ttsclient, `${speaker}-默认`);
  }

  // 安装语音模型
  if (regular$7.test(e.msg)) {
    const match = e.msg.match(regular$7);
    const [, , , model] = match;
    console.log("model", model);
    if (!model.trim()) {
      message.send(
        format(Text("请提供要安装的语音模型，例如：\n#安装语音模型 霓裳")),
      );
      return;
    }
    const ttsclient = new TTSClient();
    const res = await ttsclient.installModel(model);
    if (res.success) {
      message.send(format(Text(`语音模型${model}安装成功喵~`)));
    } else {
      message.send(
        format(Text(`语音模型${model}安装失败了喵~\n原因：${res.message}`)),
      );
    }
  }

  // 看魔法
  if (regular$8.test(e.msg)) {
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
    if (imgs.length === 0) {
      message.send(format(Text("请回复一张图片或者发送一张图片喵~")));
      return;
    }
    const res = await availableTools.StableDiffusionImageToPrompt({
      image_url: imgs[0],
    });
    message.send(format(Text(res)));
  }
});
