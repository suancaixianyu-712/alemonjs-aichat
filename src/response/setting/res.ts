import redisClient from "@src/config";
import { Text, useMessage, getConfigValue } from "alemonjs";
import { log } from "console";
const value = getConfigValue().aiChat || {};

const selects = onSelects(["message.create", "private.message.create"]);
// inline regex checks are used in-place; keep `test` as shorthand
const test = /(\/|#)测试$/i;
const capiContextLimitCommand =
  /^(#|\/)设置(AI)?上下文(长度)? ?([0-9]+)(k|m)$/i;
// 例: /设置识图ai gpt4v  /配置ocr xxx  /设置识图 关闭
const ocrAICommand = /^(#|\/)(配|配置|设置)(ocr|识图)(ai)?\s*(.*)$/i;
// 例: /设置文件 开启  /设置文件 关闭  /设置文件
const fileMessageCommand = /^(#|\/)设置文件\s*(.*)$/i;

const parseHeartbeatTime = (value: string) => {
  const dailyMatch = value.trim().match(/^(?:每天\s*)?(\d{1,2}):(\d{2})$/);
  if (dailyMatch) {
    const hour = Number(dailyMatch[1]);
    const minute = Number(dailyMatch[2]);
    if (hour > 23 || minute > 59) return null;
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= Date.now()) {
      next.setDate(next.getDate() + 1);
    }
    return { mode: "daily" as const, value: `${hour}:${minute}`, nextRunAt: next.getTime() };
  }

  const intervalMatch = value
    .trim()
    .match(/^(\d+)\s*(秒|秒钟|s|分钟|分|m|小时|时|h)$/i);
  if (!intervalMatch) return null;
  const amount = Number(intervalMatch[1]);
  const unit = intervalMatch[2].toLowerCase();
  const multiplier = ["小时", "时", "h"].includes(unit)
    ? 60 * 60 * 1000
    : ["分钟", "分", "m"].includes(unit)
      ? 60 * 1000
      : 1000;
  const intervalMs = amount * multiplier;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60 * 1000) return null;
  return {
    mode: "interval" as const,
    value: `${intervalMs}`,
    nextRunAt: Date.now() + intervalMs,
  };
};

const formatContextLimit = (tokens: number) => {
  if (tokens >= 1000000 && tokens % 1000000 === 0) {
    return `${tokens / 1000000}m`;
  }
  if (tokens >= 1000 && tokens % 1000 === 0) {
    return `${tokens / 1000}k`;
  }
  return `${tokens}`;
};

const parseContextLimit = (value: string, unit: string) => {
  const count = Number(value);
  const multiplier = unit.toLowerCase() === "m" ? 1000000 : 1000;
  return Math.floor(count * multiplier);
};

export default onResponse(selects, async (e, next) => {
  // 创建
  const [message] = useMessage(e);

  // 测试
  if (test.test(e.msg)) {
    // console.log(
    //   "测试调用",
    //   await availableTools.MemoryOperation({
    //     userID: e.UserId,
    //     operation: "get",
    //     dataType: "user",
    //     data: "",
    //   }),
    // );
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
    if (!e.IsMaster && e.name !== "private.message.create") {
      return;
    }
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
        if (!e.IsMaster) {
          return;
        }
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

  // 设置图床开关
  if (/(\/|#)(开启|关闭)图床$/i.test(e.msg)) {
    if (!e.IsMaster) {
      message.send(format(Text("仅管理员可设置全局图床开关。")));
      return;
    }
    const match = e.msg.match(/(\/|#)(开启|关闭)图床$/i);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/开启图床 或 /关闭图床 进行设置")),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redisClient.setImageBedSwitch(enable);
    message.send(
      format(
        Text(
          `已${enable ? "开启" : "关闭"}全局图床功能 !${enable ? "" : "\n当前全部 WebUI 将不再通过链接访问图片。"}`,
        ),
      ),
    );
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

  // 设置聊天频率限制
  if (/(\/|#)(开启|关闭)限制([0-9]+)?$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(开启|关闭)限制([0-9]+)?$/i);
    if (!match) {
      message.send(
        format(
          Text("格式错误，请按照 格式：#开启限制2 或 #关闭限制 进行设置"),
        ),
      );
      return;
    }
    const [, , action, numStr] = match;
    if (action === "开启") {
      const limit = Math.max(1, Math.floor(Number(numStr) || 2));
      await redisClient.setChatRateLimit(e.guid, limit);
      message.send(
        format(
          Text(
            `已开启聊天频率限制，每分钟最多接收 ${limit} 条消息，主人除外。\n格式：#开启限制<数量> 修改，#关闭限制 关闭`,
          ),
        ),
      );
    } else {
      await redisClient.setChatRateLimit(e.guid, 0);
      message.send(format(Text("已关闭聊天频率限制")));
    }
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

  // 设置识图/OCR 专用 AI（DeepSeek 等纯文本模型看图时调用）
  if (ocrAICommand.test(e.msg)) {
    const match = e.msg.match(ocrAICommand);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照：/设置识图ai <AI列表名称>\n查看：/设置识图\n关闭：/设置识图 关闭",
          ),
        ),
      );
      return;
    }

    const rawName = (match[5] || "").trim();
    const currentName = await redisClient.getOCRAIName(e.guid);
    const currentConfig = await redisClient.getOCRAIConfig(e.guid);

    // 无参数：查看当前配置
    if (!rawName) {
      if (!currentName) {
        message.send(
          format(
            Text(
              "当前未配置识图 AI。\n用法：/设置识图ai <AI列表名称>\n关闭：/设置识图 关闭\n提示：主模型无法看图时（deepseek、gpt-3.5、qwen 文本版等），收到图片会通过 DescribeImage 工具用该配置描述图片。",
            ),
          ),
        );
        return;
      }

      message.send(
        format(
          Text(
            [
              `当前识图 AI：${currentName}`,
              currentConfig
                ? `模型：${currentConfig.model}\n主机：${currentConfig.host}`
                : "警告：该名称在 AI 列表中不存在或配置不完整，请重新设置。",
              "关闭：/设置识图 关闭",
            ].join("\n"),
          ),
        ),
      );
      return;
    }

    // 关闭/清空
    if (/^(关闭|清空|清除|无|off|none|null)$/i.test(rawName)) {
      await redisClient.clearOCRAIName(e.guid);
      message.send(format(Text("已关闭识图 AI 配置。")));
      return;
    }

    // 设置到 AI 列表中的某个名称
    const aiList = await redisClient.getAIList();
    if (!aiList.includes(rawName)) {
      message.send(
        format(
          Text(
            `未找到 AI「${rawName}」。请先用 /添加ai 添加，或用 /ai列表 查看可用名称。`,
          ),
        ),
      );
      return;
    }

    await redisClient.setOCRAIName(e.guid, rawName);
    const ocrConfig = await redisClient.getOCRAIConfig(e.guid);
    message.send(
      format(
        Text(
          [
            `已设置识图 AI 为「${rawName}」`,
            ocrConfig
              ? `模型：${ocrConfig.model}\n主机：${ocrConfig.host}`
              : "",
            "当主模型无法看图时（deepseek、gpt-3.5、qwen 文本版等），收到图片会调用 DescribeImage 工具用此配置描述图片内容。",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ),
    );
    return;
  }

  // 设置文件消息处理开关
  if (fileMessageCommand.test(e.msg)) {
    const match = e.msg.match(fileMessageCommand);
    const rawArg = ((match && match[2]) || "").trim();
    const current = await redisClient.getFileMessageSwitch(e.guid);

    // 无参数：查看当前状态
    if (!rawArg) {
      message.send(
        format(
          Text(
            [
              `文件消息处理：${current === "1" ? "已开启" : "已关闭"}`,
              "开启后，用户发送的文件（含群文件上传、私聊文件、引用中的文件）会交给 AI 处理：文本类文件直接注入内容，其他文件提供下载链接供 AI 按需读取。",
              "开启：/设置文件 开启",
              "关闭：/设置文件 关闭",
            ].join("\n"),
          ),
        ),
      );
      return;
    }

    // 开启
    if (/^(开启|打开|启用|on|enable|1)$/i.test(rawArg)) {
      await redisClient.setFileMessageSwitch(e.guid, true);
      message.send(format(Text("已开启文件消息处理，用户发送的文件将交给 AI 处理。")));
      return;
    }

    // 关闭
    if (/^(关闭|关掉|停用|off|disable|0)$/i.test(rawArg)) {
      await redisClient.setFileMessageSwitch(e.guid, false);
      message.send(format(Text("已关闭文件消息处理，文件消息将不再交给 AI。")));
      return;
    }

    message.send(format(Text("格式错误，请使用：/设置文件 开启 或 /设置文件 关闭")));
    return;
  }

  // 设置 CAPI 自动压缩上下文长度
  if (capiContextLimitCommand.test(e.msg)) {
    const match = e.msg.match(capiContextLimitCommand);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/设置AI上下文长度 512k 进行设置")),
      );
      return;
    }

    const [, , , , value, unit] = match;
    const limit = parseContextLimit(value, unit);
    if (!Number.isFinite(limit) || limit <= 0) {
      message.send(
        format(Text("上下文长度必须大于 0，例如：/设置AI上下文长度 512k")),
      );
      return;
    }

    await redisClient.setCAPIContextLimit(e.guid, limit);
    message.send(
      format(
        Text(
          `已设置 CAPI 上下文长度为 ${formatContextLimit(limit)}，接近 90% 时会自动压缩上下文。`,
        ),
      ),
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
    if (!e.IsMaster) {
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

  // 设置主动搭话
  if (/(\/|#)关闭心跳$/i.test(e.msg)) {
    if (!e.IsMaster) {
      await message.send(format(Text("该指令仅主人可用")));
      return;
    }
    await redisClient.clearHeartbeatTask(e.guid);
    await message.send(format(Text("已关闭当前会话的 AI 心跳")));
    return;
  }

  if (/(\/|#)设置心跳\s+(.+)$/i.test(e.msg)) {
    if (!e.IsMaster) {
      await message.send(format(Text("该指令仅主人可用")));
      return;
    }
    const match = e.msg.match(/(\/|#)设置心跳\s+(.+)$/i);
    const parsed = match ? parseHeartbeatTime(match[2]) : null;
    if (!parsed) {
      await message.send(
        format(Text("格式错误，可使用：#设置心跳 08:00、#设置心跳 30m 或 #设置心跳 2小时")),
      );
      return;
    }
    if (!e.UserId || !e.Platform || (!e.IsPrivate && !e.SpaceId)) {
      await message.send(format(Text("当前消息缺少用户、平台或群聊信息，无法设置心跳")));
      return;
    }
    await redisClient.setHeartbeatTask({
      guid: e.guid,
      userID: String(e.UserId),
      platform: String(e.Platform),
      spaceId: String(e.SpaceId || ""),
      isPrivate: e.name === "private.message.create",
      mode: parsed.mode,
      value: parsed.value,
      nextRunAt: parsed.nextRunAt,
      createdAt: Date.now(),
    });
    await message.send(
      format(
        Text(
          `已设置 AI 心跳：${parsed.mode === "daily" ? `每天 ${parsed.value}` : `每 ${Number(parsed.value) / 60000} 分钟`}，下次触发时间：${new Date(parsed.nextRunAt).toLocaleString("zh-CN")}`,
        ),
      ),
    );
    return;
  }

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

  // 添加正则规则
  if (/(\/|#)添加正则规则 (.+)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)添加正则规则 (.+)$/i);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/添加正则规则 <正则表达式> 进行添加")),
      );
      return;
    }
    const [, , rule] = match;
    const success = await redisClient.addRegexRule(e.guid, rule.trim());
    if (!success) {
      message.send(format(Text("添加失败，规则已存在或正则表达式不合法！")));
      return;
    }
    message.send(format(Text(`正则规则添加成功：${rule.trim()}`)));
    return;
  }

  // 删除正则规则
  if (/(\/|#)(删除|移除)正则规则 (.+)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)(删除|移除)正则规则 (.+)$/i);
    if (!match) {
      message.send(
        format(Text("格式错误，请按照 格式：/删除正则规则 <规则序号或内容> 进行删除")),
      );
      return;
    }
    const [, , , ruleOrIndex] = match;
    const success = await redisClient.removeRegexRule(e.guid, ruleOrIndex.trim());
    if (!success) {
      message.send(format(Text("删除失败，未找到该规则！")));
      return;
    }
    message.send(format(Text("正则规则删除成功！")));
    return;
  }

  // 查看正则规则列表
  if (/(\/|#)正则规则列表$/i.test(e.msg)) {
    const rules = await redisClient.getRegexRules(e.guid);
    if (rules.length === 0) {
      message.send(format(Text("当前没有配置任何正则触发规则。")));
      return;
    }
    const ruleList = rules
      .map((rule, index) => `${index + 1}. ${rule}`)
      .join("\n");
    message.send(format(Text(`当前正则触发规则列表：\n${ruleList}`)));
    return;
  }

  // 清空正则规则
  if (/(\/|#)清空正则规则$/i.test(e.msg)) {
    await redisClient.clearRegexRules(e.guid);
    message.send(format(Text("已清空所有正则触发规则！")));
    return;
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

  // 控制工具提示开关
  if (/(\/|#)(开启|关闭)工具(调用)?提示$/i.test(e.msg)) {
    if (!e.IsMaster) {
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
    if (!e.IsMaster) {
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
    if (!e.IsMaster) {
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

  // 控制工具调用前 content 发送开关
  if (/(\/|#)(开启|关闭)工具调用内容$/i.test(e.msg)) {
    if (!e.IsMaster) {
      return;
    }
    const match = e.msg.match(/(\/|#)(开启|关闭)工具调用内容$/i);
    if (!match) {
      message.send(
        format(
          Text(
            "格式错误，请按照 格式：/开启工具调用内容 或 /关闭工具调用内容 进行设置",
          ),
        ),
      );
      return;
    }
    const [, , action] = match;
    const enable = action === "开启";
    await redisClient.setToolCallContentSwitch(e.guid, enable);
    message.send(
      format(Text(`已${enable ? "开启" : "关闭"}工具调用内容发送功能 !`)),
    );
    return;
  }

  // 控制 agent 和服务器管理工具权限
  if (/(\/|#)(开启|关闭)agent$/i.test(e.msg)) {
    if (!e.IsMaster) {
      await message.send(format(Text("该指令仅主人可用")));
      return;
    }
    const match = e.msg.match(/(\/|#)(开启|关闭)agent$/i);
    if (!match) return;
    const enable = match[2] === "开启";
    await redisClient.setAgentSwitch(e.guid, enable);
    await message.send(
      format(Text(`已${enable ? "开启" : "关闭"}当前会话的 agent 和服务器管理工具`)),
    );
    return;
  }

  // 控制工具开关
  if (/(\/|#)(开启|关闭)工具(.*)$/i.test(e.msg)) {
    if (!e.IsMaster) {
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

  // 设置渲染精度（中:80%, 高:100%, 超高:120%）
  if (/(\/|#)设置渲染精度\s*(中|高|超高)$/i.test(e.msg)) {
    const match = e.msg.match(/(\/|#)设置渲染精度\s*(中|高|超高)$/i);
    if (!match) return;
    const level = match[2];
    await redisClient.setRenderPrecision(e.guid, level);
    const scaleMap: Record<string, string> = { "中": "80%", "高": "100%", "超高": "120%" };
    message.send(format(Text(`已设置渲染精度为 ${level} (${scaleMap[level]})`)));
    return;
  }

  next();
});
