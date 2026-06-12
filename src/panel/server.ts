import React from "react";
import { renderToString } from "react-dom/server";
import Koa from "koa";
import KoaStatic from "koa-static";
import Router from "koa-router";
import send from "koa-send";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, extname, join, normalize } from "path";
import type { Server } from "http";
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
    const props = options.propsCall ? await options.propsCall(ctx) : {};
    html = `<!DOCTYPE html>${renderToString(
      React.createElement(options.element, props),
    )}`;
  } else {
    html = `<!DOCTYPE html>${renderToString(options.component)}`;
  }

  return processHtmlPaths(html, "server");
};

const getQueryText = (value: unknown) => {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
};

const readFormBody = async (ctx: Koa.Context) => {
  const state = ctx.state as { panelFormBody?: URLSearchParams };
  if (state.panelFormBody) return state.panelFormBody;

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

  if (state.groupListOpen) params.set("panelGroupListOpen", state.groupListOpen);
  if (state.openGroups) params.set("panelOpenGroups", state.openGroups);
  if (state.aiListOpen) params.set("panelAiListOpen", state.aiListOpen);
  if (state.openRows) params.set("panelOpenRows", state.openRows);
  if (state.scrollY) params.set("panelScrollY", state.scrollY);

  ctx.redirect(`/panel/config?${params.toString()}`);
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

  ctx.redirect(`/panel/chat?${params.toString()}`);
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
        toolSwitch: await getActionFlag(ctx, "toolSwitch"),
        toolCallContentSwitch: await getActionFlag(ctx, "toolCallContentSwitch"),
        complexOutput: await getActionFlag(ctx, "complexOutput"),
        affectionSwitch: await getActionFlag(ctx, "affectionSwitch"),
        ttsResponseSwitch: await getActionFlag(ctx, "ttsResponseSwitch"),
        deepThoughtSwitch: await getActionFlag(ctx, "deepThoughtSwitch"),
        r18Switch: await getActionFlag(ctx, "r18Switch"),
        atTriggerSwitch: await getActionFlag(ctx, "atTriggerSwitch"),
        toolPromptSwitch: await getActionFlag(ctx, "toolPromptSwitch"),
        toolPromptRevokeSwitch: await getActionFlag(ctx, "toolPromptRevokeSwitch"),
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
      panelOpenGroups: JSON.stringify(
        [...new Set([...parseJsonArray(state.openGroups), guid])],
      ),
    });

    if (state.aiListOpen) params.set("panelAiListOpen", state.aiListOpen);
    if (state.openRows) params.set("panelOpenRows", state.openRows);
    if (state.scrollY) params.set("panelScrollY", state.scrollY);

    ctx.redirect(`/panel/config?${params.toString()}`);
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
  await redirectPanelChat(ctx, "success", "消息已发送", identity.guid, identity.userId);
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
    await redirectPanelChat(ctx, "error", "缺少AI配置名称", identity.guid, identity.userId);
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
    await redirectPanelChat(ctx, "error", "缺少模型名称", identity.guid, identity.userId);
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

let panelServer: Server | null = null;
let panelServerPromise: Promise<void> | null = null;

const startPanelServer = async () => {
  const config = await loadConfig();
  const app = new Koa();
  const prefix = config?.prefix ?? "";
  const router = new Router({ prefix });
  const cwd = process.cwd();
  const port = config?.port ?? 8080;
  const configStatics = config?.statics ?? "public";
  const staticRoots = Array.isArray(configStatics) ? configStatics : [configStatics];
  const allowedFileRoots = [cwd, ...staticRoots].map((item) =>
    normalize(item).toLowerCase(),
  );

  console.log("_______jsxp-panel_______");

  router.get("/panel/action/use-ai", handleUseAI);
  router.get("/panel/action/delete-ai", handleDeleteAI);
  router.get("/panel/action/clear-chat", handleClearPanelChat);
  router.post("/panel/action/add-group-config", handleAddGroupConfig);
  router.post("/panel/action/update-group-config", handleUpdateGroupConfig);
  router.post("/panel/action/use-ai", handleUseAI);
  router.post("/panel/action/delete-ai", handleDeleteAI);
  router.post("/panel/action/chat/use-ai", handleChatUseAI);
  router.post("/panel/action/chat/switch-model", handleChatSwitchModel);
  router.post("/panel/action/chat/switch-context-limit", handleChatSwitchContextLimit);
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
      ctx.body = rewriteServerUrls(content, dirname(filePath), prefix);
      return;
    }

    await send(ctx, filePath, { root: "/" });
  });

  const routes = config?.routes ?? {};
  for (const url in routes) {
    console.log(`http://${config?.host ?? "127.0.0.1"}:${port}${prefix + url}`);
    router.get(url, async (ctx) => {
      const latestConfig = await loadConfig();
      const latestRoute = latestConfig?.routes?.[url];
      if (!latestRoute) {
        ctx.status = 404;
        return;
      }

      ctx.body = await renderRoute(latestRoute, ctx);
    });
  }

  for (const item of staticRoots) {
    app.use(KoaStatic(item));
  }

  app.use(router.routes());

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port);
    panelServer = server;

    server.once("listening", () => {
      console.log(`Server is running on port ${port}`);
      console.log("自行调整默认浏览器尺寸 800 X 1280 100%");
      console.log("_______jsxp-panel_______");
      resolve();
    });

    server.once("error", (error: NodeJS.ErrnoException) => {
      panelServer = null;
      if (error.code === "EADDRINUSE") {
        console.warn(`网页控制台端口 ${port} 已被占用，跳过本次启动。`);
        resolve();
        return;
      }
      reject(error);
    });
  });
};

export const createPanelServer = async () => {
  if (panelServer || panelServerPromise) {
    return panelServerPromise ?? Promise.resolve();
  }

  panelServerPromise = startPanelServer().catch((error) => {
    panelServerPromise = null;
    throw error;
  });

  return panelServerPromise;
};

