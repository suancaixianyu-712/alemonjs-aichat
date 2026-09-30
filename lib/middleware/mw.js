import { useClient } from 'alemonjs';
import { API } from '@alemonjs/onebot';
import redisClient from '../config.js';

const selects = onSelects(["message.create", "private.message.create"]);
// 中间件
var mw = onMiddleware(selects, async (event, next) => {
    // const config = getConfigValue().aiChat || {};
    // console.log("原始事件:", event.value);
    // 平台级 bot 信息开关指令，置于最前面：即使 bot 信息接口出现故障也能正常触发
    const botInfoCommand = String(event?.MessageText || event?.msg || "").match(/^(\/|#)(开启|关闭)bot信息$/i);
    if (botInfoCommand) {
        const enable = botInfoCommand[2] === "开启";
        await redisClient.setBotInfoSwitch(event.Platform, enable);
        const [message] = useMessage(event);
        await message.send(format(Text(enable
            ? `已开启当前平台(${event.Platform}) bot 信息接口获取。`
            : `已关闭当前平台(${event.Platform}) bot 信息接口获取，将使用默认账号信息，并在提示词平台信息后标注（故障）。`)));
        return; // 不调用 next()，避免指令被后续路由（setting/res.ts）重复处理
    }
    // 新增字段
    event["Xianyu"] = true; // 默认继续执行后续的处理函数
    event["user_id"] = event.UserId; // 用户QQ号
    event["msg"] = event.MessageText; // 消息内容
    event["guid"] = event.ChannelId ?? event.UserId; // 群号或用户QQ号
    event["uidkey"] = `${event["guid"]}:${event.UserName}(${event.UserId})`; // 唯一标识
    event["nickname"] =
        `${event.name === "private.message.create" ? "[私信]" : ""}${event.UserName}(${event.UserId})`; // 昵称(用户名+QQ号)
    // bot 信息获取方式：关闭时跳过接口，使用默认账号信息并标记故障
    const botInfoSwitch = await redisClient.getBotInfoSwitch(event.Platform);
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
            if (botInfoSwitch === "0") {
                event["bot"] = {
                    nickname: "小喵酱",
                    user_id: event.BotId,
                }; // 机器人信息
                event["botInfoFault"] = true;
            }
            else {
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
        }
        catch (error) {
            console.error("获取机器人信息失败，使用默认信息", error);
            event["bot"] = {
                nickname: "小喵酱",
                user_id: event.BotId,
            }; // 机器人信息
        }
        event["self_id"] = event.BotId; // 机器人QQ号
        // 部分事件(文件/视频等)不带 sender，sendMessage 也可能简化消息体，这里全部做兜底
        event["originalMsg"] = event.value?.message ?? event.value?.raw_message ?? [];
        const senderRole = event.value?.sender?.role;
        // 判断是否为群管理员
        event["isAdmin"] = senderRole === "admin" || senderRole === "owner";
        event["nickname"] =
            senderRole === "admin"
                ? "[管理员]" + event["nickname"]
                : senderRole === "owner"
                    ? "[群主]" + event["nickname"]
                    : event["nickname"]; // 群管理员或群主添加前缀
        // 处理at消息
        event["at"] = await Promise.all((event.value?.message ?? [])
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
        event["img"] = (event.value?.message ?? [])
            .filter((item) => item.type === "image" || item.type === "Image")
            .map((item) => item.data.url);
        // 处理回复消息
        const replyData = (event.value?.message ?? []).find((item) => item.type === "reply");
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
        let botUserId = "";
        if (botInfoSwitch === "0") {
            botUserId = String(event.BotId || "");
            event["bot"] = {
                nickname: "小喵酱",
                user_id: botUserId,
            };
            event["botInfoFault"] = true;
        }
        else {
            const botInfo = await client.getMe();
            botUserId = String(botInfo[0].data.botUser.id || "");
            event["bot"] = {
                nickname: botInfo[0].data.botUser.name,
                user_id: botUserId,
            };
        }
        event["at"] =
            event.value.content.match(/<@!?(\d+)>/g)?.map((mention) => {
                return {
                    type: "at",
                    data: {
                        qq: mention.match(/<@!?(\d+)>/)[1],
                    },
                };
            }) || [];
        event["atBot"] = event["at"].find((item) => item.data.qq == botUserId)
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
            if (channelMessages[0].data.authorId == botUserId) {
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
    return next();
});

export { mw as default };
