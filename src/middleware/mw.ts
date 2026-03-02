import { getConfigValue, useClient } from "alemonjs";
import { API } from "@alemonjs/onebot";
import { API as BubbleAPI } from "@alemonjs/bubble";

const selects = onSelects(["message.create", "private.message.create"]);
// 中间件
export default onMiddleware(selects, async (event, next) => {
  const config = getConfigValue();
  console.log("原始事件:", event.value);

  // 新增字段
  event["user_id"] = event.UserId; // 用户QQ号
  event["msg"] = event.MessageText; // 消息内容
  event["guid"] = event.ChannelId ?? event.UserId; // 群号或用户QQ号
  event["uidkey"] = `${event["guid"]}:${event.UserName}(${event.UserId})`; // 唯一标识
  event["nickname"] =
    `${event.name == "private.message.create" ? "[私信]" : ""}${event.UserName}(${event.UserId})`; // 昵称(用户名+QQ号)

  // console.log('event["nickname"]', event["nickname"]);
  // console.log("event.IsMaster", event.UserId, config.master_id, event.IsMaster);

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
    // 获取客户端
    const [client] = useClient(event, API);

    const botInfo = await client.getLoginInfo();

    event["self_id"] = event.value.self_id; // 机器人QQ号
    event["originalMsg"] = event.value.message; // 原始消息内容

    // 处理at消息
    event["at"] = await Promise.all(
      event.value.message
        .filter(
          (item: { type: string; data: { qq: number } }) => item.type === "at",
        )
        .map(async (item: { type: string; data: { qq: number } }) => {
          const atInfo = await client.send({
            action: "get_stranger_info",
            params: { user_id: item.data.qq, no_cache: true },
          });

          return {
            type: "at",
            data: { qq: item.data.qq, nickname: atInfo[0].data.nickname },
          };
        }),
    );

    // 是否at机器人
    event["atBot"] = event["at"].find((item) => item.data.qq == event.self_id);

    // 处理图片消息
    event["img"] = event.value.message
      .filter((item) => item.type === "image" || item.type === "Image")
      .map((item) => item.data.url);

    // 判断是否为群管理员
    event["isAdmin"] =
      event.value.sender.role === "admin" ||
      event.value.sender.role === "owner";
    event["bot"] = botInfo[0].data; // 机器人信息

    // 处理回复消息
    const replyData = event.value.message.find((item) => item.type === "reply");
    if (replyData) {
      const msg = await client.getMsg({
        message_id: Number(replyData.data.id),
      });

      console.log("msg[0].data;", JSON.stringify(msg[0].data, null, 2));
      if (msg && msg[0] && msg[0].data) {
        event["reply"] = msg[0].data;
      }
    }
  }

  if (event.Platform == "scbbs") {
    event["msg"] = `${event["msg"]}`; // 消息内容包含at机器人昵称
    event["self_id"] = event.value.toUser.id; // 机器人ID
    event["originalMsg"] = event.value.content; // 原始消息内容

    event["atBot"] =
      event.name === "private.message.create" && event.Platform == "scbbs";

    // 处理图片消息
    event["img"] = (event.value.content || [])
      .filter((item: { type: string }) => item.type === "image")
      .map((item: { data: { url: string } }) => item.data.url);

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
  }
  if (event.Platform == "bubble") {
    const bubbleConfig = config.bubble || {};
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
      (item: { data: { qq: string } }) => item.data.qq === event["bot"].id,
    );
    event["originalMsg"] = event.value.content; // 原始消息内容
    event["img"] =
      event.value.fileMeta &&
      event.value.fileMeta.contentType?.startsWith("image/")
        ? [
            bubbleConfig.CDN_URL ??
              "https://bubble-oss-files.alemonjs.com/" +
                event.value.fileMeta.url,
          ]
        : [];

    // if (event.value.replyToId) {
    //   const channelMessages = await client.request({
    //     method: "GET",
    //     url: `${bubbleConfig.API_URL ?? "https://api.bubble.alemonjs.com"}/channels/${event.ChannelId}/messages`,
    //     headers: {
    //       Authorization: `Bearer ${bubbleConfig.token}`,
    //       "Content-Type": "application/json",
    //     },
    //   });

    //   const replyMsg = channelMessages.find(
    //     (msg: { id: string | number }) =>
    //       msg.id.toString() === event.value.replyToId,
    //   );
    //   console.log("获取到的回复消息", replyMsg);

    //   if (replyMsg) {
    //     event["reply"] = replyMsg;
    //   }
    // }
  }

  console.log("处理后的事件", JSON.stringify(event, null, 2));

  // 常用于兼容其他框架或增强event功能
  next();
});
