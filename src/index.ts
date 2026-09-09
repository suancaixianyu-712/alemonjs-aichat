import { redis } from "./redis";
import commands from "./routes/commands";
import middleware from "./routes/middleware";
import { createPanelRouter } from "./panel/server";
import { startScheduledAITaskScheduler } from "./scheduler";
import { getRuntimeConfig } from "./config/runtime";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setupGlobalProxy } from "./utils/proxy";

export default defineChildren({
  register() {
    return {
      middlewareRouter: middleware,
      responseRouter: commands,
      koaRouter: createPanelRouter({ hosted: true }),
    };
  },
  onCreated() {
    // 全局代理：配置了 aiChat.proxy 时，所有 fetch / undici 请求统一走代理
    // （含 openai、ai-sdk 等三方 SDK）。未配置时行为不变。
    setupGlobalProxy();

    const runtimeConfig = getRuntimeConfig();
    mkdirSync(path.resolve(process.cwd(), "public", "knowledge"), {
      recursive: true,
    });

    logger.info({
      message: "本地测试启动",
    });

    // 引擎级运行时配置（package.json alemonjs.config 声明，ALemonX 工作台写入
    // alemon.config.yaml 的 alemonjs-aichat / aiChat 命名空间）。
    //
    // 说明：alemonjs@2.1.92 的 start() 仅支持 port/url/input 等选项，暂未提供
    // runtime_mode=external（外部进程托管）与 transport=http（消息桥接走 http）
    // 的运行时 API。此处仅读取并记录，用于 ALemonX 展示与后续外部托管接入；
    // 未配置时保持默认 local + websocket，行为零变化。
    // 若之后版本的 alemonjs 支持 external/gscore_url 连接，应在此读取
    // runtimeConfig.gscore_url / runtimeConfig.transport 并传给 start()。
    logger.info({
      message: "运行时模式",
      runtime_mode: runtimeConfig.runtime_mode,
      transport: runtimeConfig.transport,
      gscore_url: runtimeConfig.gscore_url ? "已配置" : "未配置",
    });
    redis.get("ai:list").catch((error) => {
      logger.error({
        message: "Redis连接失败, 大部分功能将无法使用",
        error: error.message,
      });
    });
    startScheduledAITaskScheduler();
  },
});
