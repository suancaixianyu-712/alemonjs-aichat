import { getConfigValue } from "alemonjs";
import Redis from "ioredis";
import fs from "fs";

const value = getConfigValue().aiChat || getConfigValue() || {};

/** 常见的 Redis Unix Socket 路径 */
const REDIS_SOCKET_PATHS = [
  "/var/run/redis/redis-server.sock",
  "/run/redis/redis-server.sock",
  "/tmp/redis.sock",
  "/var/run/redis/redis.sock",
];

/**
 * 检查 Unix Socket 是否可用
 * @returns 可用的 socket 路径，或 null
 */
function detectRedisSocket(): string | null {
  for (const socketPath of REDIS_SOCKET_PATHS) {
    try {
      if (fs.existsSync(socketPath)) {
        const stat = fs.statSync(socketPath);
        if (stat.isSocket()) {
          console.log(`[Redis] 检测到可用的 Unix Socket: ${socketPath}`);
          return socketPath;
        }
      }
    } catch (err) {
      // 忽略错误，继续检查下一个路径
    }
  }
  return null;
}

/**
 * 创建 Redis 连接，优先使用 Unix Socket（如果可用且未配置 host）
 */
function createRedisConnection() {
  const configuredHost = value.redis?.host;
  const configuredPort = value.redis?.port;
  const password = value.redis?.password ?? "";
  const username = value.redis?.user ?? "";

  // 如果配置了 host（非空），直接使用配置
  if (configuredHost && configuredHost.trim() !== "") {
    console.log(`[Redis] 当前连接方式: TCP (${configuredHost}:${configuredPort || 6379})`);
    return new Redis({
      host: configuredHost,
      port: configuredPort ?? 6379,
      password,
      username,
    });
  }

  // 未配置 host，尝试检测 Unix Socket
  const socketPath = detectRedisSocket();
  if (socketPath) {
    console.log(`[Redis] 当前连接方式: Unix Socket (${socketPath})`);
    return new Redis({
      path: socketPath,
      password,
    });
  }

  // 没有 Unix Socket，使用默认 TCP
  console.log(`[Redis] 当前连接方式: TCP (localhost:6379)`);
  return new Redis({
    host: "localhost",
    port: 6379,
    password,
    username,
  });
}

export const redis = createRedisConnection();
