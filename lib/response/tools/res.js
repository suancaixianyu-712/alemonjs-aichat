import { getConfigValue, useMessage, Text, ImageURL, Image, Mention, Video, Audio } from 'alemonjs';
import OpenAi from 'openai';
import { availableTools } from '../../api/aitools.js';
import { TTSClient } from '../../api/tts.js';
import redisClient from '../../config.js';
import { imageReview } from '../../api/review.js';
import { uploadImageToR2 } from '../../s3.js';
import { createTTSMessage } from '../zreply/tts.js';

const selects = onSelects(["message.create", "private.message.create"]);
// inline regex will be used directly in condition checks
var res = onResponse(selects, async (e) => {
    const configValue = getConfigValue().aiChat || {};
    // 创建
    const [message] = useMessage(e);
    // p图
    if (/(\/|#)(ai)?(pt|p图|ps|修图)(.*)$/i.test(e.msg)) {
        const match = e.msg.match(/(\/|#)(ai)?(pt|p图|ps|修图)(.*)$/i);
        const [, , , , content] = match;
        if (!content.trim()) {
            message.send(format(Text("请提供修图内容，例如：\n#修图 换个背景")));
            return;
        }
        const imgs = [];
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
        // 将图片上传到R2,避免图片被风控或者过期无法访问
        const uploadedImgUrls = imgs.map(async (url) => await uploadImageToR2(url.replace("https://imgen.x.ai", configValue.xaiImgProxy || "https://imgen.x.ai")));
        message.send(format(Text("开始修图喵~")));
        const res = await availableTools.Photoshop({
            image_url: await Promise.all(uploadedImgUrls),
            instruction: content,
        });
        if (res && typeof res === "object" && res.length > 0) {
            const imgUrl = res[0].url.replace("https://imgen.x.ai", configValue.xaiImgProxy || "https://imgen.x.ai");
            const R18Switch = await redisClient.getR18Switch(e.guid);
            if (R18Switch === "1") {
                message.send(format(Text("修图完成喵~"), ImageURL(imgUrl)));
                return;
            }
            const reviewRes = await imageReview(await uploadImageToR2(imgUrl));
            if (reviewRes && reviewRes.conclusion === "不合规") {
                message.send(format(Text("你又再骗我画涩图了喵~已经保存到主人的收藏夹了，不给你看，哼!~")));
            }
            else {
                message.send(format(Text("画图完成喵~\n"), Text(content), Image(imgUrl)));
            }
            await redisClient.addImgUrl(e.guid, imgUrl);
        }
        else {
            try {
                const json = JSON.parse(res);
                console.log("res", json);
                message.send(format(Text(json.error)));
            }
            catch (error) {
                message.send(format(Text("修图报错了喵~:" + res)));
            }
        }
    }
    // 画图
    if (/(\/|#)(ai)?(画图)(.*)$/i.test(e.msg)) {
        const match = e.msg.match(/(\/|#)(ai)?(画图)(.*)$/i);
        const [, , , , content] = match;
        if (!content.trim()) {
            message.send(format(Text("请提供画图内容，例如：\n#画图 画一只猫")));
            return;
        }
        message.send(format(Text("开始画图喵~")));
        const promptOptimization = await redisClient.getPromptOptimization(e.guid);
        const aiConfig = await redisClient.getAIConfig(e.guid);
        const R18Switch = await redisClient.getR18Switch(e.guid);
        const renderImage = async (prompt) => {
            const res = await availableTools.StableDiffusionGenerateImage({
                prompt,
                base64: true,
            });
            if (!res || !Array.isArray(res) || res.length === 0) {
                return false;
            }
            const imgItem = res[0];
            if (R18Switch === "1") {
                message.send(format(Text("画图完成喵~\n"), Text(prompt), Image(imgItem)));
                return true;
            }
            const reviewRes = await imageReview(imgItem);
            if (reviewRes && reviewRes.conclusion === "不合规") {
                message.send(format(Text("你又再骗我画涩图了喵~已经保存到主人的收藏夹了，不给你看，哼!~")));
            }
            else {
                message.send(format(Text("画图完成喵~\n"), Text(prompt), Image(imgItem)));
            }
            const imgUrl = await uploadImageToR2(imgItem);
            await redisClient.addImgUrl(e.guid, imgUrl);
            return true;
        };
        if (promptOptimization === "1" && aiConfig) {
            message.send(format(Text("正在优化提示词喵~")));
            try {
                const openai = new OpenAi({
                    baseURL: aiConfig.host,
                    apiKey: aiConfig.key,
                    timeout: 300000,
                });
                const response = await openai.chat.completions.create({
                    model: aiConfig.model,
                    messages: [
                        {
                            role: "system",
                            content: "你是一个sd画图助手，协助用户将文字描述转换为提示词。描述中会出现一些动漫或游戏角色的名字, 请使用他们的英文名作为提示词, 请直接输出翻译后的提示词",
                        },
                        { role: "user", content },
                    ],
                });
                const optimizedPrompt = response.choices[0].message?.content?.trim();
                if (optimizedPrompt) {
                    if (await renderImage(optimizedPrompt)) {
                        return;
                    }
                }
            }
            catch (error) {
                console.error("优化提示词失败:", error);
            }
        }
        if (await renderImage(content)) {
            return;
        }
        message.send(format(Text("画图失败了喵~")));
    }
    // GPT 画图配置必须先于普通画图处理，避免被“gpt画图”前缀吞掉
    if (/^(\/|#)gpt画图配置(?:\s+[\s\S]*)?$/i.test(e.msg)) {
        const match = e.msg.match(/^(\/|#)gpt画图配置\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i);
        if (!match) {
            message.send(format(Text("格式错误，请按照格式：\n#gpt画图配置 <主机地址> <api_key> <模型>")));
            return;
        }
        const [, , host, key, model] = match;
        await redisClient.setGPTImageConfig(host, key, model);
        message.send(format(Text(`GPT 画图配置已更新！\n主机: ${host}\n模型: ${model}`)));
        return;
    }
    // gpt画图：“画图”后必须是空白或结束，不匹配“gpt画图配置”
    if (/^(\/|#)gpt画图(?:\s+[\s\S]*)?$/i.test(e.msg)) {
        const match = e.msg.match(/^(\/|#)gpt画图(?:\s+([\s\S]*))?$/i);
        const content = match?.[2] || "";
        if (!content.trim()) {
            message.send(format(Text("请提供画图内容，例如：\n#gpt画图 画一只猫")));
            return;
        }
        message.send(format(Text("开始用 GPT 画图喵~")));
        const R18Switch = await redisClient.getR18Switch(e.guid);
        const res = await availableTools.GPTGenerateImage({
            prompt: content.trim(),
        });
        if (res && Array.isArray(res) && res.length > 0) {
            const imgItem = res[0];
            const imgUrl = typeof imgItem === 'string' ? imgItem : imgItem.url;
            let r2Url = imgUrl;
            try {
                r2Url = await uploadImageToR2(imgUrl);
            }
            catch (err) {
                console.error("GPT画图上传R2失败:", err);
            }
            if (R18Switch === "1") {
                message.send(format(Text("画图完成喵~\n"), Text(content), ImageURL(r2Url)));
            }
            else {
                const reviewRes = await imageReview(r2Url);
                if (reviewRes && reviewRes.conclusion === "不合规") {
                    message.send(format(Text("你又再骗我画涩图了喵~已经保存到主人的收藏夹了，不给你看，哼!~")));
                }
                else {
                    message.send(format(Text("画图完成喵~\n"), Text(content), ImageURL(r2Url)));
                }
            }
            await redisClient.addImgUrl(e.guid, r2Url);
        }
        else {
            message.send(format(Text("GPT 画图失败了喵~\n" + (typeof res === "string" ? res : JSON.stringify(res)))));
        }
    }
    // 生成视频
    if (/(\/|#)(ai)?(生成视频)(.*)$/i.test(e.msg)) {
        const match = e.msg.match(/(\/|#)(ai)?(生成视频)(.*)$/i);
        const [, , , , content] = match;
        if (!content.trim()) {
            message.send(format(Text("请提供生成视频内容，例如：\n#生成视频 一个小猫娘玩毛线球")));
            return;
        }
        message.send(format(Text("开始生成视频喵~")));
        const imgs = [];
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
            message.send(format(Text("视频生成中喵~"), Text(`请求ID: ${request_id}`)));
            let videoUrl = "";
            for (let i = 0; i < 20; i++) {
                await new Promise((resolve) => setTimeout(resolve, 3000));
                const videoRes = await availableTools.AIVideoResult({ request_id });
                if (videoRes &&
                    typeof videoRes === "object" &&
                    videoRes.status &&
                    videoRes.status === "done") {
                    videoUrl = videoRes.video.url;
                    break;
                }
            }
            if (videoUrl) {
                message.send(format(Mention(e.UserId), Text("视频生成完成喵~"), Text(videoUrl), Video(videoUrl)));
            }
            else {
                message.send(format(Mention(e.UserId), Text("视频生成失败了喵~")));
            }
        }
        else {
            message.send(format(Mention(e.UserId), Text(res)));
        }
    }
    // 查询
    if (/(\/|#)(ai)?(查询)(.*)$/i.test(e.msg)) {
        const match = e.msg.match(/(\/|#)(ai)?(查询)(.*)$/i);
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
            if (videoRes &&
                typeof videoRes === "object" &&
                videoRes.status &&
                videoRes.status === "done") {
                videoUrl = videoRes.video.url;
                break;
            }
        }
        if (videoUrl) {
            message.send(format(Mention(e.UserId), Text("查询完成喵~"), Text(videoUrl), Video(videoUrl)));
        }
        else {
            message.send(format(Mention(e.UserId), Text("查询失败了喵~")));
        }
    }
    // 开启/关闭画图提示词优化
    if (/(\/|#)(ai)?(开启|关闭)?画图提示词优化$/i.test(e.msg)) {
        const match = e.msg.match(/(\/|#)(ai)?(开启|关闭)?画图提示词优化$/i);
        const [, , , action] = match;
        const aiConfig = await redisClient.getAIConfig(e.guid);
        if (!aiConfig) {
            await redisClient.setPromptOptimization(e.guid, "0");
            message.send(format(Text("请先配置AI相关信息喵~")));
            return;
        }
        if (!action.trim()) {
            message.send(format(Text("请提供操作，例如：\n#开启画图提示词优化 或 #关闭画图提示词优化")));
            return;
        }
        await redisClient.setPromptOptimization(e.guid, action === "开启" ? "1" : "0");
        message.send(format(Text(`已${action}画图提示词优化喵~`)));
    }
    // 文字合成语音
    if (/^(\/|#)(.+)说([\s\S]*)$/i.test(e.msg)) {
        const match = e.msg.match(/^(\/|#)(.+)说([\s\S]*)$/i);
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
        const audioUrl = await createTTSMessage(content, ttsclient, `${speaker}-默认`);
        if (audioUrl !== "") {
            await message.send(format(Audio(audioUrl)));
        }
    }
    // 安装语音模型
    if (/^(\/|#)安装语音(模型)?(.+)$/i.test(e.msg)) {
        const match = e.msg.match(/^(\/|#)安装语音(模型)?(.+)$/i);
        const [, , , model] = match;
        console.log("model", model);
        if (!model.trim()) {
            message.send(format(Text("请提供要安装的语音模型，例如：\n#安装语音模型 霓裳")));
            return;
        }
        const ttsclient = new TTSClient();
        const res = await ttsclient.installModel(model);
        if (res.success) {
            message.send(format(Text(`语音模型${model}安装成功喵~`)));
        }
        else {
            message.send(format(Text(`语音模型${model}安装失败了喵~\n原因：${res.message}`)));
        }
    }
    // 看魔法
    if (/^(\/|#)看魔法$/i.test(e.msg)) {
        const imgs = [];
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

export { res as default, selects };
