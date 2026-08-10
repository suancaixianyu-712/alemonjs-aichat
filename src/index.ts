import { redis } from "./redis";
import commands from "./routes/commands";
import middleware from "./routes/middleware";
import { createPanelServer } from "./panel/server";
import { startScheduledAITaskScheduler } from "./scheduler";

const startPanelServer = () => {
  if (process.env.AICHAT_PANEL_DISABLED === "1") return;

  createPanelServer().catch((error) => {
    logger.error({
      message: "网页控制台启动失败",
      error: error instanceof Error ? error.message : String(error),
    });
  });
};

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
    startScheduledAITaskScheduler();
    startPanelServer();
  },
});
