import { MessageDirect, format, Text } from 'alemonjs';
import redisClient from './config.js';
import { CApiReply } from './response/zreply/capi.js';
import { formatRestartDuration } from './api/restart-recovery.js';
import { shouldRunHeartbeat, computeNextHeartbeatRunAt } from './api/random-heartbeat.js';

const SCHEDULER_INTERVAL_MS = 30_000;
const runningTasks = new Set();
const getSyntheticPrompt = (task) => "heartbeat" in task && task.heartbeat
    ? "心跳"
    : "prompt" in task
        ? task.prompt
        : "";
const createSyntheticEvent = (task) => {
    const prompt = getSyntheticPrompt(task);
    const messageText = "restartRecovery" in task && task.restartRecovery
        ? prompt
        : `定时任务：${prompt}`;
    const heartbeat = "heartbeat" in task && task.heartbeat === true;
    return {
        name: task.isPrivate ? "private.message.create" : "message.create",
        guid: task.guid,
        UserId: task.userID,
        UserName: task.userID,
        Platform: task.platform,
        SpaceId: task.spaceId,
        GroupName: task.isPrivate ? "" : task.spaceId,
        IsMaster: "isMaster" in task ? task.isMaster : false,
        IsPrivate: task.isPrivate,
        at: false,
        atBot: false,
        regexTriggered: true,
        heartbeat,
        heartbeatPermissionMode: heartbeat
            ? ("permissionMode" in task && task.permissionMode) || "auto"
            : undefined,
        heartbeatAiName: heartbeat
            ? ("aiName" in task && task.aiName) || undefined
            : undefined,
        restartRecovery: "restartRecovery" in task && task.restartRecovery,
        msg: messageText,
        MessageText: messageText,
        raw_message: prompt,
        value: {
            raw_message: prompt,
            message: [],
        },
        bot: {
            nickname: "小咸鱼",
            user_id: "__scheduled_task__",
        },
        botInfoFault: true,
    };
};
const createDirectOutput = (task) => {
    const direct = MessageDirect.create();
    const sendFormat = async (data) => {
        if ("heartbeat" in task && task.heartbeat) {
            const text = JSON.stringify(data);
            if (/NO_ACTION|\[\s*\]/i.test(text))
                return [];
        }
        if (task.isPrivate) {
            return direct.sendToUser({ OpenID: task.userID, format: data });
        }
        return direct.sendToChannel({ SpaceId: task.spaceId, format: data });
    };
    return {
        send: sendFormat,
        sendText: (text) => sendFormat(format(Text(text))),
        sendToolResult: async () => undefined,
    };
};
const triggerTask = async (task, taskKey = "id" in task ? task.id : `heartbeat:${task.guid}`) => {
    if (runningTasks.has(taskKey))
        return;
    runningTasks.add(taskKey);
    try {
        await CApiReply(createSyntheticEvent(task), createDirectOutput(task));
    }
    catch (error) {
        logger.error({
            message: "定时 AI 任务执行失败",
            taskId: taskKey,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        runningTasks.delete(taskKey);
    }
};
const runScheduledAITasks = async () => {
    const now = Date.now();
    const tasks = await redisClient.getScheduledAITasks();
    for (const task of tasks) {
        if (task.runAt > now || runningTasks.has(task.id))
            continue;
        if (task.repeat === "daily") {
            const nextRunAt = new Date(task.runAt);
            do {
                nextRunAt.setDate(nextRunAt.getDate() + 1);
            } while (nextRunAt.getTime() <= now);
            await redisClient.updateScheduledAITask({ ...task, runAt: nextRunAt.getTime() });
        }
        else {
            await redisClient.deleteScheduledAITask(task.guid, task.id);
        }
        void triggerTask(task);
    }
    const heartbeats = await redisClient.getAllHeartbeatTasks();
    for (const heartbeat of heartbeats) {
        const taskKey = `heartbeat:${heartbeat.guid}`;
        if (!shouldRunHeartbeat(heartbeat, now) || runningTasks.has(taskKey)) {
            continue;
        }
        const nextRunAt = computeNextHeartbeatRunAt(heartbeat, now);
        if (heartbeat.mode === "random" &&
            heartbeat.ceilingMs != null &&
            heartbeat.ceilingMs < (heartbeat.minMs ?? 0)) {
            logger.warn?.({
                message: "随机心跳 ceiling 小于 min，已按 ceiling 夹紧",
                guid: heartbeat.guid,
                ceilingMs: heartbeat.ceilingMs,
                minMs: heartbeat.minMs,
            });
        }
        await redisClient.setHeartbeatTask({ ...heartbeat, nextRunAt });
        void triggerTask({
            ...heartbeat,
            heartbeat: true,
            heartbeatPermissionMode: heartbeat.permissionMode || "auto",
            heartbeatAiName: heartbeat.aiName || undefined,
        }, taskKey);
    }
};
/** 当前 PM2 线程重启后发送回执，并按需续接被 AI 中断的任务。 */
const resumeRestartRecoveryTasks = async () => {
    const tasks = await redisClient.consumeRestartRecoveryTasks();
    for (const task of tasks) {
        await redisClient.clearAITransientState(task.guid);
        const output = createDirectOutput(task);
        const elapsed = formatRestartDuration(Date.now() - task.createdAt);
        await output.sendText(task.resumeAI
            ? `当前线程重启成功，耗时 ${elapsed}。AI 正在继续刚才的任务...`
            : `当前线程重启成功，耗时 ${elapsed}。`);
        if (task.resumeAI) {
            void triggerTask(task, `restart-recovery:${task.id}`);
        }
    }
};
const startScheduledAITaskScheduler = () => {
    const timer = setInterval(() => {
        runScheduledAITasks().catch((error) => {
            logger.error({
                message: "定时 AI 任务轮询失败",
                error: error instanceof Error ? error.message : String(error),
            });
        });
        resumeRestartRecoveryTasks().catch((error) => {
            logger.error({
                message: "重启后的任务恢复轮询失败",
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
    const recoveryTimer = setTimeout(() => {
        resumeRestartRecoveryTasks().catch((error) => {
            logger.error({
                message: "重启后的 AI 任务恢复失败",
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }, 2500);
    recoveryTimer.unref?.();
    return timer;
};

export { startScheduledAITaskScheduler };
