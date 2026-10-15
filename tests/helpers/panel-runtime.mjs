import { mock } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Koa from "koa";

// 只替换存储和 AI 外部依赖；页面、操作路由、群配置服务和框架挂载均使用构建产物。
export const calls = [];
const ai = {
  host: "https://example.invalid/v1",
  key: "test-key",
  model: "test-model",
  systemPrompt: "测试提示词",
};
const configs = new Map();
const values = new Map();
const redisStore = new Map([["ai:currentAI:test-group", "Test AI"]]);
export const client = new Proxy(
  {
    redis: {
      keys: async (pattern) => {
        if (pattern === "ai:currentAI:*") return ["ai:currentAI:test-group"];
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
        return [...redisStore.keys()].filter((key) => key.startsWith(prefix));
      },
      get: async (key) => redisStore.get(key) ?? null,
      set: async (key, value) => {
        redisStore.set(key, value);
        calls.push(["redis.set", key, value]);
      },
      del: async (key) => {
        redisStore.delete(key);
      },
    },
    getAIList: async () => ["Test AI"],
    getAIListConfig: async (name) => (name === "Test AI" ? { ...ai } : null),
    getAIDisplayName: async (name) => name,
    getAIConfig: async (guid) => configs.get(guid) || { ...ai },
    setAIConfig: async (guid, config) => {
      configs.set(guid, config);
      calls.push(["setAIConfig", guid, config]);
    },
    getCurrentAI: async () => "Test AI",
    getCAPIContextLimit: async () => 4096,
    getDeepThoughtEffort: async () => values.get("DeepThoughtEffort") ?? "medium",
    setDeepThoughtEffort: async (...args) => {
      calls.push(["setDeepThoughtEffort", ...args]);
      values.set("DeepThoughtEffort", args.at(-1));
    },
    getPromptList: async () => ["测试提示词"],
    getPrompt: async () => "测试提示词",
    switchAI: async (...args) => {
      calls.push(["switchAI", ...args]);
      return { ...ai };
    },
    switchPrompt: async (...args) => {
      calls.push(["switchPrompt", ...args]);
      return true;
    },
    deleteAI: async (...args) => {
      calls.push(["deleteAI", ...args]);
      return true;
    },
    closeChat: async (...args) => {
      calls.push(["closeChat", ...args]);
    },
  },
  {
    get(target, property) {
      if (property in target) return target[property];
      if (String(property).startsWith("get"))
        return async () => values.get(property.slice(3)) ?? "1";
      if (String(property).startsWith("set"))
        return async (...args) => {
          calls.push([property, ...args]);
          values.set(property.slice(3), args.at(-1) ? "1" : "0");
        };
      throw new Error(`Unexpected config operation: ${String(property)}`);
    },
  },
);
mock.module(new URL("../../lib/config.js", import.meta.url).href, {
  defaultExport: client,
});
export const imageSource =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const message = {
  from: "bot",
  name: "aichatbot",
  time: "12:00",
  text: "测试回复",
  images: [
    `/panel/image?guid=test-group&source=${encodeURIComponent(imageSource)}`,
  ],
};
mock.module(new URL("../../lib/panel/chat.js", import.meta.url).href, {
  namedExports: {
    PANEL_BOT_ID: "aichatbot",
    resolvePanelChatIdentity: async (guid, userId, nickname) => ({
      guid: guid || "test-group",
      userId: userId || "webuser",
      nickname: nickname || userId || "webuser",
    }),
    getPanelChatMessagesForDisplay: async () => [message],
    clearPanelChatMessages: async (...args) => {
      calls.push(["clearPanelChatMessages", ...args]);
    },
    sendPanelChatMessage: async (...args) => {
      calls.push(["sendPanelChatMessage", ...args]);
    },
    sendPanelChatMessageStream: async (guid, userId, nickname, text, emit) => {
      calls.push(["sendPanelChatMessageStream", guid, userId, nickname, text]);
      await emit({ type: "delta", text: "测试" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await emit({ type: "replace", message });
      await emit({ type: "done" });
    },
  },
});

export async function startPanelTestRuntime({ parseBody = false } = {}) {
  const { createPanelRouter } = await import("../../lib/panel/server.js");
  const { default: frameworkRouter } =
    await import("../../node_modules/alemonjs/lib/application/runtime/http/routers/router.js");
  const { registerRuntimeApp, setRuntimeAppKoaRouters } =
    await import("../../node_modules/alemonjs/lib/application/runtime/store.js");
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  process.env.input = "lib/index.js";
  for (const name of ["main", "alemonjs-aichat"]) {
    registerRuntimeApp({
      name,
      kind: name === "main" ? "main" : "plugin",
      enabled: true,
      status: "ready",
      rootDir: join(packageRoot, "lib"),
      mainPath: join(packageRoot, "lib", "index.js"),
      capabilities: { web: true, httpApi: true },
    });
    setRuntimeAppKoaRouters(name, createPanelRouter({ hosted: true }));
  }
  const app = new Koa();
  // 模拟宿主代理剥掉外层路径，框架看不到浏览器实际使用的 /robot-proxy。
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith("/robot-proxy/")) {
      ctx.url = ctx.url.slice("/robot-proxy".length);
      ctx.originalUrl = ctx.url;
    }
    await next();
  });
  if (parseBody)
    app.use(async (ctx, next) => {
      if (ctx.method === "POST") {
        const chunks = [];
        for await (const chunk of ctx.req) chunks.push(chunk);
        ctx.request.body = Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString()),
        );
      }
      await next();
    });
  const frameworkRoutes = frameworkRouter.routes();
  app.use((ctx, next) =>
    ctx.path === "/app" ||
    ctx.path.startsWith("/app/") ||
    ctx.path.startsWith("/apps/")
      ? frameworkRoutes(ctx, next)
      : next(),
  );
  const standalone = createPanelRouter();
  app.use(standalone.routes());
  app.use(standalone.allowedMethods());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
