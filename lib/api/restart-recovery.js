import { randomUUID } from 'node:crypto';
import { PROCESS_INSTANCE_ID } from './runtime-instance.js';

const RESTART_RECOVERY_TTL_SECONDS = 10 * 60;
const buildRestartRecoveryTask = (input, options = {}) => ({
    ...input,
    id: options.id || randomUUID(),
    ownerId: options.ownerId || PROCESS_INSTANCE_ID,
    createdAt: options.now ?? Date.now(),
    restartRecovery: true,
});
const parseRestartRecoveryTask = (raw, now = Date.now()) => {
    try {
        const task = JSON.parse(raw);
        if (task?.restartRecovery !== true ||
            !task.id ||
            !task.ownerId ||
            !task.targetProcessId ||
            !task.guid ||
            !task.userID ||
            !Number(task.createdAt) ||
            now - Number(task.createdAt) > RESTART_RECOVERY_TTL_SECONDS * 1000) {
            return null;
        }
        return task;
    }
    catch {
        return null;
    }
};
/** 旧进程不能提前消费自己刚写入的恢复任务。 */
const canConsumeRestartRecoveryTask = (task, currentOwnerId = PROCESS_INSTANCE_ID, currentProcessId = String(process.env.pm_id || "").trim()) => task.ownerId !== currentOwnerId &&
    Boolean(currentProcessId) &&
    task.targetProcessId === currentProcessId;
const formatRestartDuration = (elapsedMilliseconds) => {
    const seconds = Math.max(0, elapsedMilliseconds) / 1000;
    return `${seconds.toFixed(2)} 秒`;
};

export { RESTART_RECOVERY_TTL_SECONDS, buildRestartRecoveryTask, canConsumeRestartRecoveryTask, formatRestartDuration, parseRestartRecoveryTask };
