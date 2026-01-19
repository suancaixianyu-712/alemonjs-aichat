import { getConfigValue, useClient } from "alemonjs";
import { API } from "@alemonjs/onebot";
import { redis } from "@src/redis";

const selects = onSelects(["message.create", "private.message.create"]);
// 中间件
export default onMiddleware(selects, async (event, next) => {
  const config = getConfigValue();

  // 新增字段
  event["user_id"] = event.UserId;
  event["msg"] = event.MessageText;
  event["guid"] = event.ChannelId ?? event.UserId;
  event["uidkey"] = `${event["guid"]}:${event.UserName}(${event.UserId})`;
  event["nickname"] = `${event.UserName}(${event.UserId})`;

  console.log('event["nickname"]', event["nickname"]);
  console.log("event.IsMaster", event.UserId, config.master_id, event.IsMaster);

  // 判断event.value是否为数组
  if (Array.isArray(event.value)) {
    event["originalMsg"] = event.value;
    // 遍历数组, 将类型为at或Mention的项提取出来放到at中
    event["at"] = event.value.filter(
      (item) => item.type === "at" || item.type === "Mention",
    );
  }

  // onebot平台特有处理 //

  if (event.Platform == "onebot") {
    // 获取客户端
    const [client] = useClient(event, API);
    // 获取群成员存入redis
    const redisKey = `group_members_${event.ChannelId}`;
    const cachedMembers = await redis.get(redisKey);
    const cachedMembersArray = cachedMembers ? JSON.parse(cachedMembers) : [];

    // 尝试能否从缓存中找到当前用户,没有的话就重新获取群成员列表并缓存
    const userInCache = cachedMembersArray.find((member: string) => {
      const [id, name] = member.split(":");
      return id === event.UserId.toString();
    });

    if (!cachedMembers || !userInCache) {
      if (event.ChannelId) {
        const list = await client.getGroupMemberList({
          group_id: event.ChannelId!,
        });
        const memberNames = list[0].data.map(
          (item) => item.user_id + ":" + item.nickname,
        );
        await redis.set(redisKey, JSON.stringify(memberNames));
      }
    }

    event["self_id"] = event.value.self_id;
    event["originalMsg"] = event.value.message;
    event["at"] = event.value.message
      .filter((item) => item.type === "at" || item.type === "Mention")
      .map((item) => {
        cachedMembersArray.find((member: string) => {
          const [id, name] = member.split(":");
          if (id === item.data.qq.toString()) {
            item.data.nickname = name;
          }
        });
        return item;
      });
    event["atBot"] = event["at"].find(
      (item) => item.data.qq.toString() === event.self_id.toString(),
    );
    event["img"] = event.value.message
      .filter((item) => item.type === "image" || item.type === "Image")
      .map((item) => item.data.url);
    event["isAdmin"] =
      event.value.sender.role === "admin" ||
      event.value.sender.role === "owner";

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
