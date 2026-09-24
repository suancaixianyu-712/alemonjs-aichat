import { randomUUID } from "node:crypto";
import { PROCESS_INSTANCE_ID } from "./runtime-instance";

export const RESTART_RECOVERY_TTL_SECONDS = 10 * 60;

export type RestartRecoveryTask = {
  id: string;
  ownerId: string;
  targetProcessId: string;
  guid: string;
  userID: string;
  platform: string;
  spaceId: string;
  isPrivate: boolean;
  isMaster: boolean;
  prompt: string;
  resumeAI: boolean;
  createdAt: number;
  restartRecovery: true;
};

export const buildRestartRecoveryTask = (
  input: Omit<
    RestartRecoveryTask,
    "id" | "ownerId" | "createdAt" | "restartRecovery"
  >,
  options: { id?: string; ownerId?: string; now?: number } = {},
): RestartRecoveryTask => ({
  ...input,
  id: options.id || randomUUID(),
  ownerId: options.ownerId || PROCESS_INSTANCE_ID,
  createdAt: options.now ?? Date.now(),
  restartRecovery: true,
});

export const parseRestartRecoveryTask = (
  raw: string,
  now = Date.now(),
): RestartRecoveryTask | null => {
  try {
    const task = JSON.parse(raw) as RestartRecoveryTask;
    if (
      task?.restartRecovery !== true ||
      !task.id ||
      !task.ownerId ||
      !task.targetProcessId ||
      !task.guid ||
      !task.userID ||
      !Number(task.createdAt) ||
      now - Number(task.createdAt) > RESTART_RECOVERY_TTL_SECONDS * 1000
    ) {
      return null;
    }
    return task;
  } catch {
    return null;
  }
};

/** 旧进程不能提前消费自己刚写入的恢复任务。 */
export const canConsumeRestartRecoveryTask = (
  task: RestartRecoveryTask,
  currentOwnerId = PROCESS_INSTANCE_ID,
  currentProcessId = String(process.env.pm_id || "").trim(),
) =>
  task.ownerId !== currentOwnerId &&
  Boolean(currentProcessId) &&
  task.targetProcessId === currentProcessId;

export const formatRestartDuration = (elapsedMilliseconds: number) => {
  const seconds = Math.max(0, elapsedMilliseconds) / 1000;
  return `${seconds.toFixed(2)} 秒`;
};
