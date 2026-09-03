import { useClient, useMessage, Text } from 'alemonjs';
import { API } from '@alemonjs/onebot';
import redisClient from '../config.js';
import { CApiReply } from '../response/zreply/capi.js';
import { getChatConfig, buildUserMessage } from '../response/zreply/getChatConfig.js';
import { executeAlemonCommand } from '../routes/commands.js';

const selects = onSelects(["message.create", "private.message.create"]);
const prependGuidancePrefix = (message) => ({
    ...message,
    guidance: true,
    content: Array.isArray(message?.content)
        ? message.content.map((item) => {
            if (item?.type === "text") {
                return {
                    ...item,
                    text: "[补充引导] 工具调用期间用户追加了新的消息，请结合这条消息调整后续工具调用和最终回复。\n" +
                        item.text,
                };
            }
            return item;
        })
        : message?.content,
});
const buildGuidanceMessage = async (event) => {
    const cfg = await getChatConfig(event);
    const capiMessage = prependGuidancePrefix(await buildUserMessage(event, cfg));
    return {
        guidance: true,
        capiMessage,
        createdAt: Date.now(),
        previewText: event.msg || "",
    };
};
const canPassReplyTriggerGate = async (event) => {
    if (event.UserId == event.bot?.user_id ||
        !event.msg ||
        event.msg.startsWith("/") ||
        event.msg.startsWith("#")) {
        return false;
    }
    // 聊天频率限制（每分钟最多 N 条，主人除外）
    if (event.IsMaster !== true) {
        const chatRateLimit = await redisClient.getChatRateLimit(event.guid);
        const allowed = await redisClient.checkChatRateLimit(event.guid, String(event.UserId || ""), chatRateLimit);
        if (!allowed) {
            event["rateLimited"] = true;
            return false;
        }
    }
    // 同一事件可能先后经过工具引导与普通回复判断，命中后保留事件标记，避免重复消费
    if (event["nextUserMessageSubscriptionTriggered"]) {
        return true;
    }
    const aiConfig = await redisClient.getAIConfig(event.guid);
    if (!aiConfig ||
        aiConfig.host.trim() === "" ||
        aiConfig.key.trim() === "" ||
        aiConfig.model.trim() === "") {
        return false;
    }
    if (event.name !== "private.message.create") {
        const subscriptionTriggered = await redisClient.consumeNextUserMessageSubscription(event.guid, String(event.UserId || ""), event.Platform);
        if (subscriptionTriggered) {
            event["nextUserMessageSubscriptionTriggered"] = true;
            return true;
        }
    }
    const atTriggerSwitch = await redisClient.getAtTriggerSwitch(event.ChannelId ?? event.UserId);
    if (atTriggerSwitch === "1" && event.Platform !== "testone") {
        if (!event["atBot"] && event.name !== "private.message.create") {
            const regexMatched = await redisClient.matchRegexRule(event.ChannelId ?? event.UserId, event.msg || "");
            if (regexMatched) {
                event["regexTriggered"] = true;
                return true;
            }
            return false;
        }
    }
    return true;
};
// 中间件
var mw = onMiddleware(selects, async (event, next) => {
    // const config = getConfigValue().aiChat || {};
    // console.log("原始事件:", event.value);
    // 新增字段
    event["Xianyu"] = true; // 默认继续执行后续的处理函数
    event["user_id"] = event.UserId; // 用户QQ号
    event["msg"] = event.MessageText; // 消息内容
    event["guid"] = event.ChannelId ?? event.UserId; // 群号或用户QQ号
    event["uidkey"] = `${event["guid"]}:${event.UserName}(${event.UserId})`; // 唯一标识
    event["nickname"] =
        `${event.name === "private.message.create" ? "[私信]" : ""}${event.UserName}(${event.UserId})`; // 昵称(用户名+QQ号)
    // 终端
    if (event.Platform == "testone") {
        // 处理图片消息
        event["img"] = event.value
            .filter((item) => item.type === "image" || item.type === "Image")
            .map((item) => item.value);
        // 处理at消息
        event["at"] = event.value
            .filter((item) => item.type === "at" || item.type === "Mention")
            .map((item) => ({
            type: "at",
            data: { qq: item.value, nickname: item.options.name },
        }));
        // 是否at机器人
        event["atBot"] = event["at"].find((item) => item.data.qq.toString() === "794161769");
        // 模拟机器人信息
        event["bot"] = {
            nickname: "小咸鱼",
            user_id: "794161769",
        };
        // 判断event.value是否为数组
        if (Array.isArray(event.value)) {
            event["originalMsg"] = event.value; // 原始消息内容
        }
    }
    // onebot平台特有处理 //
    if (event.Platform == "onebot") {
        console.log("onebot");
        // 获取客户端
        const [onebotClient] = useClient(event, API);
        try {
            const botInfo = await onebotClient.getLoginInfo();
            console.log("botInfo: ", botInfo);
            if (!botInfo || !botInfo[0] || botInfo[0].code == 4000) {
                event["ClientError"] =
                    "onebot平台连接错误, 影响:无法发送语音,无法获取自己的信息,无法获取at用户的信息,这是alemonjs的锅";
                throw new Error("获取机器人信息失败，数据格式不正确");
            }
            event["bot"] = botInfo[0].data ?? {
                nickname: "小喵酱",
                user_id: event.BotId,
            }; // 机器人信息
        }
        catch (error) {
            console.error("获取机器人信息失败，使用默认信息", error);
            event["bot"] = {
                nickname: "小喵酱",
                user_id: event.BotId,
            }; // 机器人信息
        }
        event["self_id"] = event.BotId; // 机器人QQ号
        event["originalMsg"] = event.value.message; // 原始消息内容
        // 判断是否为群管理员
        event["isAdmin"] =
            event.value.sender.role === "admin" ||
                event.value.sender.role === "owner";
        event["nickname"] =
            event.value.sender.role === "admin"
                ? "[管理员]" + event["nickname"]
                : event.value.sender.role === "owner"
                    ? "[群主]" + event["nickname"]
                    : event["nickname"]; // 群管理员或群主添加前缀
        // 处理at消息
        event["at"] = await Promise.all(event.value.message
            .filter((item) => item.type === "at")
            .map(async (item) => {
            console.log("item", item);
            try {
                const atInfo = await onebotClient.send({
                    action: "get_stranger_info",
                    params: { user_id: item.data.qq, no_cache: true },
                });
                if (!atInfo || !atInfo[0] || atInfo[0].code == 4000) {
                    throw new Error("获取QQ昵称失败，数据格式不正确");
                }
                return {
                    type: "at",
                    data: { qq: item.data.qq, nickname: atInfo[0].data.nickname },
                };
            }
            catch (error) {
                console.error(`获取QQ ${item.data.qq} 的昵称失败`, error);
                return {
                    type: "at",
                    data: {
                        qq: item.data.qq,
                        nickname: `[${String(item.data.qq) == event.BotId ? event["bot"].nickname : "无法获取昵称"}](${item.data.qq})`,
                    },
                };
            }
        }));
        // 是否at机器人
        event["atBot"] = event["at"].find((item) => item.data.qq == event.BotId);
        // 处理图片消息
        event["img"] = event.value.message
            .filter((item) => item.type === "image" || item.type === "Image")
            .map((item) => item.data.url);
        // 处理回复消息
        const replyData = event.value.message.find((item) => item.type === "reply");
        if (replyData) {
            event["replyMessageId"] = String(replyData.data.id);
            const msg = await onebotClient.getMsg({
                message_id: Number(replyData.data.id),
            });
            try {
                if (!msg || !msg[0] || msg[0].code == 4000) {
                    throw new Error("获取回复消息失败，数据格式不正确");
                }
                console.log("msg[0].data;", JSON.stringify(msg[0].data, null, 2));
                if (msg && msg[0] && msg[0].data) {
                    event["reply"] = msg[0].data;
                    if (msg[0].data.sender.user_id == event.BotId) {
                        event["atBot"] = true;
                    }
                }
            }
            catch (error) {
                console.error("获取回复消息失败，数据格式不正确", error);
            }
        }
    }
    // sc社区
    if (event.Platform == "scbbs") {
        const ScbbsAPI = await import('@alemonjs/scbbs');
        const [client] = useClient(event, ScbbsAPI);
        const isPrivate = event.name === "private.message.create";
        const contentList = Array.isArray(event.value?.content)
            ? event.value.content
            : [];
        event["msg"] = `${event["msg"] ?? ""}`;
        // 私聊用 toUser，群聊用事件 BotId
        event["self_id"] = isPrivate
            ? (event.value?.toUser?.id ?? event.BotId)
            : event.BotId;
        event["originalMsg"] = contentList;
        event["group_id"] = isPrivate
            ? undefined
            : (event.ChannelId ?? event.GuildId ?? event.value?.group?.id);
        event["group_name"] = isPrivate ? undefined : event.value?.group?.name;
        // 处理图片消息
        event["img"] = contentList
            .filter((item) => item.type === "image")
            .map((item) => (item.data?.url || "").replace("!/fwfh/368x238", ""));
        // 处理 at：后端格式 { type: "at", data: { qq, name } }
        event["at"] = contentList
            .filter((item) => item.type === "at")
            .map((item) => ({
            type: "at",
            data: {
                qq: String(item.data?.qq ?? item.data?.id ?? item.data?.userId ?? ""),
                nickname: item.data?.name || item.data?.nickname || "",
            },
        }));
        // 判断是否为群管理员（社区角色 1/2）
        event["isAdmin"] =
            event.value?.author?.roles?.filter((role) => role.id == 1 || role.id == 2).length > 0;
        event["bot"] = {
            nickname: isPrivate ? event.value?.toUser?.nickname || "" : "",
            user_id: event["self_id"],
        };
        // 私聊默认视为对机器人会话；群聊依赖适配器 IsAtMe / at.qq 是否等于自己
        const selfId = String(event["self_id"] ?? event.BotId ?? "");
        const atSelf = event["at"].some((item) => {
            const qq = String(item?.data?.qq ?? "").trim();
            return qq !== "" && qq === selfId;
        });
        event["atBot"] =
            (isPrivate && event.Platform == "scbbs") ||
                Boolean(event.IsAtMe) ||
                atSelf ||
                false;
        event["raw_message"] = contentList
            .map((item) => {
            if (item.type === "text") {
                return item.data?.text ?? "";
            }
            else if (item.type === "image") {
                return `[CQ:image,${item.data?.url}]`;
            }
            else if (item.type === "at") {
                return `[CQ:at,qq=${item.data?.qq ?? item.data?.id}]`;
            }
            else {
                return `[${String(item.type || "unknown").toUpperCase()}]`;
            }
        })
            .join("");
        if (event.replyId && event.replyId !== "-1") {
            event["replyMessageId"] = String(event.replyId);
            try {
                const replyMsg = isPrivate
                    ? await client.getMessage(event.replyId)
                    : await client.getGroupMessage(event.replyId);
                console.log("获取回复", replyMsg);
                // useClient 可能包装成结果数组，也兼容直接返回 data
                const replyData = Array.isArray(replyMsg)
                    ? (replyMsg[0]?.data ?? replyMsg[0])
                    : replyMsg;
                if (replyData) {
                    event["reply"] = replyData;
                    const fromUserId = replyData.fromUserId ??
                        replyData.author?.id ??
                        replyData.data?.fromUserId;
                    if (String(fromUserId) === String(event.self_id)) {
                        event["atBot"] = true;
                    }
                }
            }
            catch (error) {
                console.error("获取 scbbs 回复消息失败", error);
            }
        }
    }
    // 泡泡平台
    if (event.Platform == "bubble") {
        const BubbleAPI = await import('@alemonjs/bubble');
        const CDN_URL = "https://bubble-oss-files.alemonjs.com/";
        const [client] = useClient(event, BubbleAPI);
        event["uidkey"] = `${event["guid"]}:${event.value.author}(${event.UserId})`; // 唯一标识
        event["nickname"] =
            `${event.name == "private.message.create" ? "[私信]" : ""}${event.value.author}(${event.UserId})`; // 昵称(用户名+QQ号)
        event["user_id"] = event.UserId;
        event["guid"] = event.ChannelId ?? event.UserId;
        const botInfo = await client.getMe();
        event["bot"] = {
            nickname: botInfo[0].data.botUser.name,
            user_id: botInfo[0].data.botUser.id,
        };
        event["at"] =
            event.value.content.match(/<@!?(\d+)>/g)?.map((mention) => {
                return {
                    type: "at",
                    data: {
                        qq: mention.match(/<@!?(\d+)>/)[1],
                    },
                };
            }) || [];
        event["atBot"] = event["at"].find((item) => item.data.qq == botInfo[0].data.botUser.id.toString())
            ? true
            : false;
        event["originalMsg"] = event.value.content; // 原始消息内容
        event["img"] =
            event.value.fileMeta &&
                event.value.fileMeta.contentType?.startsWith("image/")
                ? [CDN_URL + event.value.fileMeta.url]
                : [];
        if (event.value.replyToId) {
            event["replyMessageId"] = String(event.value.replyToId);
            const channelMessages = await client.request({
                method: "GET",
                url: `/channels/${event.ChannelId}/messages/${event.value.replyToId}`,
            });
            if (channelMessages[0].data.authorId == botInfo[0].data.botUser.id) {
                event["atBot"] = true;
            }
            const replyType = channelMessages[0].data.type;
            const replyFileMeta = channelMessages[0].data.fileMeta;
            const replyData = {
                ...channelMessages[0].data,
                message: [
                    {
                        type: "text",
                        data: {
                            text: channelMessages[0].data.content || "",
                        },
                    },
                    ...(replyType === "image"
                        ? replyFileMeta.attachments
                            ? replyFileMeta.attachments.map((item) => {
                                console.log("item", item, item.url);
                                return {
                                    type: "image",
                                    data: {
                                        url: CDN_URL + item.url,
                                    },
                                };
                            })
                            : [
                                {
                                    type: "image",
                                    data: {
                                        url: CDN_URL + replyFileMeta.url,
                                    },
                                },
                            ]
                        : []),
                ],
            };
            console.log("获取到的回复消息", JSON.stringify(channelMessages, null, 2));
            console.log("处理后的回复", JSON.stringify(replyData, null, 2));
            event["reply"] = replyData;
        }
    }
    // ai工具
    const shouldHandleAsGuidance = (await redisClient.getAIToolLoopProcessing(event.guid, event.Platform)) ===
        "1" && (await canPassReplyTriggerGate(event));
    if (shouldHandleAsGuidance) {
        const guidanceMessage = await buildGuidanceMessage(event);
        const queue = await redisClient.addAIGuidanceMessage(event.guid, guidanceMessage, event.Platform);
        if (queue.length === 1) {
            const [message] = useMessage(event);
            await message.send(format(Text("已收到新的补充消息，等当前工具调用完成后会一并处理。")));
        }
        event["Xianyu"] = false;
        return next();
    }
    if (!(await canPassReplyTriggerGate(event))) {
        event["Xianyu"] = false;
    }
    if (event["Xianyu"]) {
        // 执行ai回复, 方便ai控制后续指令
        const aiconfig = await redisClient.getAIConfig(event.guid);
        if (aiconfig && aiconfig.model && aiconfig.key) {
            const ReplyRes = await CApiReply(event);
            console.log("res", ReplyRes);
            if (ReplyRes) {
                event["Xianyu"] = ReplyRes.next; // 根据AI回复决定是否继续执行后续的处理函数
                if (ReplyRes.commands && ReplyRes.commands.length > 0) {
                    const commandResult = await executeAlemonCommand(event, ReplyRes.commands[0]);
                    console.log("AI框架指令执行结果", commandResult);
                    event["Xianyu"] = false;
                    if (!commandResult.matched) {
                        const [message] = useMessage(event);
                        await message.send(format(Text(`未找到可执行的框架指令：${commandResult.command || "空指令"}`)));
                    }
                }
            }
        }
    }
    next();
});

export { mw as default };
