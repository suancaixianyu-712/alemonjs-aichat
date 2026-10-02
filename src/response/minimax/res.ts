import { Text } from "alemonjs";
import { redis } from "@src/redis";
import { useMessage } from "@src/utils/command-message";

const MINIMAX_API_KEY = "minimax_api_key";
const selects = onSelects(["message.create", "private.message.create"]);

const maskKey = (key: string) =>
  key.length <= 8 ? `${key.slice(0, 2)}****` : `${key.slice(0, 4)}****${key.slice(-4)}`;

export default onResponse(selects, async (e, next) => {
  const text = String(e.msg || e.MessageText || "").trim();
  const match = text.match(
    /^(?:#|\/)\s*(设置|清空)?\s*minimax\s*(?:密钥|秘钥)(?:\s+(\S+))?\s*$/i,
  );
  if (!match) return next();

  const [message] = useMessage(e);
  const reply = (value: string) => message.send(format(Text(value)));
  if (e.IsMaster !== true) {
    await reply("该指令仅主人可用");
    return;
  }

  const action = match[1] || "";
  const secret = String(match[2] || "").trim();
  if (action === "清空") {
    if (secret) {
      await reply("格式：#清空minimax密钥");
      return;
    }
    await redis.del(MINIMAX_API_KEY);
    await reply("已清空 MiniMax 密钥。");
    return;
  }

  if (secret) {
    if (e.name !== "private.message.create") {
      await reply("请在私聊中设置 MiniMax 密钥，避免密钥出现在群聊记录里。");
      return;
    }
    await redis.set(MINIMAX_API_KEY, secret);
    await reply(
      `已保存 MiniMax 密钥：${maskKey(secret)}\nMiniMaxVoice 会使用该密钥，默认音色 voice_neko_2。`,
    );
    return;
  }

  const current = String((await redis.get(MINIMAX_API_KEY)) || "").trim();
  await reply(
    current
      ? `MiniMax 密钥已配置：${maskKey(current)}\n更新请私聊发送：#设置minimax密钥 <密钥>\n清空：#清空minimax密钥`
      : "尚未配置 MiniMax 密钥。\n请在私聊发送：#设置minimax密钥 <密钥>",
  );
});
