import { getIoRedis } from "@alemonjs/db";

/** 使用 AlemonJS 全局共享的 Redis 连接。 */
export const redis = getIoRedis();
