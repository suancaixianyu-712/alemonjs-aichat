import Redis from "ioredis";
import fs from "fs";
import { getAiChatConfigValue } from "./config/app";

const value = getAiChatConfigValue();

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
          return socketPath;
        } else {
          console.log(`[Redis] 文件存在但非 Socket 类型: ${socketPath}`);
        }
      }
    } catch (err: any) {
      console.log(`[Redis] 检查 Socket 路径失败: ${socketPath} (${err.message})`);
    }
  }
  console.log(`[Redis] 未检测到可用的 Unix Socket，已检查路径: ${REDIS_SOCKET_PATHS.join(", ")}`);
  return null;
}

/**
 * 创建 Redis 连接，优先使用 Unix Socket（如果可用且未配置 host）
 */
function createRedisConnection() {
  const configuredHost = value.redis?.host;
  const configuredPort = value.redis?.port;
  const configuredSocket = value.redis?.socket;
  const password = value.redis?.password ?? "";
  const username = value.redis?.user ?? "";

  // 如果配置了 host（非空），直接使用 TCP
  if (configuredHost && configuredHost.trim() !== "") {
    console.log(`[Redis] 当前连接方式: TCP (${configuredHost}:${configuredPort || 6379})`);
    return new Redis({
      host: configuredHost,
      port: configuredPort ?? 6379,
      password,
      username,
    });
  }

  // 配置了 socket 路径，直接使用
  if (configuredSocket && configuredSocket.trim() !== "") {
    console.log(`[Redis] 当前连接方式: Unix Socket (${configuredSocket})`);
    return new Redis({
      path: configuredSocket,
      password,
    });
  }

  // 未配置 host 和 socket，尝试自动检测 Unix Socket
  const socketPath = detectRedisSocket();
  if (socketPath) {
    console.log(`[Redis] 当前连接方式: Unix Socket (${socketPath})`);
    return new Redis({
      path: socketPath,
      password,
    });
  }

  // 都没有，使用默认 TCP
  console.log(`[Redis] 当前连接方式: TCP (localhost:6379)`);
  console.log(`[Redis] 提示: 如需使用 Unix Socket，请在配置文件 redis.socket 中指定路径`);
  return new Redis({
    host: "localhost",
    port: 6379,
    password,
    username,
  });
}

export const redis = createRedisConnection();
