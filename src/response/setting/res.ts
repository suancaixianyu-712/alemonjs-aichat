import {
  addAI,
  addPrompt,
  affectionSwitch,
  deleteAI,
  deletePrompt,
  getAIList,
  setBotID,
  switchAI,
  switchPrompt,
} from "@src/config";
import { Text, useMessage } from "alemonjs";
// import { Regular } from "alemonjs/utils";

const selects = onSelects(["message.create", "private.message.create"]);
const regular$1 = /(\/|#)添加ai$/i;
const regular$2 = /(\/|#)添加ai\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i;
const regular$3 = /(\/|#)(切换)(ai|配置) ?(.*)/i;
const regular$4 = /(\/|#)添加提示词$/i;
const regular$5 = /(\/|#)添加提示词 (\S+) ([\s\S]+)/i;
const regular$6 = /(\/|#)(删除)(提示词|提示词列表) ?(.*)/i;
const regular$7 = /(\/|#)(切换|设置)提示词 ?(.*)$/i;
const regular$8 = /(\/|#)清空提示词$/i;
const regular$9 = /(\/|#)设置(机器人)?(id|账号) ?(.*)$/i;
const regular$10 = /(\/|#)删除ai\s(\S+)$/i;
const regular$11 = /(\/|#)(开启|启用|关闭|禁用)好感度$/i;
const regular$12 = /(\/|#)清空提示词$/i;
const regular$13 = /(\/|#)(开启|关闭)聊天$/i;

// export const regular = Regular.or(regular$1, regular$2, regular$3);
export const regular = /.*/;

export default onResponse(selects, async (e, next) => {
  // 创建
  const [message] = useMessage(e);

  // 添加AI配置
  if (regular$1.test(e.msg)) {
    message.send(
      format(
        Text(
          "请按照 格式：/添加ai <名称> <主机地址> <api_key> <模型> 进行添加",
        ),
      ),
    );
    return;
  }

  // 处理添加AI配置
  if (regular$2.test(e.msg)) {
    const match = e.msg.match(regular$2);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/添加ai <名称> <主机地址> <api_key> <模型> 进行添加",
          ),
        ),
      );
      return;
    }

    const [, , name, host, key, model] = match;
    await addAI(e.guid, name, host, key, model);
    message.send(format(Text(`AI ${name} 添加成功！`)));
  }

  // 切换AI配置
  if (regular$3.test(e.msg)) {
    const match = e.msg.match(regular$3);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/切换ai <名称> 进行切换")),
      );
      return;
    }
    const [, , , , name] = match;
    const ai = await switchAI(e.guid, name.trim());
    if (!ai) {
      message.send(format(Text(`切换失败，未找到 AI ${name} !`)));
      return;
    }
    message.send(format(Text(`已切换到 AI ${name} !`)));
    return;
  }

  // 添加提示词
  if (regular$4.test(e.msg)) {
    message.send(
      format(Text("请按照 格式：/添加提示词 <名称> <内容> 进行添加")),
    );
    return;
  }

  // 处理添加提示词
  if (regular$5.test(e.msg)) {
    const match = e.msg.match(regular$5);
    if (!match) {
      message.send(
        format(
          Text("格式错误，请按照 格式：/添加提示词 <名称> <内容> 进行添加"),
        ),
      );
      return;
    }
    const [, , name, content] = match;
    await addPrompt(name, content);
    message.send(format(Text(`提示词 ${name} 添加成功！`)));
    return;
  }

  // 删除提示词
  if (regular$6.test(e.msg)) {
    const match = e.msg.match(regular$6);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/删除提示词 <名称> 进行删除")),
      );
      return;
    }
    const [, , , , name] = match;
    await deletePrompt(name);
    message.send(format(Text(`提示词 ${name} 删除成功！`)));
    return;
  }

  // 切换提示词
  if (regular$7.test(e.msg)) {
    const match = e.msg.match(regular$7);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/切换提示词 <名称> 进行切换")),
      );
      return;
    }
    const [, , , name] = match;
    const prompt = await switchPrompt(e.guid, name);
    message.send(
      format(Text(`已切换到提示词 ${name} !\n`), Text(prompt || "")),
    );
    return;
  }

  // 清空提示词
  if (regular$8.test(e.msg)) {
    await switchPrompt(e.guid, "");
    message.send(format(Text("已清空提示词 !")));
    return;
  }

  // 设置机器人ID
  if (regular$9.test(e.msg)) {
    const match = e.msg.match(regular$9);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/设置机器人id <ID> 进行设置")),
      );
      return;
    }
    const [, , , , id] = match;
    await setBotID(id.trim());
    message.send(format(Text(`已设置机器人ID为 ${id} !`)));
    return;
  }

  // 删除AI配置
  if (regular$10.test(e.msg)) {
    const match = e.msg.match(regular$10);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/删除ai <名称> 进行删除")),
      );
      return;
    }
    const [, , name] = match;
    const success = await deleteAI(name.trim());
    if (!success) {
      message.send(format(Text(`删除失败，未找到 AI ${name} !`)));
      return;
    }
    message.send(format(Text(`AI ${name} 删除成功 !`)));
    return;
  }

  // 设置好感度开关
  if (regular$11.test(e.msg)) {
    const match = e.msg.match(regular$11);
    if (!match) {
      message.send(
        format(
          Text("格式错误，请按照 格式：/开启好感度 或 /关闭好感度 进行设置"),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启" || action === "启用";
    await affectionSwitch(e.guid, enable);
    message.send(format(Text(`已${enable ? "开启" : "关闭"}好感度功能 !`)));
    return;
  }

  // 清空提示词
  if (regular$12.test(e.msg)) {
    await switchPrompt(e.guid, "");
    message.send(format(Text("已清空提示词 !")));
    return;
  }

  // 设置聊天开关 ,发送开启聊天时, 获取ai列表的第一个ai配置, 并切换到该配置
  if (regular$13.test(e.msg)) {
    const match = e.msg.match(regular$13);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/开启聊天 或 /关闭聊天 进行设置")),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    if (enable) {
      const aiList = await getAIList();
      if (aiList.length === 0) {
        message.send(format(Text("当前没有可用的AI配置，请先添加AI配置！")));
        return;
      }

      await switchAI(e.guid, aiList[0]);
      message.send(format(Text(`已开启聊天功能，当前AI为 ${aiList[0]} !`)));
    } else {
      await switchAI(e.guid, "");
      message.send(format(Text("已关闭聊天功能 !")));
    }
    return;
  }

  // 无匹配则继续下一个响应器
  next();
});
