import { randomUUID } from "node:crypto";

/** 当前 Node.js 进程实例标识；进程重启后必然变化。 */
export const PROCESS_INSTANCE_ID = randomUUID();

/** PM2 为每个进程分配的稳定 ID；单实例重启后保持不变。 */
export const PM2_PROCESS_ID = String(process.env.pm_id || "").trim();
