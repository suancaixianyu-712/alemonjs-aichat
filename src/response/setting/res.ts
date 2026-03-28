import { availableTools } from "@src/api";
import {
  addAI,
  addPrompt,
  affectionSwitch,
  deleteAI,
  deletePrompt,
  getAIConfig,
  getAIList,
  switchAI,
  switchPrompt,
} from "@src/config";
import { redis } from "@src/redis";
import { getImageBuffer, uploadImageToR2 } from "@src/s3";
import {
  ImageFile,
  ImageURL,
  Text,
  useMessage,
  getConfigValue,
} from "alemonjs";
import { Regular } from "alemonjs/utils";
const value = getConfigValue();

const selects = onSelects(["message.create", "private.message.create"]);
const regular$1 = /(\/|#)添加ai$/i;
const regular$2 = /(\/|#)添加ai\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i;
const regular$3 = /(\/|#)(切换)(ai|配置) ?(.*)/i;
const regular$4 = /(\/|#)添加提示词$/i;
const regular$5 = /(\/|#)添加提示词 (\S+) ([\s\S]+)/i;
const regular$6 = /(\/|#)(删除)(提示词|提示词列表) ?(.*)/i;
const regular$7 = /(\/|#)(切换|设置)提示词 ?(.*)$/i;
const regular$8 = /(\/|#)清空提示词$/i;
const regular$10 = /(\/|#)删除ai\s(\S+)$/i;
const regular$11 = /(\/|#)(开启|启用|关闭|禁用)好感度$/i;
const regular$13 = /(\/|#)(开启|关闭)聊天$/i;
const regular$14 = /(\/|#)(开启|关闭)语音回复$/i;
const regular$15 = /(\/|#)(开启|关闭)(MCP)?工具$/i;
const regular$16 = /(\/|#)切换图床(.*)$/i;
const regular$17 = /(\/|#)修改 ?(.+) ?模型 ?(.+)$/i;
const regular$18 = /(\/|#)(关闭|开启)复杂(输出|回复)$/i;
const regular$19 =
  /(\/|#)(关闭|禁止|不可以|不允许|开启|可以|允许)(涩涩|色色)$/i;

const test = /(\/|#)测试$/i;

export const regular = Regular.or(
  regular$1,
  regular$2,
  regular$3,
  regular$4,
  regular$5,
  regular$6,
  regular$7,
  regular$8,
  regular$10,
  regular$11,
  regular$13,
  regular$14,
  regular$15,
  regular$16,
  regular$17,
  regular$18,
  regular$19,
  test,
);

export default onResponse(selects, async (e, next) => {
  // 创建
  const [message] = useMessage(e);

  // 测试
  if (test.test(e.msg)) {
    let img =
      "https://imgen.x.ai/xai-imgen/xai-tmp-imgen-597ead9b-8db9-4f43-a501-ee4f32d9b4d0.jpeg";

    if (img.startsWith("https://imgen.x.ai")) {
      img = img.replace("https://imgen.x.ai", value.xaiImgProxy);
    }

    message.send(format(Text("测试消息"), ImageURL(img)));
    // const a = await availableTools.StableDiffusionGenerateImage({
    //   prompt: "a cat playing with a ball",
    // });
    // if (a.length > 0) {
    //   message.send(format(ImageFile(a[0].url)));
    // }
    return;
  }

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
    message.send(
      format(Text(`已切换到 AI ${name} !`), Text(`\n模型: ${ai.model}`)),
    );
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

      const aiInfo = await getAIConfig(e.guid);
      if (aiInfo.model) {
        message.send(
          format(Text(`聊天功能已开启，当前AI为 ${aiInfo.model} !`)),
        );
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

  // 设置语音回复开关
  if (regular$14.test(e.msg)) {
    const match = e.msg.match(regular$14);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启语音回复 或 /关闭语音回复 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redis.set(`chat:tts:response:${e.guid}`, enable ? "1" : "0");
    message.send(format(Text(`已${enable ? "开启" : "关闭"}语音回复功能 !`)));
    return;
  }

  // 设置工具开关
  if (regular$15.test(e.msg)) {
    const match = e.msg.match(regular$15);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/开启工具 或 /关闭工具 进行设置")),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redis.set(`chat:tools:response:${e.guid}`, enable ? "1" : "0");
    message.send(
      format(
        Text(
          `已${enable ? "开启" : "关闭"}工具功能 !\n请注意当前模型是否支持工具调用。`,
        ),
      ),
    );
    return;
  }

  // 设置图床
  if (regular$16.test(e.msg)) {
    const match = e.msg.match(regular$16);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/切换图床 <图床名称> 进行设置")),
      );
      return;
    }
    const [, , bedName] = match;
    const validBeds = ["R2", "又拍云"];
    if (!validBeds.includes(bedName.trim())) {
      message.send(
        format(Text(`无效的图床名称！可用图床有：${validBeds.join("、")}。`)),
      );
      return;
    }
    await redis.set(`chat:image:bed`, bedName.trim());
    message.send(format(Text(`已切换图床至 ${bedName.trim()} !`)));
    return;
  }

  // 修改指定ai的模型
  if (regular$17.test(e.msg)) {
    const match = e.msg.match(regular$17);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/修改 <AI名称> 模型 <模型名称> 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , aiName, modelName] = match;
    const aiList = await getAIList();
    if (!aiList.includes(aiName.trim())) {
      message.send(format(Text(`未找到 AI ${aiName.trim()} !`)));
      return;
    }
    await switchAI(e.guid, aiName.trim());
    const aiInfo = await getAIConfig(e.guid);
    if (!aiInfo.model) {
      message.send(format(Text(`切换失败，未找到 AI ${aiName.trim()} !`)));
      return;
    }

    aiInfo.model = modelName.trim();
    await addAI(
      e.guid,
      aiName.trim(),
      aiInfo.host,
      aiInfo.key,
      modelName.trim(),
    );

    message.send(
      format(
        Text(`已将 AI ${aiName.trim()} 的模型修改为 ${modelName.trim()} !`),
      ),
    );
    return;
  }

  // 设置复杂输出开关
  if (regular$18.test(e.msg)) {
    const match = e.msg.match(regular$18);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启复杂输出 或 /关闭复杂输出 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redis.set(`chat:complex:response:${e.guid}`, enable ? "1" : "0");
    message.send(format(Text(`已${enable ? "开启" : "关闭"}复杂输出功能 !`)));
    return;
  }

  // 设置R18开关
  if (regular$19.test(e.msg)) {
    // if (!e.IsMaster || String(e.UserId) != "3501869534") {
    //   return;
    // }
    const match = e.msg.match(regular$19);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/禁止涩涩 或 /可以涩涩 进行设置")),
      );
      return;
    }
    const [, , action] = match;
    console.log("涩涩action", action);

    const enable = /(关闭|禁止|不可以|不允许)/.test(action) ? false : true;
    await redis.set(`chat:r18:response:${e.guid}`, enable ? "1" : "0");
    message.send(format(Text(`已${enable ? "允许" : "禁止"}涩涩功能 !`)));
    return;
  }

  // 无匹配则继续下一个响应器
  next();
});
