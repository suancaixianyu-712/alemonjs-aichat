import { availableTools } from "@src/api";
import { Text, useMessage, getConfigValue } from "alemonjs";
const value = getConfigValue();

const selects = onSelects(["message.create", "private.message.create"]);

export default onResponse(selects, async (e, next) => {
  // 创建
  const [message] = useMessage(e);

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

  // ollama安装模型
  if (/(\/|#)ollama ?(add|install|push|pull|安装模型) ?(.+)$/i.test(e.msg)) {
    const match = e.msg.match(
      /(\/|#)ollama ?(add|install|push|pull|安装模型) ?(.+)$/i,
    );
    const modelName = match[3].trim();
    if (!modelName) {
      message.send(
        format(
          Text(
            "请提供要安装的模型名称，例如：\n#ollama 安装模型 gpt-3.5-turbo",
          ),
        ),
      );
      return;
    }
    message.send(format(Text(`正在安装 Ollama 模型 ${modelName}，请稍候...`)));
    const result = await availableTools.OllamaInstallModel(modelName);
    if (result.success) {
      message.send(format(Text(`Ollama 模型 ${modelName} 安装成功！`)));
    } else {
      message.send(
        format(Text(`Ollama 模型 ${modelName} 安装失败：${result.error}`)),
      );
    }
    return;
  }

  // 无匹配则继续下一个响应器
  next();
});
