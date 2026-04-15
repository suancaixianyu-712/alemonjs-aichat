import { redis } from "./redis";
import commands from "./routes/commands";
import middleware from "./routes/middleware";

export default defineChildren({
  register() {
    return {
      middlewareRouter: middleware,
      responseRouter: commands,
    };
  },
  onCreated() {
    logger.info({
      message: "本地测试启动",
    });
    redis.get("ai:list").catch((error) => {
      logger.error({
        message: "Redis连接失败, 大部分功能将无法使用",
        error: error.message,
      });
    });
  },
});
