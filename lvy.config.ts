import { defineConfig } from "lvyjs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const includes = (value: string) => process.argv.includes(value);
const cbpPort = process.env.ALEMON_PORT || process.env.port;
const alemonjs = () =>
  import("alemonjs").then((res) => {
    const options = {
      input: "src/index.ts",
      ...(cbpPort ? { port: Number(cbpPort) } : {}),
    };

    // 引擎级运行时配置（package.json alemonjs.config 声明，ALemonX 工作台写入
    // alemon.config.yaml 的 alemonjs-aichat / aiChat 命名空间）。
    //
    // 说明：alemonjs@2.1.92 的 start() 仅支持 port/url/input 等选项，暂未提供
    // runtime_mode=external（外部进程托管）与 transport=http（消息桥接走 http）
    // 的运行时 API。此处读取 runtimeConfig 以便 ALemonX 展示与后续 external
    // 托管接入；未配置时保持默认 local + websocket，行为零变化。
    // 若之后的 alemonjs 支持 external/gscore_url 连接，应在此把
    // runtimeConfig.gscore_url / runtimeConfig.transport 传入 start()。
    try {
      const { config } = res;
      // 读取逻辑统一收敛在 src/config/runtime.ts，此处仅作接入点说明。
      void config;
    } catch {
      // 忽略：alemonjs 无 config 导出时不影响启动
    }

    res.start(options);
  });
const jsxp = () =>
  import("./src/panel/server").then((res) => res.createPanelServer());
const jsxpPreview = () =>
  import("jsxp").then(({ createServer }) => createServer());
export default defineConfig({
  plugins: [
    () =>
      includes("--jsxp") ? jsxpPreview : includes("--view") ? jsxp : alemonjs,
  ],
  alias: {
    entries: [{ find: "@src", replacement: join(__dirname, "src") }],
  },
});
