import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();

// 上游代理（你的系统代理）
const UPSTREAM_PROXY = "http://127.0.0.1:7890";

// 目标服务器
const TARGET_XAI = "https://api.x.ai";
const TARGET_OPENAI = "https://api.openai.com";

// 创建代理 Agent（复用同一个）
const agent = new HttpsProxyAgent(UPSTREAM_PROXY);

// 基础日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ===== /x -> api.x.ai =====
app.use(
  "/x",
  createProxyMiddleware({
    target: TARGET_XAI,
    changeOrigin: true,
    secure: true,
    agent,

    // 去掉前缀 /x
    pathRewrite: (path, req) => path.replace(/^\/x/, ""),

    timeout: 60_000,
    proxyTimeout: 60_000,

    onProxyReq: (proxyReq, req, res) => {
      proxyReq.setHeader("host", "api.x.ai");
    },

    onError: (err, req, res) => {
      console.error("X.AI proxy error:", err);
      res.status(502).json({ error: "Bad Gateway", message: err.message });
    },

    logLevel: "warn",
  }),
);

// ===== /ximgen -> imgen.x.ai =====
app.use(
  "/ximgen",
  createProxyMiddleware({
    target: "https://imgen.x.ai",
    changeOrigin: true,
    secure: true,
    agent,
    pathRewrite: (path, req) => path.replace(/^\/ximgen/, ""),

    timeout: 60_000,
    proxyTimeout: 60_000,

    onProxyReq: (proxyReq, req, res) => {
      proxyReq.setHeader("host", "imgen.x.ai");
    },

    onError: (err, req, res) => {
      console.error("X.AI Imgen proxy error:", err);
      res.status(502).json({ error: "Bad Gateway", message: err.message });
    },

    logLevel: "warn",
  }),
);

// ===== /openai -> api.openai.com =====
app.use(
  "/openai",
  createProxyMiddleware({
    target: TARGET_OPENAI,
    changeOrigin: true,
    secure: true,
    agent,

    // 去掉前缀 /openai
    pathRewrite: (path, req) => path.replace(/^\/openai/, ""),

    timeout: 60_000,
    proxyTimeout: 60_000,

    onProxyReq: (proxyReq, req, res) => {
      proxyReq.setHeader("host", "api.openai.com");
    },

    onError: (err, req, res) => {
      console.error("OpenAI proxy error:", err);
      res.status(502).json({ error: "Bad Gateway", message: err.message });
    },

    logLevel: "warn",
  }),
);

// 兜底：未匹配路由
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message:
      "Use /x/* for api.x.ai, /ximgen/* for imgen.x.ai, or /openai/* for api.openai.com",
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Proxy server listening on http://127.0.0.1:${PORT}`);
  console.log(`→ /x -> ${TARGET_XAI} via ${UPSTREAM_PROXY}`);
  console.log(`→ /ximgen -> https://imgen.x.ai via ${UPSTREAM_PROXY}`);
  console.log(`→ /openai -> ${TARGET_OPENAI} via ${UPSTREAM_PROXY}`);
});
