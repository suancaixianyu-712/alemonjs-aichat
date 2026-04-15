import { availableTools } from "@src/api/aitools";
import { loadSkills } from "@src/api/loadSkill";
import redisClient from "@src/config";
import { getImageBuffer, uploadImageToR2 } from "@src/s3";
import {
  ImageFile,
  ImageURL,
  Text,
  useMessage,
  getConfigValue,
} from "alemonjs";
import { log } from "console";
const value = getConfigValue().aiChat || {};

const selects = onSelects(["message.create", "private.message.create"]);
// inline regex checks are used in-place; keep `test` as shorthand
const test = /(\/|#)测试$/i;
export default onResponse(selects, async (e, next) => {
  // 创建
  const [message] = useMessage(e);

  // 测试
  if (test.test(e.msg)) {
    message.send(format(Text("测试消息")));

    // 1. 获取技能列表（简要信息）
    // const skills = loadSkills();
    // console.log(skills);

    // log(JSON.stringify(e, null, 2));

    // let img =
    //   "https://imgen.x.ai/xai-imgen/xai-tmp-imgen-597ead9b-8db9-4f43-a501-ee4f32d9b4d0.jpeg";

    // if (img.startsWith("https://imgen.x.ai")) {
    //   img = img.replace("https://imgen.x.ai", value.xaiImgProxy);
    // }

    // message.send(format(Text("测试消息"), ImageURL(img)));
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
    await redisClient.addAI(e.guid, name, host, key, model);
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
    const ai = await redisClient.switchAI(e.guid, name.trim());
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
    await redisClient.addPrompt(name, content);
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
    await redisClient.deletePrompt(name);
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
    const prompt = await redisClient.switchPrompt(e.guid, name);
    message.send(
      format(Text(`已切换到提示词 ${name} !\n`), Text(prompt || "")),
    );
    return;
  }

  // 清空提示词
  if (/(\/|#)清空提示词$/i.test(e.msg)) {
    await redisClient.switchPrompt(e.guid, "");
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
    const success = await redisClient.deleteAI(name.trim());
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
    await redisClient.setAffectionSwitch(e.guid, enable);
    message.send(format(Text(`已${enable ? "开启" : "关闭"}好感度功能 !`)));
    return;
  }

  // 设置聊天开关 ,发送开启聊天时, 获取ai列表的第一个ai配置, 并切换到该配置
  if (/(\/|#)(开启|关闭)(全部)?聊天$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(开启|关闭)(全部)?聊天$/i);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/开启聊天 或 /关闭聊天 进行设置")),
      );
      return;
    }
    const [, , action, isAll] = match;
    const enable = action === "开启";
    if (enable) {
      const aiList = await redisClient.getAIList();
      if (aiList.length === 0) {
        message.send(format(Text("当前没有可用的AI配置，请先添加AI配置！")));
        return;
      }

      const aiInfo = await redisClient.getAIConfig(e.guid);
      if (aiInfo.model) {
        message.send(
          format(Text(`聊天功能已开启，当前AI为 ${aiInfo.model} !`)),
        );
        return;
      }

      await redisClient.switchAI(e.guid, aiList[0]);
      message.send(format(Text(`已开启聊天功能，当前AI为 ${aiList[0]} !`)));
    } else {
      if (isAll) {
        // 如果是关闭全部聊天，则清空所有AI配置
        await redisClient.closeAllChat();
        message.send(format(Text("已关闭聊天功能 !")));
      } else {
        await redisClient.closeChat(e.guid);
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
    await redisClient.setTTSResponseSwitch(e.guid, enable);
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
    await redisClient.setToolSwitch(e.guid, enable);
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
    await redisClient.switchImageBed(e.guid, bedName.trim());
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
    const aiList = await redisClient.getAIList();
    if (!aiList.includes(aiName.trim())) {
      message.send(format(Text(`未找到 AI ${aiName.trim()} !`)));
      return;
    }
    await redisClient.switchAI(e.guid, aiName.trim());
    const aiInfo = await redisClient.getAIConfig(e.guid);
    if (!aiInfo.model) {
      message.send(format(Text(`切换失败，未找到 AI ${aiName.trim()} !`)));
      return;
    }
    aiInfo.model = modelName.trim();
    await redisClient.addAI(
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
    const aiInfo = await redisClient.getAIConfig(e.guid);
    if (!aiInfo.model) {
      message.send(format(Text(`当前没有可用的 AI 配置！`)));
      return;
    }
    aiInfo.model = modelName.trim();
    await redisClient.setAIConfig(e.guid, aiInfo);
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
    await redisClient.setComplexOutput(e.guid, enable);
    message.send(format(Text(`已${enable ? "开启" : "关闭"}复杂输出功能 !`)));
    return;
  }

  // 设置R18开关
  if (
    /(\/|#)(关闭|禁止|不可以|不允许|开启|可以|允许)(涩涩|色色)$/i.test(e.msg)
  ) {
    if (!e.IsMaster || String(e.UserId) != "3501869534") {
      return;
    }
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
    const enable = /(关闭|禁止|不可以|不允许)/.test(action) ? false : true;
    if (!value.baidu?.ak && !value.baidu?.sk && !enable) {
      message.send(
        format(
          Text(
            "未配置百度AI审核接口，无法停止涩涩！请在配置文件中添加百度AI的AK和SK。",
          ),
        ),
      );
      return;
    }

    await redisClient.setR18Switch(e.guid, enable);
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

  // 设置主动搭话
  if (/(\/|#)(关闭|开启)主动(搭话|回复)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(关闭|开启)主动(搭话|回复)$/i);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启主动搭话 或 /关闭主动搭话 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redisClient.setProactiveSwitch(e.guid, enable);
    message.send(format(Text(`已${enable ? "开启" : "关闭"}主动搭话功能 !`)));
    return;
  }

  // 设置深度思考开关
  if (/(\/|#)(开启|关闭)深度思考$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(开启|关闭)深度思考$/i);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启深度思考 或 /关闭深度思考 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redisClient.setDeepThoughtSwitch(e.guid, enable);
    message.send(format(Text(`已${enable ? "开启" : "关闭"}深度思考功能 !`)));
    return;
  }

  // 设置ai的RAPI模式开关
  if (/(\/|#)(设置|修改)(ai)?(.*)rapi模式(开启|关闭)$/i.test(e.msg)) {
    const match = e.msg.match(
      /(\/|#)(设置|修改)(ai)?(.*)rapi模式(开启|关闭)$/i,
    );
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/设置 rapi模式 开启 或 /设置 rapi模式 关闭 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , , , aiName, action] = match;
    const enable = action === "开启";
    if (aiName.trim()) {
      await redisClient.switchModelRAPI(aiName.trim(), enable);
      message.send(
        format(
          Text(
            `已${enable ? "开启" : "关闭"} AI ${aiName.trim()} 的 RAPI 模式 !`,
          ),
        ),
      );
    }
  }

  // 设置仅艾特触发
  if (/(\/|#)(开启|关闭)仅艾特触发$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(开启|关闭)仅艾特触发$/i);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启仅艾特触发 或 /关闭仅艾特触发 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redisClient.setAtTriggerSwitch(e.guid, enable);
    message.send(format(Text(`已${enable ? "开启" : "关闭"}仅艾特触发功能 !`)));
    return;
  }

  // 获取所有ai工具列表
  if (/(\/|#)工具列表$/i.test(e.msg)) {
    const tools = await redisClient.getAllToolStatus(e.guid);
    log("工具列表：", Object.entries(tools));
    const toolList = Object.entries(tools)
      .map(([tool, status]) => `${tool}: ${status === "0" ? "开启" : "关闭"}`)
      .join("\n");
    message.send(format(Text(`当前工具列表及状态：\n${toolList}`)));

    return;
  }

  // 控制工具开关
  if (/(\/|#)(开启|关闭)工具(.*)$/i.test(e.msg)) {
    if (!e.IsMaster || String(e.UserId) != "3501869534") {
      return;
    }
    const match = e.msg.match(/(\/|#)(开启|关闭)工具(.*)$/i);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启工具 <工具名称> 或 /关闭工具 <工具名称> 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action, toolName] = match;
    const enable = action === "开启";

    if (enable) {
      redisClient.enableTool(e.guid, toolName.trim());
    } else {
      {
        redisClient.disableTool(e.guid, toolName.trim());
      }
    }
    message.send(
      format(Text(`已${enable ? "开启" : "关闭"}工具 ${toolName.trim()} !`)),
    );
    return;
  }

  // 控制工具提示开关
  if (/(\/|#)(开启|关闭)工具(调用)?提示$/i.test(e.msg)) {
    if (!e.IsMaster || String(e.UserId) != "3501869534") {
      return;
    }
    const match = e.msg.match(/(\/|#)(开启|关闭)工具(调用)?提示$/i);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启工具提示 或 /关闭工具提示 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redisClient.setToolPromptSwitch(e.guid, enable);
    message.send(format(Text(`已${enable ? "开启" : "关闭"}工具提示功能 !`)));
    return;
  }

  // 控制工具提示撤回开关
  if (/(\/|#)(开启|关闭)工具(调用)?提示撤回$/i.test(e.msg)) {
    if (!e.IsMaster || String(e.UserId) != "3501869534") {
      return;
    }
    const match = e.msg.match(/(\/|#)(开启|关闭)工具(调用)?提示撤回$/i);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启工具提示撤回 或 /关闭工具提示撤回 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redisClient.setToolPromptRevokeSwitch(e.guid, enable);
    message.send(
      format(Text(`已${enable ? "开启" : "关闭"}工具提示撤回功能 !`)),
    );
    return;
  }

  // 控制工具调用提示详情开关
  if (/(\/|#)(开启|关闭)工具(调用)?提示详情$/i.test(e.msg)) {
    if (!e.IsMaster || String(e.UserId) != "3501869534") {
      return;
    }
    const match = e.msg.match(/(\/|#)(开启|关闭)工具(调用)?提示详情$/i);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启工具提示详情 或 /关闭工具提示详情 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redisClient.setToolPromptArgsSwitch(e.guid, enable);
    message.send(
      format(Text(`已${enable ? "开启" : "关闭"}工具提示详情功能 !`)),
    );
    return;
  }

  next();
});
