import { spawn } from "node:child_process";
import { Text } from "alemonjs";
import { useMessage } from "@src/utils/command-message";
import { COMMAND_OUTPUT_CAPTURE } from "@src/utils/command-message";
import redisClient from "@src/config";
import { PM2_PROCESS_ID } from "@src/api/runtime-instance";

export const selects = onSelects(["message.create", "private.message.create"]);

export default onResponse(selects, async (e) => {
  const [message] = useMessage(e);

  if (!e.IsMaster) {
    await message.send(format(Text("该指令仅主人可用")));
    return;
  }

  const capture = e?.[COMMAND_OUTPUT_CAPTURE];
  const aiTriggered = Boolean(capture);
  if (!/^\d+$/.test(PM2_PROCESS_ID)) {
    await message.send(
      format(Text("无法确定当前 PM2 线程，已取消重启，避免影响其他进程")),
    );
    return;
  }

  // 无论手动还是 AI 调用，都由重启后的当前线程发送成功回执。
  const recoveryTask = await redisClient.createRestartRecoveryTask({
    targetProcessId: PM2_PROCESS_ID,
    guid: String(e.guid || ""),
    userID: String(e.UserId || ""),
    platform: String(e.Platform || ""),
    spaceId: String(e.SpaceId || e.ChannelId || e.guid || ""),
    isPrivate: e.name === "private.message.create",
    isMaster: e.IsMaster === true,
    resumeAI: aiTriggered,
    prompt: aiTriggered
      ? "[系统恢复通知] 你刚才通过 /重启 触发的当前线程重启已经完成，系统已向用户发送成功提示。请结合此前对话，从中断处继续执行剩余任务。不要再次重启，除非用户明确提出。"
      : "",
  });

  if (aiTriggered) {
    // 重启会中断本次工具调用，必须让状态消息直接送达用户。
    capture.sendToUser = true;
  }

  await message.send(
    format(
      Text(
        aiTriggered
          ? "正在重启当前线程，完成后 AI 会自动继续当前任务..."
          : "正在重启当前线程...",
      ),
    ),
  );

  let failureReported = false;
  const reportRestartFailure = async (error: unknown) => {
    if (failureReported) return;
    failureReported = true;
    await redisClient.deleteRestartRecoveryTask(recoveryTask.id);
    console.error(`执行 pm2 restart ${PM2_PROCESS_ID} 失败：`, error);
    await message.send(format(Text("重启失败，请查看控制台日志")));
  };

  try {
    const child = spawn(
      process.platform === "win32" ? "pm2.cmd" : "pm2",
      ["restart", PM2_PROCESS_ID],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.once("error", (error) => {
      void reportRestartFailure(error);
    });
    child.unref();
  } catch (error) {
    await reportRestartFailure(error);
  }
});
