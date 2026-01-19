import { getConfigValue, useClient } from "alemonjs";
import { API } from "@alemonjs/onebot";

const selects = onSelects(["message.create", "private.message.create"]);
// 中间件
export default onMiddleware(selects, async (event, next) => {
  // const config = getConfigValue();

  // 新增字段
  event["user_id"] = event.UserId; // 用户QQ号
  event["msg"] = event.MessageText; // 消息内容
  event["guid"] = event.ChannelId ?? event.UserId; // 群号或用户QQ号
  event["uidkey"] = `${event["guid"]}:${event.UserName}(${event.UserId})`; // 唯一标识
  event["nickname"] = `${event.UserName}(${event.UserId})`; // 昵称(用户名+QQ号)

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
    // 获取群成员存入redis
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

    console.log('event["at"]', event["at"]);

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

  // 常用于兼容其他框架或增强event功能
  next();
});
