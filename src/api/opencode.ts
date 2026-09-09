import { spawn, execFile, type ChildProcess } from "child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import fs from "fs";
import path from "path";
import { getAiChatConfigValue } from "../config/app";
import type { AIConfig } from "../types";

const value = getAiChatConfigValue();

const MAX_OUTPUT_CHARS = 24000;
const MAX_TOOL_CALLS = 40;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;

type OpencodeServerConfig = {
  port: number;
  hostname: string;
  binary?: string;
};

const getServerConfig = (): OpencodeServerConfig => {
  const cfg = (value as any)?.opencodeServer || {};
  const port = Number(
    cfg.port ?? process.env.OPENCODE_TOOL_SERVER_PORT ?? 4096,
  );
  return {
    port: Number.isInteger(port) && port > 0 ? port : 4096,
    hostname: String(cfg.hostname || "127.0.0.1"),
    binary: cfg.binary ? String(cfg.binary) : undefined,
  };
};

const truncateText = (text: string, max = MAX_OUTPUT_CHARS) => {
  if (!text) return text;
  const str = String(text);
  return str.length > max ? `${str.slice(0, max)}\n[输出过长已截断]` : str;
};

const stripAnsi = (text: string) =>
  String(text || "").replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );

let serverUrl: string | null = null;
let startingPromise: Promise<{ url: string }> | null = null;

type ManagedOpencodeServer = {
  fingerprint: string;
  url: string;
  child: ChildProcess;
  closeProxy: () => void;
};

const managedServers = new Map<string, ManagedOpencodeServer>();
const managedServerStarts = new Map<string, Promise<{ url: string }>>();

const getFreePort = (hostname: string) =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const healthCheck = async (url: string) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${url}/global/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
};

const waitForHealth = async (url: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthCheck(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

const findExecutablePath = () =>
  new Promise<string>((resolve) => {
    execFile(
      "where.exe",
      ["opencode"],
      { windowsHide: true },
      (error, stdout) => {
        if (error) return resolve("");
        const lines = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) {
          if (/\.exe$/i.test(line)) return resolve(line);
        }
        for (const line of lines) {
          if (/\.(cmd|bat)$/i.test(line)) {
            try {
              const content = fs.readFileSync(line, "utf-8");
              const match = content.match(/"([^"]*opencode[^"]*\.exe)"\s/i);
              if (match) {
                const candidate = match[1].replace(
                  /%dp0%/gi,
                  path.dirname(line),
                );
                if (fs.existsSync(candidate)) return resolve(candidate);
              }
            } catch {
              // ignore unreadable shim, continue scanning
            }
          }
        }
        return resolve(lines[0] || "");
      },
    );
  });

const resolveBinary = async (): Promise<{ file: string; shell: boolean }> => {
  const configured = getServerConfig().binary;
  if (configured) return { file: configured, shell: false };
  if (process.platform === "win32") {
    const exe = await findExecutablePath();
    if (exe) return { file: exe, shell: false };
    return { file: "opencode.cmd", shell: true };
  }
  return { file: "opencode", shell: false };
};

const startInheritedAIProxy = async (config: AIConfig) => {
  const upstreamBase = new URL(config.host);
  const basePath = upstreamBase.pathname.replace(/\/$/, "");
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const incomingUrl = new URL(incoming.url || "/", "http://127.0.0.1");
      const target = new URL(upstreamBase.origin);
      target.pathname =
        basePath && !incomingUrl.pathname.startsWith(basePath)
          ? `${basePath}${incomingUrl.pathname}`
          : incomingUrl.pathname;
      target.search = incomingUrl.search;
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (
          value === undefined ||
          /^(host|authorization|content-length)$/i.test(name)
        ) {
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("authorization", `Bearer ${config.key}`);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const response = await fetch(target, {
        method: incoming.method || "POST",
        headers,
        body:
          incoming.method === "GET" || incoming.method === "HEAD"
            ? undefined
            : body,
      });
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (
          !/^(content-encoding|content-length|transfer-encoding)$/i.test(name)
        ) {
          outgoing.setHeader(name, value);
        }
      });
      if (!response.body) {
        outgoing.end();
        return;
      }
      Readable.fromWeb(response.body as any).pipe(outgoing);
    } catch {
      if (!outgoing.headersSent) outgoing.statusCode = 502;
      outgoing.end("上游 AI 请求失败");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法分配 AI 配置代理端口");
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}${basePath}`,
    close: () => server.close(),
  };
};

const buildInheritedConfig = (config: AIConfig, proxyBaseURL: string) => {
  const providerID = "alemon-aichat";
  const modelID = String(config.model || "").trim();
  return {
    providerID,
    modelID,
    content: {
      model: `${providerID}/${modelID}`,
      provider: {
        [providerID]: {
          npm:
            config.apiMode === "rapi"
              ? "@ai-sdk/openai"
              : "@ai-sdk/openai-compatible",
          name: "AlemonJS Aichat",
          options: {
            baseURL: proxyBaseURL,
            apiKey: "inherited-by-alemonjs",
          },
          models: {
            [modelID]: { name: modelID },
          },
        },
      },
    },
  };
};

/** 为 guid 启动独立服务，通过运行时配置继承当前 AI，不写配置文件。 */
export const ensureInheritedOpencodeServer = async (
  guid: string,
  config: AIConfig,
): Promise<{ url: string; model: string }> => {
  const safeGuid = String(guid || "").trim();
  if (!safeGuid) throw new Error("guid 不能为空");
  if (!config.host?.trim() || !config.key?.trim() || !config.model?.trim()) {
    throw new Error("当前 AI 配置不完整，无法启动 OpenCode");
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        host: config.host,
        key: config.key,
        model: config.model,
        apiMode: config.apiMode || "capi",
      }),
    )
    .digest("hex");
  const current = managedServers.get(safeGuid);
  if (
    current?.fingerprint === fingerprint &&
    current.child.exitCode === null &&
    (await healthCheck(current.url))
  ) {
    return {
      url: current.url,
      model: `alemon-aichat/${String(config.model).trim()}`,
    };
  }

  const pending = managedServerStarts.get(safeGuid);
  if (pending) {
    const result = await pending;
    return {
      ...result,
      model: `alemon-aichat/${String(config.model).trim()}`,
    };
  }

  const start = (async () => {
    if (current?.child.exitCode === null) {
      try {
        current.child.kill();
      } catch {
        // 旧实例退出失败不阻止新配置启动。
      }
    }
    current?.closeProxy();
    const proxy = await startInheritedAIProxy(config);
    const inherited = buildInheritedConfig(config, proxy.baseURL);
    const inlineConfig = JSON.stringify(inherited.content);
    const hostname = "127.0.0.1";
    const port = await getFreePort(hostname);
    const url = `http://${hostname}:${port}`;
    const { file, shell } = await resolveBinary();
    const child = spawn(
      file,
      ["serve", "--port", String(port), "--hostname", hostname],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: inlineConfig,
          OPENCODE_DISABLE_AUTOUPDATE: "true",
        },
        stdio: "ignore",
        windowsHide: true,
        shell,
      },
    );
    child.on("error", () => {
      // 启动错误由健康检查统一转换成可读错误。
    });
    const ok = await waitForHealth(url, 25000);
    if (!ok) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      proxy.close();
      throw new Error(`启动继承当前 AI 配置的 OpenCode 服务失败(${url})`);
    }
    managedServers.set(safeGuid, {
      fingerprint,
      url,
      child,
      closeProxy: proxy.close,
    });
    return { url };
  })();
  managedServerStarts.set(safeGuid, start);
  try {
    const result = await start;
    return {
      ...result,
      model: `alemon-aichat/${String(config.model).trim()}`,
    };
  } finally {
    managedServerStarts.delete(safeGuid);
  }
};

export const disposeInheritedOpencodeServer = (guid: string) => {
  const safeGuid = String(guid || "").trim();
  const current = managedServers.get(safeGuid);
  if (!current) return false;
  managedServers.delete(safeGuid);
  current.closeProxy();
  try {
    return current.child.kill();
  } catch {
    return false;
  }
};

/**
 * 确保本地 opencode serve 服务已启动，返回服务地址。
 * opencode serve 同时提供 HTTP API 和 Web 界面。
 */
export const ensureOpencodeServer = async (): Promise<{ url: string }> => {
  if (serverUrl && (await healthCheck(serverUrl))) return { url: serverUrl };
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    const { port, hostname } = getServerConfig();
    const url = `http://${hostname}:${port}`;
    if (await healthCheck(url)) {
      serverUrl = url;
      return { url };
    }

    const { file, shell } = await resolveBinary();
    try {
      const child = spawn(
        file,
        ["serve", "--port", String(port), "--hostname", hostname],
        {
          env: process.env,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          shell,
        },
      );
      child.on("error", () => {
        // 启动失败由下面的健康检查兜底报错
      });
      child.unref();
    } catch {
      // spawn 抛出的异常同样由健康检查兜底报错
    }

    const ok = await waitForHealth(url, 25000);
    if (!ok) {
      throw new Error(
        `启动本地 opencode 服务失败(${url})。请确认已安装 opencode(运行 opencode --version 验证)并配置了可用的模型，或检查端口 ${port} 是否被占用`,
      );
    }
    serverUrl = url;
    return { url };
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const mergeSignals = (external: AbortSignal, controller: AbortController) => {
  if (external.aborted) {
    controller.abort();
    return controller.signal;
  }
  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
};

const request = async (url: string, options: RequestOptions = {}) => {
  const { method = "GET", body, timeoutMs, signal } = options;
  const controller = new AbortController();
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const merged = signal ? mergeSignals(signal, controller) : controller.signal;
  try {
    const res = await fetch(url, {
      method,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: merged,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const message =
        (json && typeof json.message === "string" && json.message) ||
        text ||
        res.statusText;
      const err: any = new Error(message || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = json;
      throw err;
    }
    return json;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const withDirectory = (url: string, directory: string) =>
  `${url}${url.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`;

const sessionEndpoint = (url: string, id?: string) =>
  id ? `${url}/session/${encodeURIComponent(id)}` : `${url}/session`;

export const getOpencodeSession = async (
  url: string,
  directory: string,
  id: string,
) => {
  try {
    return await request(withDirectory(sessionEndpoint(url, id), directory), {
      timeoutMs: 10000,
    });
  } catch (err: any) {
    if (err?.status === 404) return null;
    throw err;
  }
};

export type OpencodePermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
};

export const createOpencodeSession = async (
  url: string,
  directory: string,
  permission: OpencodePermissionRule[],
) => {
  const body: any = { permission };
  return await request(withDirectory(sessionEndpoint(url), directory), {
    method: "POST",
    body,
    timeoutMs: 15000,
  });
};

const resolveSession = async (
  url: string,
  directory: string,
  sessionId?: string,
  autoApprove = true,
) => {
  const trimmed = String(sessionId || "").trim();
  if (trimmed) {
    const existing = await getOpencodeSession(url, directory, trimmed);
    if (existing) return existing;
  }
  return await createOpencodeSession(
    url,
    directory,
    autoApprove
      ? [{ permission: "*", pattern: "*", action: "allow" }]
      : [{ permission: "*", pattern: "*", action: "deny" }],
  );
};

export const listOpencodeSessions = async (url: string, directory: string) => {
  const sessions = await request(
    `${url}/session?directory=${encodeURIComponent(directory)}`,
    { timeoutMs: 15000 },
  );
  return Array.isArray(sessions) ? sessions : [];
};

export type OpencodeModel = {
  id: string;
  name: string;
  providerID: string;
  modelID: string;
};

export const listOpencodeModels = async (
  url: string,
  directory: string,
): Promise<OpencodeModel[]> => {
  const result = await request(withDirectory(`${url}/provider`, directory), {
    timeoutMs: 15000,
  });
  const providers = Array.isArray(result?.all)
    ? result.all
    : Array.isArray(result)
      ? result
      : [];
  const connected = new Set(
    Array.isArray(result?.connected)
      ? result.connected.map((item: unknown) => String(item))
      : [],
  );
  const availableProviders = connected.size
    ? providers.filter((provider: any) => connected.has(String(provider?.id)))
    : providers;
  const models = availableProviders.flatMap((provider: any) => {
    const providerID = String(
      provider?.id || provider?.providerID || "",
    ).trim();
    if (
      !providerID ||
      !provider?.models ||
      typeof provider.models !== "object"
    ) {
      return [];
    }
    return Object.entries(provider.models).flatMap(
      ([key, value]: [string, any]) => {
        const modelID = String(value?.id || key).trim();
        if (!modelID) return [];
        return [
          {
            id: `${providerID}/${modelID}`,
            name: String(value?.name || modelID),
            providerID,
            modelID,
          },
        ];
      },
    );
  });
  return [...new Map(models.map((model) => [model.id, model])).values()].sort(
    (a, b) => a.id.localeCompare(b.id),
  );
};

export const updateOpencodeSessionPermission = async (
  url: string,
  directory: string,
  sessionId: string,
  permission: OpencodePermissionRule[],
) =>
  await request(withDirectory(sessionEndpoint(url, sessionId), directory), {
    method: "PATCH",
    body: { permission },
    timeoutMs: 15000,
  });

const parseModel = (model: string) => {
  const trimmed = String(model || "").trim();
  if (!trimmed) return undefined;
  const index = trimmed.indexOf("/");
  if (index === -1) return undefined;
  return {
    providerID: trimmed.slice(0, index),
    modelID: trimmed.slice(index + 1),
  };
};

const sendSessionMessage = async ({
  url,
  sessionId,
  directory,
  prompt,
  model,
  agent,
  timeoutMs,
  signal,
  files,
}: {
  url: string;
  sessionId: string;
  directory: string;
  prompt: string;
  model?: string;
  agent?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  files?: Array<{
    type: "file";
    mime: string;
    filename?: string;
    url: string;
  }>;
}) => {
  const body: any = {
    parts: [{ type: "text", text: prompt }, ...(files || [])],
  };
  const parsedModel = parseModel(model || "");
  if (parsedModel) body.model = parsedModel;
  if (agent && String(agent).trim()) body.agent = String(agent).trim();

  try {
    return await request(
      withDirectory(`${sessionEndpoint(url, sessionId)}/message`, directory),
      { method: "POST", body, timeoutMs, signal },
    );
  } catch (err: any) {
    if (err?.name === "AbortError") {
      const externallyAborted = signal?.aborted === true;
      try {
        await request(
          withDirectory(`${sessionEndpoint(url, sessionId)}/abort`, directory),
          { method: "POST", timeoutMs: 8000 },
        );
      } catch {
        // 中止失败不阻塞报错
      }
      const abortError: any = new Error(
        externallyAborted
          ? "opencode 任务已被中止"
          : `opencode 运行超时(${Math.round(timeoutMs / 1000)}秒)，已尝试中止会话`,
      );
      abortError.aborted = true;
      throw abortError;
    }
    throw err;
  }
};

/** 监听 SSE 事件流，将权限请求交给上层策略回应。 */
export type OpencodePermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type OpencodePermissionReply = "once" | "always" | "reject";

const startPermissionWatcher = (
  url: string,
  sessionId: string,
  directory: string,
  replyPermission: (
    request: OpencodePermissionRequest,
  ) => Promise<OpencodePermissionReply>,
): { stop: () => void } => {
  const controller = new AbortController();

  const handlePermissionAsked = (payload: string) => {
    try {
      const parsed = JSON.parse(payload);
      const event = parsed?.payload ?? parsed;
      const data = event?.properties ?? event;
      if (!data || data.sessionID !== sessionId || !data.id) return;
      const permissionRequest: OpencodePermissionRequest = {
        id: String(data.id),
        sessionID: String(data.sessionID),
        permission: String(data.permission || data.type || "unknown"),
        patterns: Array.isArray(data.patterns)
          ? data.patterns.map((item: unknown) => String(item))
          : [],
        metadata:
          data.metadata && typeof data.metadata === "object"
            ? data.metadata
            : {},
        raw: data,
      };
      replyPermission(permissionRequest)
        .catch(() => "reject" as const)
        .then((reply) =>
          request(
            withDirectory(
              `${url}/permission/${encodeURIComponent(String(data.id))}/reply`,
              directory,
            ),
            {
              method: "POST",
              body: { reply },
              timeoutMs: 8000,
            },
          ),
        )
        .catch(() => {
          // 权限回应失败不阻塞主流程
        });
    } catch {
      // 忽略解析失败的事件
    }
  };

  const run = async () => {
    try {
      const res = await fetch(`${url}/global/event`, {
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("event:")) {
              eventName = trimmed.slice(6).trim();
            } else if (trimmed.startsWith("data:")) {
              const payload = trimmed.slice(5).trim();
              let payloadType = "";
              try {
                const parsed = JSON.parse(payload);
                payloadType = String(
                  parsed?.payload?.type || parsed?.type || "",
                );
              } catch {
                // 非 JSON 数据由具体事件处理器自行忽略。
              }
              if (
                eventName === "permission.asked" ||
                payloadType === "permission.asked"
              ) {
                handlePermissionAsked(payload);
              }
              eventName = "";
            }
          }
        }
      }
    } catch {
      // 事件流为尽力而为，断开不影响主流程
    }
  };

  run();

  return {
    stop: () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    },
  };
};

const extractMessageError = (error: any) => {
  if (!error) return null;
  const message = error?.data?.message || error?.message || String(error);
  const name = error?.name || "opencode错误";
  return `${name}: ${message}`;
};

const parseMessageResult = (data: any) => {
  const info = data?.info || {};
  const parts = Array.isArray(data?.parts)
    ? data.parts
    : Array.isArray(data?.message?.parts)
      ? data.message.parts
      : Array.isArray(info?.parts)
        ? info.parts
        : [];

  const text = stripAnsi(
    parts
      .filter((part: any) => part?.type === "text" && !part?.ignored)
      .map((part: any) => part?.text || "")
      .join("\n")
      .trim(),
  );

  const reasoning = stripAnsi(
    parts
      .filter((part: any) => part?.type === "reasoning")
      .map((part: any) => part?.text || "")
      .join("\n")
      .trim(),
  );

  const toolCalls = parts
    .filter((part: any) => part?.type === "tool" && part?.state)
    .slice(0, MAX_TOOL_CALLS)
    .map((part: any) => {
      const state = part.state || {};
      return {
        tool: part.tool,
        status: state.status || "unknown",
        title: state.title || null,
        input:
          typeof state.input === "object"
            ? truncateText(JSON.stringify(state.input), 2000)
            : truncateText(String(state.input || ""), 2000),
        output:
          state.status === "completed"
            ? truncateText(stripAnsi(state.output), 4000)
            : state.error
              ? truncateText(stripAnsi(state.error), 4000)
              : undefined,
      };
    });

  const activity = toolCalls
    .map((call: any) => {
      const lines = [`${call.tool || "工具"}：${call.title || call.status}`];
      if (call.input) lines.push(`参数：${call.input}`);
      if (call.output) lines.push(`结果：${call.output}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return {
    info,
    text,
    reasoning,
    toolCalls,
    activity,
    error: extractMessageError(info.error),
  };
};

export type RunOpencodeInput = {
  action?: string;
  prompt?: string;
  sessionId?: string;
  projectPath?: string;
  model?: string;
  agent?: string;
  autoApprove?: boolean;
  timeoutSeconds?: number;
  guid?: string;
  userID?: string;
};

export type OpencodeRunRecord = {
  guid?: string;
  userID?: string;
  sessionId: string;
  directory: string;
  url: string;
  controller: AbortController;
};

const activeRuns: OpencodeRunRecord[] = [];

const registerActiveRun = (record: OpencodeRunRecord): (() => void) => {
  activeRuns.push(record);
  return () => {
    const index = activeRuns.indexOf(record);
    if (index !== -1) activeRuns.splice(index, 1);
  };
};

/**
 * 中止正在运行的任务。可选按会话(guid)或会话ID过滤；都不传则中止全部任务。
 */
export const abortOpencodeRuns = async (options?: {
  guid?: string;
  userID?: string;
  sessionId?: string;
}): Promise<{ aborted: number }> => {
  const targets = activeRuns.filter((run) => {
    if (options?.guid && run.guid !== options.guid) return false;
    if (options?.userID && run.userID !== options.userID) return false;
    if (options?.sessionId && run.sessionId !== options.sessionId) return false;
    return true;
  });

  let aborted = 0;
  for (const run of targets) {
    try {
      run.controller.abort();
      await request(
        withDirectory(
          `${run.url}/session/${encodeURIComponent(run.sessionId)}/abort`,
          run.directory,
        ),
        { method: "POST", timeoutMs: 8000 },
      );
      aborted += 1;
    } catch {
      // 中止失败不阻塞其他任务
    }
  }
  return { aborted };
};

export const runOpencode = async (input: RunOpencodeInput = {}) => {
  const action = String(input.action || "run");
  const { url } = await ensureOpencodeServer();

  if (action === "serverInfo") {
    let version: string | null = null;
    try {
      const health = await request(`${url}/global/health`, { timeoutMs: 5000 });
      version = health?.version || null;
    } catch {
      // 健康检查失败不阻塞
    }
    return {
      ok: true,
      action,
      serverUrl: url,
      webUrl: url,
      version,
      message: `本地 opencode 服务已就绪，可打开 ${url} 查看 opencode Web 界面`,
    };
  }

  const projectPath = String(input.projectPath || "").trim();
  if (!projectPath) {
    return { ok: false, error: "projectPath(项目目录绝对路径) 不能为空" };
  }
  const resolvedDir = path.resolve(projectPath);
  if (!fs.existsSync(resolvedDir)) {
    return { ok: false, error: `项目目录不存在: ${projectPath}` };
  }
  if (!fs.statSync(resolvedDir).isDirectory()) {
    return { ok: false, error: `项目路径不是目录: ${projectPath}` };
  }

  if (action === "listSessions") {
    const sessions = await request(
      `${url}/session?directory=${encodeURIComponent(resolvedDir)}`,
      { timeoutMs: 15000 },
    );
    const list = Array.isArray(sessions) ? sessions : [];
    return {
      ok: true,
      action,
      serverUrl: url,
      webUrl: url,
      directory: resolvedDir,
      sessions: list.slice(0, 50).map((item: any) => ({
        id: item.id,
        title: item.title,
        directory: item.directory,
        created: item.time?.created || null,
        updated: item.time?.updated || null,
      })),
    };
  }

  if (action !== "run") {
    return { ok: false, error: `未知操作类型: ${action}` };
  }

  const prompt = String(input.prompt || "").trim();
  if (!prompt) {
    return { ok: false, error: "prompt(要交给 opencode 的提示词) 不能为空" };
  }

  const autoApprove = input.autoApprove !== false;
  const timeoutSeconds = Math.min(
    Number(input.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
  );

  const session = await resolveSession(
    url,
    resolvedDir,
    input.sessionId,
    autoApprove,
  );
  const sessionId = String(session.id);

  const controller = new AbortController();
  const unregister = registerActiveRun({
    guid: input.guid,
    userID: input.userID,
    sessionId,
    directory: resolvedDir,
    url,
    controller,
  });

  const watcher = startPermissionWatcher(
    url,
    sessionId,
    resolvedDir,
    async () => (autoApprove ? "always" : "reject"),
  );
  try {
    const data = await sendSessionMessage({
      url,
      sessionId,
      directory: resolvedDir,
      prompt,
      model: input.model,
      agent: input.agent,
      timeoutMs: timeoutSeconds * 1000,
      signal: controller.signal,
    });
    const parsed = parseMessageResult(data);
    const modelName =
      parsed.info?.providerID && parsed.info?.modelID
        ? `${parsed.info.providerID}/${parsed.info.modelID}`
        : parsed.info?.modelID || null;

    return {
      ok: true,
      action: "run",
      sessionId,
      sessionTitle: session.title || null,
      serverUrl: url,
      webUrl: url,
      model: modelName,
      tokens: parsed.info?.tokens || null,
      finish: parsed.info?.finish || null,
      error: parsed.error,
      output: truncateText(parsed.text),
      reasoning: parsed.reasoning ? truncateText(parsed.reasoning, 8000) : null,
      toolCalls: parsed.toolCalls,
      message: `opencode 会话 ${sessionId} 已运行完成${parsed.error ? "，但出现了错误" : ""}。可在 ${url} 查看完整过程`,
    };
  } finally {
    unregister();
    watcher.stop();
  }
};

export const sendOpencodeSessionMessage = async (input: {
  url: string;
  directory: string;
  sessionId: string;
  prompt: string;
  model: string;
  timeoutSeconds?: number;
  guid?: string;
  userID?: string;
  files?: Array<{
    type: "file";
    mime: string;
    filename?: string;
    url: string;
  }>;
  replyPermission: (
    request: OpencodePermissionRequest,
  ) => Promise<OpencodePermissionReply>;
}) => {
  const timeoutSeconds = Math.min(
    Number(input.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
  );
  const controller = new AbortController();
  const unregister = registerActiveRun({
    guid: input.guid,
    userID: input.userID,
    sessionId: input.sessionId,
    directory: input.directory,
    url: input.url,
    controller,
  });
  const watcher = startPermissionWatcher(
    input.url,
    input.sessionId,
    input.directory,
    input.replyPermission,
  );
  try {
    const data = await sendSessionMessage({
      url: input.url,
      sessionId: input.sessionId,
      directory: input.directory,
      prompt: input.prompt,
      model: input.model,
      agent: "build",
      timeoutMs: timeoutSeconds * 1000,
      signal: controller.signal,
      files: input.files,
    });
    const parsed = parseMessageResult(data);
    const session = await getOpencodeSession(
      input.url,
      input.directory,
      input.sessionId,
    );
    return {
      ok: !parsed.error,
      output: truncateText(parsed.text),
      reasoning: parsed.reasoning ? truncateText(parsed.reasoning, 8000) : null,
      activity: parsed.activity ? truncateText(parsed.activity, 16000) : null,
      error: parsed.error,
      session,
    };
  } finally {
    watcher.stop();
    unregister();
  }
};
