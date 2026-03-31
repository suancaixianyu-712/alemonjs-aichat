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
const value = getConfigValue();

const selects = onSelects(["message.create", "private.message.create"]);
// inline regex checks are used in-place; keep `test` as shorthand
const test = /(\/|#)测试$/i;
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
  if (/(\/|#)添加ai$/i.test(e.msg)) {
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
  if (/(\/|#)添加ai\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)添加ai\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i);
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
  if (/(\/|#)(切换)(ai|配置) ?(.*)/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(切换)(ai|配置) ?(.*)/i);
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
  if (/(\/|#)添加提示词$/i.test(e.msg)) {
    message.send(
      format(Text("请按照 格式：/添加提示词 <名称> <内容> 进行添加")),
    );
    return;
  }

  // 处理添加提示词
  if (/(\/|#)添加提示词 (\S+) ([\s\S]+)/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)添加提示词 (\S+) ([\s\S]+)/i);
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
  if (/(\/|#)(删除)(提示词|提示词列表) ?(.*)/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(删除)(提示词|提示词列表) ?(.*)/i);
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
  if (/(\/|#)(切换|设置)提示词 ?(.*)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(切换|设置)提示词 ?(.*)$/i);
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
  if (/(\/|#)清空提示词$/i.test(e.msg)) {
    await switchPrompt(e.guid, "");
    message.send(format(Text("已清空提示词 !")));
    return;
  }

  // 删除AI配置
  if (/(\/|#)删除ai\s(\S+)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)删除ai\s(\S+)$/i);
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
  if (/(\/|#)(开启|启用|关闭|禁用)好感度$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(开启|启用|关闭|禁用)好感度$/i);
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
  if (/(\/|#)(开启|关闭)聊天$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(开启|关闭)聊天$/i);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/开启聊天 或 /关闭聊天 进行设置")),
      );
      return;
    }
    const [, , action, isAll] = match;
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
      if (isAll) {
        // 如果是关闭全部聊天，则清空所有AI配置
        // await redis.del(`ai:config:*`);
        await redis.keys(`ai:config:*`).then((keys) => {
          if (keys.length > 0) {
            redis.del(keys);
          }
        });
        message.send(format(Text("已关闭聊天功能 !")));
      } else {
        await switchAI(e.guid, "");
        message.send(format(Text("已关闭聊天功能 !")));
      }
    }
    return;
  }

  // 设置语音回复开关
  if (/(\/|#)(开启|关闭)语音回复$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(开启|关闭)语音回复$/i);
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
  if (/(\/|#)(开启|关闭)(MCP)?工具$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(开启|关闭)(MCP)?工具$/i);
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
  if (/(\/|#)切换图床(.*)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)切换图床(.*)$/i);
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
  if (/(\/|#)修改 ?(.+) ?模型 ?(.+)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)修改 ?(.+) ?模型 ?(.+)$/i);
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

  // 切换当前ai的模型
  if (/(\/|#)切换模型 ?(.+)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)切换模型 ?(.+)$/i);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/切换模型 <模型名称> 进行设置")),
      );
      return;
    }
    const [, , modelName] = match;
    const aiInfo = await getAIConfig(e.guid);
    if (!aiInfo.model) {
      message.send(format(Text(`当前没有可用的 AI 配置！`)));
      return;
    }
    aiInfo.model = modelName.trim();
    redis.set(`ai:config:${e.guid}`, JSON.stringify(aiInfo));
    message.send(
      format(Text(`已将当前 AI 的模型修改为 ${modelName.trim()} !`)),
    );
    return;
  }

  // 设置复杂输出开关
  if (/(\/|#)(关闭|开启)复杂(输出|回复)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(关闭|开启)复杂(输出|回复)$/i);
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
  if (
    /(\/|#)(关闭|禁止|不可以|不允许|开启|可以|允许)(涩涩|色色)$/i.test(e.msg)
  ) {
    // if (!e.IsMaster || String(e.UserId) != "3501869534") {
    //   return;
    // }
    const match = e.msg.match(
      /(\/|#)(关闭|禁止|不可以|不允许|开启|可以|允许)(涩涩|色色)$/i,
    );
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

  // ollama获取模型列表
  if (/(\/|#)ollama ?(模型列表|list)$/i.test(e.msg)) {
    const models = await availableTools.OllamaListModels();
    if (models.length > 0) {
      message.send(
        format(
          Text("当前 Ollama 模型列表：\n"),
          Text(models.map((m) => m.id).join("\n")),
        ),
      );
    } else {
      message.send(format(Text("未获取到 Ollama 模型列表！")));
    }
    return;
  }

  // 无匹配则继续下一个响应器
  next();
});
