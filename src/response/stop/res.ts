import { Text } from "alemonjs";
import { useMessage } from "@src/utils/command-message";
import { abortAITurns } from "@src/api/ai-turn";
import { abortOpencodeRuns } from "@src/api/opencode";
import redisClient from "@src/config";

export const selects = onSelects(["message.create", "private.message.create"]);

export default onResponse(selects, async (e) => {
  const [message] = useMessage(e);

  const { aborted: aiTurnsAborted } = abortAITurns({
    guid: e.guid,
    platform: e.Platform,
  });
  const [{ aborted: opencodeRunsAborted }] = await Promise.all([
    abortOpencodeRuns({ guid: e.guid }),
    redisClient.setAIToolLoopProcessing(e.guid, false, e.Platform),
    redisClient.drainAIGuidanceMessages(e.guid, e.Platform),
  ]);

  if (aiTurnsAborted > 0) {
    await message.send(format(Text("已停止当前这轮 AI 回复")));
  } else if (opencodeRunsAborted > 0) {
    await message.send(
      format(Text(`已终止 ${opencodeRunsAborted} 个正在运行的任务`)),
    );
  } else {
    await message.send(format(Text("当前没有正在运行的任务")));
  }
});
