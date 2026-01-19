import { getConfigValue } from "alemonjs";
import Redis from "ioredis";
const value = getConfigValue();

const redisConfig = {
  host: value.redis?.host ?? "localhost",
  port: value.redis?.port ?? 6379,
  password: value.redis?.password ?? "",
};

export const redis = new Redis(redisConfig);
