import { getAIConfig, getAIChatHistory, getAffectionLevelAll, incrementAffectionLevel, addAIChatHistory } from '../../config.js';
import { emojiMap } from '../../emoji.js';
import { useMessage, Text } from 'alemonjs';
import { log } from 'console';

const selects = onSelects(["message.create", "private.message.create"]);
const regular = /.*/;
var res = onResponse(selects, async (e, next) => {
    console.log("收到消息");
    // 如果是命令则跳过
    if (e.msg.startsWith("/") || e.msg.startsWith("#")) {
        next();
        return;
    }
    // 创建消息
    const [message] = useMessage(e);
    const config = await getAIConfig(e.guid);
    const messages = await getAIChatHistory(e.guid);
    const affections = await getAffectionLevelAll(e.guid);
    const imgs = [];
    let rawMessage = e.value.raw_message || e.msg;
    // 如果没有配置AI,则不处理
    if (config.host.trim() === "" ||
        config.key.trim() === "" ||
        config.model.trim() === "") {
        return;
    }
    console.log("e.reply", e.reply);
    // 处理回复图片
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
    // 处理图片链接, 转为base64格式
    // 下载图片并转换为 Base64
    // const imageBase64 = await Promise.all(
    //   imgs.map(async (imageUrl) => {
    //     try {
    //       // 下载图片到本地
    //       const response = await fetch(imageUrl);
    //       const buffer = await response.arrayBuffer();
    //       const base64 = Buffer.from(buffer).toString("base64");
    //       return `${base64}`;
    //     } catch (error) {
    //       console.error("Error downloading image:", error);
    //       return null;
    //     }
    //   }),
    // );
    // // 过滤掉下载失败的图片
    // const validImageBase64 = imageBase64.filter((base64) => base64 !== null);
    // 处理艾特
    if (e.at && e.at.length > 0) {
        console.log("有艾特");
        for (const atItem of e.at) {
            const qq = atItem.data.qq;
            const nickname = atItem.data.nickname || "未知昵称";
            const cqAt = `[CQ:at,qq=${qq}]`;
            rawMessage = rawMessage.replace(cqAt, `@${nickname}`);
        }
    }
    rawMessage = rawMessage.replace(/\[CQ:image,[^\]]+\]/g, "[图片]");
    rawMessage = rawMessage.replace(/\[CQ:reply,[^\]]+\]/g, "");
    // 处理表情,转为[emojiMap[id]]
    rawMessage = rawMessage.replace(/\[CQ:face,id=(\d+)\]/g, (_match, p1) => {
        return `[${emojiMap[p1]}]`;
    });
    const usermessage = {
        role: "user",
        content: [
            ...imgs.map((url) => ({
                type: "image_url",
                image_url: {
                    url: url,
                },
            })),
            {
                type: "text",
                text: JSON.stringify({
                    [`${e.nickname}(${getTimeString()})`]: rawMessage,
                }),
            },
        ],
    };
    // 当e.at不存在时,只给20%概率继续执行, 当e.at存在时,概率为40%,当e.atBot存在时,概率为100%
    const rand = Math.random();
    if ((!e.at && rand > 0.2) || (e.at && !e.atBot && rand > 0.4)) {
        console.log("跳过AI回复");
        return;
    }
    console.log("处理后的消息", JSON.stringify(usermessage, null, 2));
    console.log("开始回复");
    console.log("好感度列表", affections);
    // 聊天
    const res = await fetch(config.host, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.key}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages: [
                {
                    role: "system",
                    content: `你正在一个群聊中跟用户聊天,你的聊天昵称是'小咸鱼'
用户的发言方式为: [{'用户昵称(用户id)(发送时间)':回复内容}]
当该用户为主人时,昵称前面会出现[主人]标识
你的回复方式为JSON: [{assistant:回复内容}],你可以在数组中加入多条消息来模拟更真实的聊天
当然你觉得当前聊的话题确定与你有关是才回复,否则你就回复[]来表示不回复.请尽可能降低回复频率.
当你认为对方在示好或骂你时,可以在回复中加入[好感+数字]或[好感-数字]来调整与用户的好感度。
例如: [好感+1]表示增加1点好感度，[好感-1]表示减少1点好感度。你可以根据好感度来适当改变回复语气
当对方希望和好时提出道歉条件,可以给对方一个恢复的机会.
当前群时间:${getTimeString()}\n
当前用户的好感度列表如下:\n` + JSON.stringify(affections),
                },
                {
                    role: "system",
                    content: config.systemPrompt || "",
                },
                ...messages,
                { ...usermessage },
            ],
        }),
    });
    if (!res.ok) {
        // message.send(
        //   format(Text(`请求失败，状态码：${res.status}，请检查AI配置是否正确`)),
        // );
        log("请求AI失败:", res);
        return;
    }
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || "AI未返回内容";
    log("AI回复内容:", reply);
    // 提取好感变化, 使用incrementAffectionLevel更新好感
    const affectionChangeRegex = /\[好感([+-]\d+)\]/g;
    let match;
    while ((match = affectionChangeRegex.exec(reply)) !== null) {
        const change = parseInt(match[1], 10);
        console.log(`检测到好感变化: ${change}`);
        await incrementAffectionLevel(e.uidkey, change); // 更新好感度
    }
    // 记录对话
    await addAIChatHistory(e.guid, "user", JSON.stringify(usermessage.content));
    await addAIChatHistory(e.guid, "assistant", reply);
    // 解析回复内容
    try {
        // [{"assistant":"[好感+1]哼，笨蛋主人，这种馊主意也想得出来？会长那家伙肉肯定又老又柴，喵~你想吃就自己上啊，本小姐才不帮你！"}]
        const aiReplys = JSON.parse(reply);
        for (let i = 0; i < aiReplys.length; i++) {
            const aiReply = aiReplys[i];
            if (aiReply.assistant) {
                if (i > 0) {
                    // 从第二个回复开始，添加1-4秒随机延迟
                    const delay = Math.floor(Math.random() * 3000) + 1000;
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
                message.send(format(Text(aiReply.assistant.replace(/\[CQ:[^\]]+\]/, "").trim())));
            }
        }
    }
    catch (error) {
        console.log("解析AI回复失败，发送原始内容");
        message.send(format(Text(reply)));
    }
});
function getTimeString() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${hours}:${minutes}`;
}

export { res as default, regular, selects };
