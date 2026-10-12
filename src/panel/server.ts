import React from "react";
import { renderToString } from "react-dom/server";
import Koa from "koa";
import KoaStatic from "koa-static";
import Router from "koa-router";
import send from "koa-send";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, extname, join, normalize } from "path";
import { processHtmlPaths } from "jsxp";
import redisClient from "@src/config";
import panelConfig from "@src/panel/config";
import {
  clearPanelChatMessages,
  resolvePanelChatIdentity,
  sendPanelChatMessage,
  sendPanelChatMessageStream,
} from "@src/panel/chat";
import {
  addPanelGroupConfig,
  updatePanelGroupConfig,
} from "@src/panel/groupConfig";
import { PanelBasePath, panelUrl } from "@src/panel/urls";
import { createPanelServerController } from "@src/panel/lifecycle";
import { getPanelAccess } from "@src/panel/access";

const textTypes = new Set(["css", "js", "mjs", "html", "svg", "json"]);
const mimeTypes: Record<string, string> = {
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  html: "text/html",
  svg: "image/svg+xml",
  json: "application/json",
};

const loadConfig = async () => panelConfig;
const getPanelBasePath = (ctx: Koa.Context): string =>
  ctx.state.panelBasePath || "";

const redirectToPanel = (ctx: Koa.Context, url: string) =>
  ctx.redirect(panelUrl(getPanelBasePath(ctx), url));

const rewriteServerUrls = (content: string, dir: string, prefix: string) =>
  content.replace(/url\(["']?([^"')]+)["']?\)/g, (full, rawPath) => {
    if (/^(https?:|data:|\/)/.test(rawPath)) return full;
    const filePath = normalize(join(dir, rawPath));
    return `url(${prefix}/_jsxp_file?path=${encodeURIComponent(filePath)})`;
  });

const renderRoute = async (options: any, ctx: Koa.Context) => {
  let html = "";

  if ("html" in options && options.html) {
    html = options.html;
  } else if ("element" in options && options.element) {
    const props = {
      ...(options.propsCall ? await options.propsCall(ctx) : {}),
      standaloneServer: ctx.state.panelHosted
        ? getPanelServerStatus()
        : undefined,
    };
    html = `<!DOCTYPE html>${renderToString(
      React.createElement(
        PanelBasePath.Provider,
        { value: getPanelBasePath(ctx) },
        React.createElement(options.element, props),
      ),
    )}`;
  } else {
    html = `<!DOCTYPE html>${renderToString(options.component)}`;
  }

  const processed = await processHtmlPaths(html, "server");
  // jsxp 生成的文件地址也要经过插件命名空间；只处理其生成的资源 URL。
  return processed.replace(
    /((?:src|href)=["']|url\(["']?)\/_jsxp_file\?/g,
    (_, lead: string) => `${lead}${getPanelBasePath(ctx)}/_jsxp_file?`,
  );
};

const getQueryText = (value: unknown) => {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
};

const isHttpImageSource = (value: string) => /^https?:\/\//i.test(value);

const resolvePanelImageFilePath = (
  source: string,
  cwd: string,
  staticRoots: string[],
  allowedFileRoots: string[],
) => {
  const normalizedSource = source.trim().replace(/\\/g, "/");
  if (!normalizedSource || isHttpImageSource(normalizedSource)) {
    return null;
  }

  const relativeSource = normalizedSource
    .replace(/^\.?\//, "")
    .replace(/^public\//, "");
  const candidates = [
    join(cwd, relativeSource),
    ...staticRoots.map((root) => join(root, relativeSource)),
  ];

  for (const candidate of candidates) {
    const normalizedCandidate = normalize(candidate);
    const normalizedLower = normalizedCandidate.toLowerCase();
    if (
      allowedFileRoots.some((root) => normalizedLower.startsWith(root)) &&
      existsSync(normalizedCandidate)
    ) {
      return normalizedCandidate;
    }
  }

  return null;
};

const readFormBody = async (ctx: Koa.Context) => {
  const state = ctx.state as { panelFormBody?: URLSearchParams };
  if (state.panelFormBody) return state.panelFormBody;

  // 宿主可能已解析表单；此时不能再次等待已经结束的请求流。
  const parsed = (ctx.request as Koa.Request & { body?: unknown }).body;
  if (parsed && typeof parsed === "object" && !Buffer.isBuffer(parsed)) {
    state.panelFormBody = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed)) {
      state.panelFormBody.set(key, String(value ?? ""));
    }
    return state.panelFormBody;
  }
  if (ctx.req.readableEnded) return new URLSearchParams();

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    ctx.req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    ctx.req.on("end", resolve);
    ctx.req.on("error", reject);
  });

  state.panelFormBody = new URLSearchParams(Buffer.concat(chunks).toString());
  return state.panelFormBody;
};

const getActionText = async (ctx: Koa.Context, key: string) => {
  if (ctx.method.toUpperCase() === "POST") {
    const body = await readFormBody(ctx);
    return String(body.get(key) || "").trim();
  }

  return getQueryText(ctx.query[key]);
};

const getPanelGuid = async (queryGuid?: string) => {
  if (queryGuid) return queryGuid;

  const keys = await redisClient.redis.keys("ai:currentAI:*");
  const firstKey = keys[0];
  if (!firstKey) return "global";

  return firstKey.replace("ai:currentAI:", "") || "global";
};

const getActionUiState = async (ctx: Koa.Context) => ({
  groupListOpen: await getActionText(ctx, "panelGroupListOpen"),
  openGroups: await getActionText(ctx, "panelOpenGroups"),
  aiListOpen: await getActionText(ctx, "panelAiListOpen"),
  openRows: await getActionText(ctx, "panelOpenRows"),
  scrollY: await getActionText(ctx, "panelScrollY"),
});

const redirectPanel = async (
  ctx: Koa.Context,
  status: "success" | "error",
  message: string,
) => {
  const state = await getActionUiState(ctx);
  const params = new URLSearchParams({
    panelStatus: status,
    panelMessage: message,
  });

  if (state.groupListOpen)
    params.set("panelGroupListOpen", state.groupListOpen);
  if (state.openGroups) params.set("panelOpenGroups", state.openGroups);
  if (state.aiListOpen) params.set("panelAiListOpen", state.aiListOpen);
  if (state.openRows) params.set("panelOpenRows", state.openRows);
  if (state.scrollY) params.set("panelScrollY", state.scrollY);

  redirectToPanel(ctx, `/panel/config?${params.toString()}`);
};

const redirectPanelChat = async (
  ctx: Koa.Context,
  status: "success" | "error",
  message: string,
  guid: string,
  userId: string,
) => {
  const chatConfigOpen = await getActionText(ctx, "chatConfigOpen");
  const nickname = await getActionText(ctx, "nickname");
  const params = new URLSearchParams({
    panelStatus: status,
    panelMessage: message,
    guid,
    userId,
  });

  if (chatConfigOpen) params.set("chatConfigOpen", chatConfigOpen);
  if (nickname) params.set("nickname", nickname);

  redirectToPanel(ctx, `/panel/chat?${params.toString()}`);
};

const handleUseAI = async (ctx: Koa.Context) => {
  const name = await getActionText(ctx, "name");

  if (!name) {
    await redirectPanel(ctx, "error", "缺少AI名称");
    return;
  }

  const guid = await getPanelGuid(await getActionText(ctx, "guid"));
  const aiConfig = await redisClient.switchAI(guid, name);
  if (!aiConfig) {
    await redirectPanel(ctx, "error", `切换失败，未找到AI：${name}`);
    return;
  }

  await redirectPanel(ctx, "success", `已将 ${guid} 切换到 ${name}`);
};

const handleDeleteAI = async (ctx: Koa.Context) => {
  const name = await getActionText(ctx, "name");

  if (!name) {
    await redirectPanel(ctx, "error", "缺少AI名称");
    return;
  }

  const deleted = await redisClient.deleteAI(name);
  if (!deleted) {
    await redirectPanel(ctx, "error", `删除失败，未找到AI：${name}`);
    return;
  }

  await redirectPanel(ctx, "success", `已删除AI：${name}`);
};

const getActionFlag = async (ctx: Koa.Context, key: string) => {
  if (ctx.method.toUpperCase() === "POST") {
    const body = await readFormBody(ctx);
    return body.has(key) && body.get(key) !== "0";
  }

  const value = getQueryText(ctx.query[key]);
  return value === "1" || value === "true" || value === "on";
};

const handleUpdateGroupConfig = async (ctx: Koa.Context) => {
  const guid = await getActionText(ctx, "guid");
  const userId = await getActionText(ctx, "userId");
  const source = await getActionText(ctx, "source");
  const currentAI = await getActionText(ctx, "currentAI");
  const capiContextLimit = Number(await getActionText(ctx, "capiContextLimit"));
  const redirectResult = (
    status: "success" | "error",
    message: string,
    targetGuid = guid,
  ) => {
    if (source === "chat") {
      return redirectPanelChat(
        ctx,
        status,
        message,
        targetGuid,
        userId || "webuser",
      );
    }

    return redirectPanel(ctx, status, message);
  };

  if (!guid) {
    await redirectResult("error", "缺少群号 guid", "global");
    return;
  }

  try {
    await updatePanelGroupConfig({
      guid,
      currentAI,
      capiContextLimit,
      switches: {
        chatSwitch: await getActionFlag(ctx, "chatSwitch"),
        imageBedSwitch: await getActionFlag(ctx, "imageBedSwitch"),
        toolSwitch: await getActionFlag(ctx, "toolSwitch"),
        toolCallContentSwitch: await getActionFlag(
          ctx,
          "toolCallContentSwitch",
        ),
        complexOutput: await getActionFlag(ctx, "complexOutput"),
        affectionSwitch: await getActionFlag(ctx, "affectionSwitch"),
        deepThoughtSwitch: await getActionFlag(ctx, "deepThoughtSwitch"),
        r18Switch: await getActionFlag(ctx, "r18Switch"),
        atTriggerSwitch: await getActionFlag(ctx, "atTriggerSwitch"),
        toolPromptSwitch: await getActionFlag(ctx, "toolPromptSwitch"),
        toolPromptRevokeSwitch: await getActionFlag(
          ctx,
          "toolPromptRevokeSwitch",
        ),
        toolPromptArgsSwitch: await getActionFlag(ctx, "toolPromptArgsSwitch"),
        proactiveSwitch: await getActionFlag(ctx, "proactiveSwitch"),
      },
    });
    await redirectResult("success", `已保存群 ${guid} 的配置`);
  } catch (error) {
    await redirectResult(
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const parseJsonArray = (value: string) => {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
};

const handleAddGroupConfig = async (ctx: Koa.Context) => {
  const guid = await getActionText(ctx, "guid");
  const currentAI = await getActionText(ctx, "currentAI");
  const chatSwitch = await getActionFlag(ctx, "chatSwitch");

  if (!guid) {
    await redirectPanel(ctx, "error", "缺少群号 guid");
    return;
  }

  try {
    await addPanelGroupConfig({
      guid,
      currentAI,
      chatSwitch,
    });

    const state = await getActionUiState(ctx);
    const params = new URLSearchParams({
      panelStatus: "success",
      panelMessage: `已添加群 ${guid}`,
      panelGroupListOpen: "1",
      panelOpenGroups: JSON.stringify([
        ...new Set([...parseJsonArray(state.openGroups), guid]),
      ]),
    });

    if (state.aiListOpen) params.set("panelAiListOpen", state.aiListOpen);
    if (state.openRows) params.set("panelOpenRows", state.openRows);
    if (state.scrollY) params.set("panelScrollY", state.scrollY);

    redirectToPanel(ctx, `/panel/config?${params.toString()}`);
  } catch (error) {
    await redirectPanel(
      ctx,
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const handlePanelChat = async (ctx: Koa.Context) => {
  const identity = await resolvePanelChatIdentity(
    await getActionText(ctx, "guid"),
    await getActionText(ctx, "userId"),
    await getActionText(ctx, "nickname"),
  );
  const text = await getActionText(ctx, "message");

  if (!text) {
    await redirectPanelChat(
      ctx,
      "error",
      "消息不能为空",
      identity.guid,
      identity.userId,
    );
    return;
  }

  await sendPanelChatMessage(
    identity.guid,
    identity.userId,
    identity.nickname,
    text,
  );
  await redirectPanelChat(
    ctx,
    "success",
    "消息已发送",
    identity.guid,
    identity.userId,
  );
};

const handlePanelChatStream = async (ctx: Koa.Context) => {
  const identity = await resolvePanelChatIdentity(
    await getActionText(ctx, "guid"),
    await getActionText(ctx, "userId"),
    await getActionText(ctx, "nickname"),
  );
  const text = await getActionText(ctx, "message");

  ctx.respond = false;
  ctx.res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const writeEvent = async (event: any) => {
    ctx.res.write(`${JSON.stringify(event)}\n`);
  };

  try {
    await sendPanelChatMessageStream(
      identity.guid,
      identity.userId,
      identity.nickname,
      text,
      writeEvent,
    );
  } catch (error) {
    await writeEvent({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    await writeEvent({ type: "done" });
  } finally {
    ctx.res.end();
  }
};

const handleClearPanelChat = async (ctx: Koa.Context) => {
  const identity = await resolvePanelChatIdentity(
    await getActionText(ctx, "guid"),
    await getActionText(ctx, "userId"),
    await getActionText(ctx, "nickname"),
  );
  await clearPanelChatMessages(identity.guid, identity.userId);
  await redirectPanelChat(
    ctx,
    "success",
    "聊天记录已清空",
    identity.guid,
    identity.userId,
  );
};

const handleChatUseAI = async (ctx: Koa.Context) => {
  const identity = await resolvePanelChatIdentity(
    await getActionText(ctx, "guid"),
    await getActionText(ctx, "userId"),
    await getActionText(ctx, "nickname"),
  );
  const name = await getActionText(ctx, "name");

  if (!name) {
    await redirectPanelChat(
      ctx,
      "error",
      "缺少AI配置名称",
      identity.guid,
      identity.userId,
    );
    return;
  }

  const aiConfig = await redisClient.switchAI(identity.guid, name);
  if (!aiConfig) {
    await redirectPanelChat(
      ctx,
      "error",
      `切换失败，未找到AI：${name}`,
      identity.guid,
      identity.userId,
    );
    return;
  }

  await redirectPanelChat(
    ctx,
    "success",
    `已将 ${identity.guid} 切换到 ${name}`,
    identity.guid,
    identity.userId,
  );
};

const handleChatSwitchModel = async (ctx: Koa.Context) => {
  const identity = await resolvePanelChatIdentity(
    await getActionText(ctx, "guid"),
    await getActionText(ctx, "userId"),
    await getActionText(ctx, "nickname"),
  );
  const model = await getActionText(ctx, "model");

  if (!model) {
    await redirectPanelChat(
      ctx,
      "error",
      "缺少模型名称",
      identity.guid,
      identity.userId,
    );
    return;
  }

  const aiConfig = await redisClient.getAIConfig(identity.guid);
  if (!aiConfig.host.trim() || !aiConfig.key.trim()) {
    await redirectPanelChat(
      ctx,
      "error",
      `群号 ${identity.guid} 还没有可用 AI 配置`,
      identity.guid,
      identity.userId,
    );
    return;
  }

  await redisClient.setAIConfig(identity.guid, {
    ...aiConfig,
    model,
  });
  await redirectPanelChat(
    ctx,
    "success",
    `已切换模型：${model}`,
    identity.guid,
    identity.userId,
  );
};

const handleChatSwitchContextLimit = async (ctx: Koa.Context) => {
  const identity = await resolvePanelChatIdentity(
    await getActionText(ctx, "guid"),
    await getActionText(ctx, "userId"),
    await getActionText(ctx, "nickname"),
  );
  const capiContextLimit = Number(await getActionText(ctx, "capiContextLimit"));

  if (!Number.isFinite(capiContextLimit) || capiContextLimit <= 0) {
    await redirectPanelChat(
      ctx,
      "error",
      "请输入有效的上下文长度",
      identity.guid,
      identity.userId,
    );
    return;
  }

  await redisClient.setCAPIContextLimit(identity.guid, capiContextLimit);
  await redirectPanelChat(
    ctx,
    "success",
    `已更新上下文长度：${capiContextLimit}`,
    identity.guid,
    identity.userId,
  );
};

const handleChatSwitchPrompt = async (ctx: Koa.Context) => {
  const identity = await resolvePanelChatIdentity(
    await getActionText(ctx, "guid"),
    await getActionText(ctx, "userId"),
    await getActionText(ctx, "nickname"),
  );
  const prompt = await getActionText(ctx, "prompt");
  const result = await redisClient.switchPrompt(identity.guid, prompt);

  if (prompt && result === null) {
    await redirectPanelChat(
      ctx,
      "error",
      `切换失败，未找到提示词：${prompt}`,
      identity.guid,
      identity.userId,
    );
    return;
  }

  await redirectPanelChat(
    ctx,
    "success",
    prompt ? `已切换提示词：${prompt}` : "已恢复默认提示词",
    identity.guid,
    identity.userId,
  );
};

export const createPanelRouter = ({ hosted = false } = {}) => {
  const config = panelConfig;
  const prefix = hosted ? "/api" : (config?.prefix ?? "");
  const router = new Router({ prefix });
  const cwd = process.cwd();
  const configStatics = config?.statics ?? "public";
  const staticRoots = Array.isArray(configStatics)
    ? configStatics
    : [configStatics];
  const allowedFileRoots = [cwd, ...staticRoots].map((item) =>
    normalize(item).toLowerCase(),
  );

  router.use(async (ctx, next) => {
    ctx.state.panelHosted = hosted;
    if (hosted && ctx.path === prefix) {
      ctx.redirect(`./api/${ctx.search}`);
      return;
    }
    // 从当前页面相对回到插件 API 根目录。宿主代理可能剥掉外部前缀，
    // 因而不能根据 originalUrl 拼绝对地址，也不能硬编码 /apps/<包名>。
    const depth = Math.max(
      0,
      ctx.path.slice(prefix.length).split("/").length - 2,
    );
    ctx.state.panelBasePath = hosted
      ? Array(depth).fill("..").join("/") || "."
      : ((ctx.state as { panelAccessBasePath?: string }).panelAccessBasePath ??
        prefix);
    await next();
  });

  if (hosted) {
    router.post("/panel/action/server/start", async (ctx) => {
      try {
        const state = await createPanelServer(await getActionText(ctx, "port"));
        await redirectPanel(
          ctx,
          "success",
          `独立网页已开启，端口 ${state.port}`,
        );
      } catch (error) {
        await redirectPanel(
          ctx,
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    router.post("/panel/action/server/stop", async (ctx) => {
      await stopPanelServer();
      await redirectPanel(
        ctx,
        "success",
        "独立网页已关闭，AlemonX 页面可继续使用",
      );
    });
  }

  router.get("/panel/action/use-ai", handleUseAI);
  router.get("/panel/action/delete-ai", handleDeleteAI);
  router.get("/panel/action/clear-chat", handleClearPanelChat);
  router.post("/panel/action/add-group-config", handleAddGroupConfig);
  router.post("/panel/action/update-group-config", handleUpdateGroupConfig);
  router.post("/panel/action/use-ai", handleUseAI);
  router.post("/panel/action/delete-ai", handleDeleteAI);
  router.post("/panel/action/chat/use-ai", handleChatUseAI);
  router.post("/panel/action/chat/switch-model", handleChatSwitchModel);
  router.post(
    "/panel/action/chat/switch-context-limit",
    handleChatSwitchContextLimit,
  );
  router.post("/panel/action/chat/switch-prompt", handleChatSwitchPrompt);
  router.post("/panel/action/chat/stream", handlePanelChatStream);
  router.post("/panel/action/chat", handlePanelChat);
  router.post("/panel/action/clear-chat", handleClearPanelChat);

  router.get("/_jsxp_file", async (ctx) => {
    const raw = getQueryText(ctx.query.path);
    const filePath = normalize(decodeURIComponent(raw));

    if (!filePath) {
      ctx.status = 400;
      ctx.body = { error: 'Missing "path" query parameter' };
      return;
    }

    const normalizedFilePath = normalize(filePath).toLowerCase();
    if (!allowedFileRoots.some((root) => normalizedFilePath.startsWith(root))) {
      ctx.status = 403;
      ctx.body = { error: "Access denied" };
      return;
    }

    if (!existsSync(filePath)) {
      ctx.status = 404;
      ctx.body = { error: "File not found" };
      return;
    }

    const ext = extname(filePath).slice(1).toLowerCase();
    if (textTypes.has(ext)) {
      const content = await readFile(filePath, "utf-8");
      ctx.type = mimeTypes[ext] || "text/plain";
      ctx.body = rewriteServerUrls(
        content,
        dirname(filePath),
        getPanelBasePath(ctx),
      );
      return;
    }

    await send(ctx, filePath, { root: "/" });
  });

  router.get("/panel/image", async (ctx) => {
    const guid = getQueryText(ctx.query.guid);
    const source = getQueryText(ctx.query.source);

    if (!guid || !source) {
      ctx.status = 400;
      ctx.body = { error: "Missing guid or source query parameter" };
      return;
    }

    if ((await redisClient.getImageBedSwitch(guid)) !== "1") {
      ctx.status = 403;
      ctx.body = { error: "Image access disabled" };
      return;
    }

    if (source.startsWith("data:image/")) {
      const match = source.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        ctx.status = 400;
        ctx.body = { error: "Invalid data image" };
        return;
      }

      ctx.type = match[1];
      ctx.body = Buffer.from(match[2], "base64");
      return;
    }

    if (isHttpImageSource(source)) {
      const response = await fetch(source);
      if (!response.ok) {
        ctx.status = response.status;
        ctx.body = { error: `Fetch image failed: ${response.statusText}` };
        return;
      }

      ctx.type =
        response.headers.get("content-type") || "application/octet-stream";
      ctx.body = Buffer.from(await response.arrayBuffer());
      return;
    }

    const filePath = resolvePanelImageFilePath(
      source,
      cwd,
      staticRoots,
      allowedFileRoots,
    );
    if (!filePath) {
      ctx.status = 404;
      ctx.body = { error: "Image not found" };
      return;
    }

    await send(ctx, filePath, { root: "/" });
  });

  const routes = config?.routes ?? {};
  for (const url in routes) {
    router.get(url, async (ctx) => {
      const latestConfig = await loadConfig();
      const latestRoute = latestConfig?.routes?.[url];
      if (!latestRoute) {
        ctx.status = 404;
        return;
      }

      ctx.type = "html";
      ctx.body = await renderRoute(latestRoute, ctx);
    });
  }

  const staticMiddleware = staticRoots.map((item) => KoaStatic(item));
  router.get("/{*path}", async (ctx) => {
    const originalPath = ctx.path;
    ctx.path = ctx.path.slice(prefix.length) || "/";
    try {
      for (const serve of staticMiddleware) {
        await serve(ctx, async () => {});
        if (ctx.body != null) break;
      }
    } finally {
      ctx.path = originalPath;
    }
  });

  return router;
};

const listenPanelServer = (port: number) => {
  const config = panelConfig;
  const app = new Koa();
  const router = createPanelRouter();

  // 独立网页：/{token}/... 路径闸；enabled=0 → 403，token 错 → 401。
  app.use(async (ctx, next) => {
    const access = await getPanelAccess();
    if (access.enabled !== "1" || !access.token) {
      ctx.status = 403;
      ctx.body = "Panel access disabled";
      return;
    }

    const tokenPrefix = `/${access.token}`;
    if (
      ctx.path !== tokenPrefix &&
      !ctx.path.startsWith(`${tokenPrefix}/`)
    ) {
      ctx.status = 401;
      ctx.body = "Unauthorized";
      return;
    }

    const originalPath = ctx.path;
    ctx.path = ctx.path.slice(tokenPrefix.length) || "/";
    (ctx.state as { panelAccessBasePath?: string }).panelAccessBasePath =
      tokenPrefix;
    try {
      await next();
    } finally {
      ctx.path = originalPath;
    }
  });

  // 保留独立网页原有的静态目录优先级和启动方式（鉴权之后）。
  const statics = config?.statics ?? "public";
  for (const root of Array.isArray(statics) ? statics : [statics]) {
    app.use(KoaStatic(root));
  }
  app.use(router.routes());
  app.use(router.allowedMethods());

  const server = app.listen(port);
  server.once("listening", () => {
    console.log(
      `独立网页已开启：http://${config?.host ?? "127.0.0.1"}:${port}/<token>/panel/config`,
    );
  });
  return server;
};

const panelController = createPanelServerController(
  listenPanelServer,
  panelConfig.port ?? 8080,
);
export const getPanelServerStatus = panelController.status;
export const createPanelServer = panelController.start;
export const stopPanelServer = panelController.stop;
