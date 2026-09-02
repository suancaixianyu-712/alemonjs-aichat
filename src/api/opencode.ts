import { spawn, execFile } from "child_process";
import fs from "fs";
import path from "path";
import { getAiChatConfigValue } from "../config/app";

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
  const port = Number(cfg.port ?? process.env.OPENCODE_TOOL_SERVER_PORT ?? 4096);
  return {
    port: Number.isInteger(port) && port > 0 ? port : 4096,
    hostname: String(cfg.hostname || "127.0.0.1"),
    binary: cfg.binary ? String(cfg.binary) : undefined,
  };
};

const truncateText = (text: string, max = MAX_OUTPUT_CHARS) => {
  if (!text) return text;
  const str = String(text);
  return str.length > max
    ? `${str.slice(0, max)}\n[输出过长已截断]`
    : str;
};

const stripAnsi = (text: string) =>
  String(text || "").replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );

let serverUrl: string | null = null;
let startingPromise: Promise<{ url: string }> | null = null;

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
    execFile("where.exe", ["opencode"], { windowsHide: true }, (error, stdout) => {
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
            if (match) return resolve(match[1]);
          } catch {
            // ignore unreadable shim, continue scanning
          }
        }
      }
      return resolve(lines[0] || "");
    });
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
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const merged = signal ? mergeSignals(signal, controller) : controller.signal;
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
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

const getSession = async (url: string, directory: string, id: string) => {
  try {
    return await request(withDirectory(sessionEndpoint(url, id), directory), {
      timeoutMs: 10000,
    });
  } catch (err: any) {
    if (err?.status === 404) return null;
    throw err;
  }
};

const createSession = async (
  url: string,
  directory: string,
  autoApprove: boolean,
) => {
  const body: any = {};
  if (autoApprove) {
    body.permission = [{ permission: "*", pattern: "*", action: "allow" }];
  }
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
    const existing = await getSession(url, directory, trimmed);
    if (existing) return existing;
  }
  return await createSession(url, directory, autoApprove);
};

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
}: {
  url: string;
  sessionId: string;
  directory: string;
  prompt: string;
  model?: string;
  agent?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => {
  const body: any = { parts: [{ type: "text", text: prompt }] };
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

/**
 * 监听 SSE 事件流，自动回应当前会话的权限请求。
 * autoApprove=true 时自动允许，否则自动拒绝，避免消息调用因权限等待而挂起。
 */
const startPermissionWatcher = (
  url: string,
  sessionId: string,
  directory: string,
  autoApprove: boolean,
): { stop: () => void } => {
  const controller = new AbortController();

  const handlePermissionAsked = (payload: string) => {
    try {
      const data = JSON.parse(payload);
      if (!data || data.sessionID !== sessionId || !data.id) return;
      request(
        withDirectory(
          `${url}/permission/${encodeURIComponent(String(data.id))}/reply`,
          directory,
        ),
        {
          method: "POST",
          body: { reply: autoApprove ? "always" : "reject" },
          timeoutMs: 8000,
        },
      ).catch(() => {
        // 权限回应失败不阻塞主流程
      });
    } catch {
      // 忽略解析失败的事件
    }
  };

  const run = async () => {
    try {
      const res = await fetch(`${url}/event`, { signal: controller.signal });
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
              if (eventName === "permission.asked") {
                handlePermissionAsked(trimmed.slice(5).trim());
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
  const parts = Array.isArray(data?.parts) ? data.parts : [];

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

  return {
    info,
    text,
    reasoning,
    toolCalls,
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
};

export type OpencodeRunRecord = {
  guid?: string;
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
  sessionId?: string;
}): Promise<{ aborted: number }> => {
  const targets = activeRuns.filter((run) => {
    if (options?.guid && run.guid !== options.guid) return false;
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

  const session = await resolveSession(url, resolvedDir, input.sessionId, autoApprove);
  const sessionId = String(session.id);

  const controller = new AbortController();
  const unregister = registerActiveRun({
    guid: input.guid,
    sessionId,
    directory: resolvedDir,
    url,
    controller,
  });

  const watcher = startPermissionWatcher(url, sessionId, resolvedDir, autoApprove);
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
