import { MessageDirect, Text, format } from "alemonjs";
import redisClient from "./config";
import type { HeartbeatTask, ScheduledAITask } from "./config";
import { CApiReply } from "./response/zreply/capi";

const SCHEDULER_INTERVAL_MS = 30_000;
const runningTasks = new Set<string>();

type TriggerTask = ScheduledAITask | (HeartbeatTask & { heartbeat: true });

const createSyntheticEvent = (task: TriggerTask) => ({
  name: task.isPrivate ? "private.message.create" : "message.create",
  guid: task.guid,
  UserId: task.userID,
  UserName: task.userID,
  Platform: task.platform,
  SpaceId: task.spaceId,
  GroupName: task.isPrivate ? "" : task.spaceId,
  IsMaster: false,
  IsPrivate: task.isPrivate,
  at: false,
  atBot: false,
  regexTriggered: true,
  heartbeat: "heartbeat" in task && task.heartbeat,
  msg: `定时任务：${"prompt" in task ? task.prompt : "心跳"}`,
  MessageText: `定时任务：${"prompt" in task ? task.prompt : "心跳"}`,
  raw_message: "prompt" in task ? task.prompt : "心跳触发",
  value: {
    raw_message: "prompt" in task ? task.prompt : "心跳触发",
    message: [],
  },
  bot: {
    nickname: "小咸鱼",
    user_id: "__scheduled_task__",
  },
});

const createDirectOutput = (task: TriggerTask) => {
  const direct = MessageDirect.create();
  const sendFormat = async (data: any) => {
    if ("heartbeat" in task && task.heartbeat) {
      const text = JSON.stringify(data);
      if (/NO_ACTION|\[\s*\]/i.test(text)) return [];
    }
    if (task.isPrivate) {
      return direct.sendToUser({ OpenID: task.userID, format: data });
    }
    return direct.sendToChannel({ SpaceId: task.spaceId, format: data });
  };

  return {
    send: sendFormat,
    sendText: (text: string) => sendFormat(format(Text(text))),
    sendToolResult: async () => undefined,
  };
};

const triggerTask = async (
  task: TriggerTask,
  taskKey = "id" in task ? task.id : `heartbeat:${task.guid}`,
) => {
  if (runningTasks.has(taskKey)) return;
  runningTasks.add(taskKey);
  try {
    await CApiReply(
      createSyntheticEvent(task) as any,
      createDirectOutput(task),
    );
  } catch (error) {
    logger.error({
      message: "定时 AI 任务执行失败",
      taskId: taskKey,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    runningTasks.delete(taskKey);
  }
};

const runScheduledAITasks = async () => {
  const now = Date.now();
  const tasks = await redisClient.getScheduledAITasks();

  for (const task of tasks) {
    if (task.runAt > now || runningTasks.has(task.id)) continue;

    if (task.repeat === "daily") {
      const nextRunAt = new Date(task.runAt);
      do {
        nextRunAt.setDate(nextRunAt.getDate() + 1);
      } while (nextRunAt.getTime() <= now);
      await redisClient.updateScheduledAITask({ ...task, runAt: nextRunAt.getTime() });
    } else {
      await redisClient.deleteScheduledAITask(task.guid, task.id);
    }

    void triggerTask(task);
  }

  const heartbeats = await redisClient.getAllHeartbeatTasks();
  for (const heartbeat of heartbeats) {
    const taskKey = `heartbeat:${heartbeat.guid}`;
    if (heartbeat.nextRunAt > now || runningTasks.has(taskKey)) continue;

    const nextRunAt =
      heartbeat.mode === "daily"
        ? heartbeat.nextRunAt + 24 * 60 * 60 * 1000
        : heartbeat.nextRunAt + Number(heartbeat.value);
    await redisClient.setHeartbeatTask({ ...heartbeat, nextRunAt });
    void triggerTask({ ...heartbeat, heartbeat: true }, taskKey);
  }
};

export const startScheduledAITaskScheduler = () => {
  const timer = setInterval(() => {
    runScheduledAITasks().catch((error) => {
      logger.error({
        message: "定时 AI 任务轮询失败",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, SCHEDULER_INTERVAL_MS);
  timer.unref?.();
  void runScheduledAITasks().catch((error) => {
    logger.error({
      message: "定时 AI 任务首次轮询失败",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return timer;
};
