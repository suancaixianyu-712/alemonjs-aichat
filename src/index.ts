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
    redis
      .get("ai:list")
      .then((value) => {
        logger.info({
          message: "Redis连接成功，测试键值已获取",
          value: value,
        });
      })
      .catch((error) => {
        logger.error({
          message: "Redis连接失败",
          error: error.message,
        });
      });
  },
});
