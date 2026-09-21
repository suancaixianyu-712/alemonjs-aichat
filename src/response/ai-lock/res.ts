import redisClient from "@src/config";
import {
  formatAIListWithLocks,
  resolveAISelection,
} from "@src/api/ai-lock";
import { Text } from "alemonjs";
import { useMessage } from "@src/utils/command-message";

const selects = onSelects(["message.create", "private.message.create"]);

const usage = [
  "用法：",
  "#锁定AI 1 3 5",
  "#解锁AI 1,3,5",
  "#锁定AI 1-3",
  "序号以 #AI列表 当前显示为准。",
].join("\n");

export default onResponse(selects, async (event) => {
  const [message] = useMessage(event);
  if (event.IsMaster !== true) {
    await message.send(format(Text("仅主人可以锁定或解锁 AI 配置。")));
    return;
  }

  const text = String(event.msg || "").trim();
  const aiList = await redisClient.getAIList();
  const lockedAI = await redisClient.getLockedAIList();

  if (/^(#|\/)锁定ai列表$/i.test(text)) {
    const formatted = formatAIListWithLocks(aiList, lockedAI);
    await message.send(
      format(
        Text("当前 AI 锁定状态：\n"),
        Text(formatted.length > 0 ? formatted.join("\n") : "暂无 AI 配置"),
        Text(`\n\n${usage}`),
      ),
    );
    return;
  }

  const command = text.match(/^(#|\/)(锁定|解锁)ai(?:\s+([\s\S]+))?$/i);
  if (!command) return;
  const action = command[2];
  const selection = resolveAISelection(String(command[3] || ""), aiList);
  if (!selection.ok) {
    await message.send(
      format(
        Text(`操作失败，无效序号或名称：${selection.invalid.join("、")}\n`),
        Text(usage),
      ),
    );
    return;
  }

  if (action === "锁定") {
    await redisClient.lockAI(selection.names);
  } else {
    await redisClient.unlockAI(selection.names);
  }
  await message.send(
    format(
      Text(
        `已${action} ${selection.names.length} 个 AI 配置：\n${selection.names.join("\n")}`,
      ),
    ),
  );
});
