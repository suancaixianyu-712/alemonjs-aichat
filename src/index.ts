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
  },
});
