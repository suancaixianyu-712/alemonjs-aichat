import { Text, useMessage } from "alemonjs";
import { abortOpencodeRuns } from "@src/api/opencode";

export const selects = onSelects(["message.create", "private.message.create"]);

export default onResponse(selects, async (e) => {
  const [message] = useMessage(e);

  const { aborted } = await abortOpencodeRuns({ guid: e.guid });

  if (aborted > 0) {
    await message.send(format(Text(`已终止 ${aborted} 个正在运行的任务`)));
  } else {
    await message.send(format(Text("当前没有正在运行的任务")));
  }
});