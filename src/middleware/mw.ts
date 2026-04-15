import { getConfigValue, useClient } from "alemonjs";
import { API } from "@alemonjs/onebot";
import redisClient from "@src/config";
import { CApiReply } from "@src/response/zreply/capi";
import { RApiReply } from "@src/response/zreply/rapi";

const selects = onSelects(["message.create", "private.message.create"]);
// 中间件
export default onMiddleware(selects, async (event, next) => {
  const config = getConfigValue().aiChat || {};
  // console.log("原始事件:", event.value);

  // 新增字段
  event["Xianyu"] = true; // 默认继续执行后续的处理函数
  event["user_id"] = event.UserId; // 用户QQ号
  event["msg"] = event.MessageText; // 消息内容
  event["guid"] = event.ChannelId ?? event.UserId; // 群号或用户QQ号
  event["uidkey"] = `${event["guid"]}:${event.UserName}(${event.UserId})`; // 唯一标识
  event["nickname"] =
    `${event.name === "private.message.create" ? "[私信]" : ""}${event.UserName}(${event.UserId})`; // 昵称(用户名+QQ号)

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
    event["atBot"] = event["at"].find(
      (item) => item.data.qq.toString() === "794161769",
    );

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
      if (!botInfo || !botInfo[0] || botInfo[0].code == 4000) {
        event["ClientError"] =
          "onebot平台连接错误, 影响:无法发送语音,无法获取自己的信息,无法获取at用户的信息,这是alemonjs的锅";
        throw new Error("获取机器人信息失败，数据格式不正确");
      }
      event["bot"] = botInfo[0].data ?? {
        nickname: "小喵酱",
        user_id: event.BotId,
      }; // 机器人信息
    } catch (error) {
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
    event["at"] = await Promise.all(
      event.value.message
        .filter(
          (item: { type: string; data: { qq: number } }) => item.type === "at",
        )
        .map(async (item: { type: string; data: { qq: number } }) => {
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
          } catch (error) {
            console.error(`获取QQ ${item.data.qq} 的昵称失败`, error);
            return {
              type: "at",
              data: {
                qq: item.data.qq,
                nickname: `[${String(item.data.qq) == event.BotId ? event["bot"].nickname : "无法获取昵称"}](${item.data.qq})`,
              },
            };
          }
        }),
    );

    // 是否at机器人
    event["atBot"] = event["at"].find((item) => item.data.qq == event.BotId);

    // 处理图片消息
    event["img"] = event.value.message
      .filter((item) => item.type === "image" || item.type === "Image")
      .map((item) => item.data.url);

    // 处理回复消息
    const replyData = event.value.message.find((item) => item.type === "reply");
    if (replyData) {
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
      } catch (error) {
        console.error("获取回复消息失败，数据格式不正确", error);
      }
    }
  }

  if (event.Platform == "scbbs") {
    const ScbbsAPI = await import("@alemonjs/scbbs");

    const [client] = useClient(event, ScbbsAPI);

    event["msg"] = `${event["msg"]}`; // 消息内容包含at机器人昵称
    event["self_id"] = event.value.toUser.id; // 机器人ID
    event["originalMsg"] = event.value.content; // 原始消息内容

    event["atBot"] =
      event.name === "private.message.create" && event.Platform == "scbbs";

    // 处理图片消息
    event["img"] = (event.value.content || [])
      .filter((item: { type: string }) => item.type === "image")
      .map((item: { data: { url: string } }) =>
        item.data.url.replace("!/fwfh/368x238", ""),
      );

    // 判断是否为群管理员
    event["isAdmin"] =
      event.value.author.roles?.filter(
        (role: { id: number }) => role.id == 1 || role.id == 2,
      ).length > 0;
    event["bot"] = {
      nickname: event.value.toUser.nickname,
      user_id: event.value.toUser.id,
    }; // 机器人信息
    event["raw_message"] = event.value.content
      .map((item: { type: string; data: any }) => {
        if (item.type === "text") {
          return item.data.text;
        } else if (item.type === "image") {
          return `[CQ:image,${item.data.url}]`;
        } else if (item.type === "at") {
          return `[CQ:at,qq=${item.data.id}]`;
        } else {
          return `[${item.type.toUpperCase()}]`;
        }
      })
      .join("");

    if (event.replyId && event.replyId !== "-1") {
      const replyMsg = await client.getMessage(event.replyId);
      console.log("获取回复", replyMsg);

      if (replyMsg) {
        event["reply"] = replyMsg[0].data;
        if (replyMsg[0].data.fromUserId == event.self_id) {
          event["atBot"] = true;
        }
      }
    }
  }

  if (event.Platform == "bubble") {
    const BubbleAPI = await import("@alemonjs/bubble");
    const CDN_URL = "https://bubble-oss-files.alemonjs.com/";
    const [client] = useClient(event, BubbleAPI);

    event["uidkey"] = `${event["guid"]}:${event.value.author}(${event.UserId})`; // 唯一标识
    event["nickname"] =
      `${event.name == "private.message.create" ? "[私信]" : ""}${event.value.author}(${event.UserId})`; // 昵称(用户名+QQ号)

    event["user_id"] = event.UserId;
    event["guid"] = event.ChannelId ?? event.UserId;
    const botInfo: any = await client.getMe();
    event["bot"] = {
      nickname: botInfo[0].data.botUser.name,
      user_id: botInfo[0].data.botUser.id,
    };

    event["at"] =
      event.value.content.match(/<@!?(\d+)>/g)?.map((mention: string) => {
        return {
          type: "at",
          data: {
            qq: mention.match(/<@!?(\d+)>/)![1],
          },
        };
      }) || [];
    event["atBot"] = event["at"].find(
      (item: { data: { qq: string } }) =>
        item.data.qq == botInfo[0].data.botUser.id.toString(),
    )
      ? true
      : false;
    event["originalMsg"] = event.value.content; // 原始消息内容
    event["img"] =
      event.value.fileMeta &&
      event.value.fileMeta.contentType?.startsWith("image/")
        ? [CDN_URL + event.value.fileMeta.url]
        : [];

    if (event.value.replyToId) {
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
              ? replyFileMeta.attachments.map((item: any) => {
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

  const atTriggerSwitch = await redisClient.getAtTriggerSwitch(
    event.ChannelId ?? event.UserId,
  );
  if (atTriggerSwitch === "1" && event.Platform !== "testone") {
    if (!event["atBot"] && event.name !== "private.message.create") {
      event["Xianyu"] = false; // 跳过所有指令,继续执行后续的处理函数
    }
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
          event.MessageText = ReplyRes.commands[0];
          event["msg"] = ReplyRes.commands[0];
        }
      }
    }
  }

  next();
});
