export type SubAgentProgressEvent = {
  type: "started" | "thinking" | "tool_start" | "tool_finish" | "completed" | "failed" | "cancelled";
  round?: number;
  tool?: string;
  success?: boolean;
  durationMs?: number;
};

const duration = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)}秒`;

/** 只接受结构化阶段信息；任务原文、工具参数、结果和异常正文不进入日志。 */
export const createSubAgentProgress = (options: {
  id: string;
  notify: boolean;
  send: (text: string) => Promise<unknown>;
  log: (text: string) => void;
  onActivity?: (text: string) => void;
  now?: () => number;
  intervalMs?: number;
  heartbeatMs?: number;
  sendTimeoutMs?: number;
}) => {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const id = /^sub_[a-f0-9]{12}$/.test(options.id) ? options.id : "sub_task";
  let closed = false;
  let stage = "启动中";
  let round = 0;
  let pending: string[] = [];
  let chain = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deliver = (lines: string[]) => {
    if (!options.notify || !lines.length) return chain;
    const text = `后台任务 ${id}\n${lines.join("\n")}`;
    chain = chain.then(async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => options.send(text)),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("progress timeout")), options.sendTimeoutMs ?? 8000);
            timeout.unref?.();
          }),
        ]);
      } catch {
        options.log(`[子agent ${id}] 进度消息发送失败，任务继续执行`);
      } finally { if (timeout) clearTimeout(timeout); }
    });
    return chain;
  };

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const lines = pending;
    pending = [];
    return deliver(lines);
  };

  const record = (line: string) => {
    const text = `[子agent ${id}] ${line}`;
    options.log(text);
    options.onActivity?.(line);
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    const line = `仍在执行：${stage}，总耗时 ${duration(now() - startedAt)}`;
    record(line);
    pending = [...pending, line].slice(-3);
    void flush();
  }, options.heartbeatMs ?? 30000);
  heartbeat.unref?.();

  const emit = (event: SubAgentProgressEvent) => {
    if (closed) return;
    round = event.round ?? round;
    const tool = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(event.tool || "") ? event.tool : "未知工具";
    let line: string;
    switch (event.type) {
      case "started": line = "已启动"; stage = "启动中"; break;
      case "thinking": line = `第 ${round} 轮：正在请求 AI`; stage = `第 ${round} 轮等待 AI`; break;
      case "tool_start": line = `第 ${round} 轮：开始 ${tool}`; stage = `第 ${round} 轮执行 ${tool}`; break;
      case "tool_finish": line = `第 ${round} 轮：${tool} ${event.success ? "成功" : "失败"}（${duration(event.durationMs ?? 0)}）`; stage = `第 ${round} 轮分析工具结果`; break;
      default: {
        const label = event.type === "completed" ? "已完成" : event.type === "cancelled" ? "已取消" : "执行失败";
        line = `${label}，共 ${round} 轮，总耗时 ${duration(now() - startedAt)}`;
        closed = true;
        clearInterval(heartbeat);
      }
    }
    record(line);
    pending = [...pending, line].slice(-3);
    if (event.type === "started" || closed) void flush();
    else if (!timer && options.notify) {
      timer = setTimeout(() => { void flush(); }, options.intervalMs ?? 5000);
      timer.unref?.();
    }
  };

  return { emit, flush, finish: async (status: "completed" | "failed" | "cancelled") => {
    emit({ type: status });
    await chain;
  } };
};
