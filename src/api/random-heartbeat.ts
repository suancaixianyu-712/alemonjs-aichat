import type { HeartbeatTask } from "../config";

const MIN_INTERVAL_MS = 60 * 1000;

export type HeartbeatPermissionMode = "auto" | "full";

export type ParsedDuration = {
  ms: number;
  label: string;
};

const DURATION_RE =
  /^(\d+)\s*(秒|秒钟|s|分钟|分|m|小时|时|h)$/i;

/** 解析单个时长（最少 1 分钟）。 */
export const parseDurationMs = (value: string): ParsedDuration | null => {
  const match = String(value || "").trim().match(DURATION_RE);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier = ["小时", "时", "h"].includes(unit)
    ? 60 * 60 * 1000
    : ["分钟", "分", "m"].includes(unit)
      ? 60 * 1000
      : 1000;
  const ms = amount * multiplier;
  if (!Number.isSafeInteger(ms) || ms < MIN_INTERVAL_MS) return null;
  return { ms, label: `${amount}${match[2]}` };
};

/** 解析随机区间：`15m-2h` / `15m~2h`。 */
export const parseRandomRange = (
  value: string,
): { minMs: number; maxMs: number; minLabel: string; maxLabel: string } | null => {
  const trimmed = String(value || "").trim();
  const parts = trimmed.split(/\s*[-~～到至]\s*/);
  if (parts.length !== 2) return null;
  const min = parseDurationMs(parts[0]);
  const max = parseDurationMs(parts[1]);
  if (!min || !max || max.ms < min.ms) return null;
  return {
    minMs: min.ms,
    maxMs: max.ms,
    minLabel: min.label,
    maxLabel: max.label,
  };
};

export const formatDurationMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h`;
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
};

/** 在 [minMs, maxMs] 内随机，并用 ceilingMs 夹紧单次间隔。 */
export const computeRandomNextDeltaMs = (
  minMs: number,
  maxMs: number,
  ceilingMs?: number,
  random: () => number = Math.random,
): number => {
  const lo = Math.max(MIN_INTERVAL_MS, Math.min(minMs, maxMs));
  const hi = Math.max(lo, Math.max(minMs, maxMs));
  const span = hi - lo;
  const raw = lo + Math.floor(random() * (span + 1));
  if (ceilingMs == null || !Number.isFinite(ceilingMs)) return raw;
  if (ceilingMs < lo) return Math.max(MIN_INTERVAL_MS, ceilingMs);
  return Math.min(raw, ceilingMs);
};

export const computeRandomNextRunAt = (
  now: number,
  minMs: number,
  maxMs: number,
  ceilingMs?: number,
  random?: () => number,
): number => now + computeRandomNextDeltaMs(minMs, maxMs, ceilingMs, random);

/** scheduler：未 enabled 的 random 不触发、不推进。 */
export const shouldRunHeartbeat = (
  task: Pick<HeartbeatTask, "mode" | "enabled" | "nextRunAt">,
  now: number,
): boolean => {
  if (task.nextRunAt > now) return false;
  if (task.mode === "random" && task.enabled === false) return false;
  return true;
};

export const computeNextHeartbeatRunAt = (
  task: HeartbeatTask,
  now: number,
  random?: () => number,
): number => {
  if (task.mode === "daily") {
    return task.nextRunAt + 24 * 60 * 60 * 1000;
  }
  if (task.mode === "random") {
    const minMs = Number(task.minMs) || MIN_INTERVAL_MS;
    const maxMs = Number(task.maxMs) || minMs;
    return computeRandomNextRunAt(now, minMs, maxMs, task.ceilingMs, random);
  }
  return task.nextRunAt + Number(task.value);
};

export type ClampRandomRangeInput = {
  requestedMinMs: number;
  requestedMaxMs: number;
  ownerMinMs: number;
  ownerMaxMs: number;
  ceilingMs?: number;
};

export type ClampRandomRangeResult =
  | { ok: true; minMs: number; maxMs: number }
  | { ok: false; error: string };

/** AI 工具：新区间必须夹在主人上下限内，且不超过 ceiling。 */
export const clampRandomRangeForAI = (
  input: ClampRandomRangeInput,
): ClampRandomRangeResult => {
  const {
    requestedMinMs,
    requestedMaxMs,
    ownerMinMs,
    ownerMaxMs,
    ceilingMs,
  } = input;
  if (
    ![requestedMinMs, requestedMaxMs, ownerMinMs, ownerMaxMs].every(
      (n) => Number.isFinite(n) && n >= MIN_INTERVAL_MS,
    )
  ) {
    return { ok: false, error: "区间无效：时长须为至少 1 分钟的有限数值" };
  }
  if (requestedMinMs > requestedMaxMs) {
    return { ok: false, error: "区间无效：min 不能大于 max" };
  }
  if (requestedMinMs < ownerMinMs || requestedMaxMs > ownerMaxMs) {
    return {
      ok: false,
      error: `区间超出主人上下限（${formatDurationMs(ownerMinMs)}-${formatDurationMs(ownerMaxMs)}）`,
    };
  }
  const cap =
    ceilingMs != null && Number.isFinite(ceilingMs) ? ceilingMs : ownerMaxMs;
  if (requestedMaxMs > cap) {
    return {
      ok: false,
      error: `max 超过随机心跳上限 ${formatDurationMs(cap)}`,
    };
  }
  return { ok: true, minMs: requestedMinMs, maxMs: requestedMaxMs };
};

export const parsePermissionMode = (
  value: string,
): HeartbeatPermissionMode | null => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "auto" || raw === "自动审核") return "auto";
  if (raw === "full" || raw === "完全访问") return "full";
  return null;
};

export const formatPermissionMode = (mode?: string): string =>
  mode === "full" ? "完全访问" : "自动审核";

export type HeartbeatAIConfigLike = {
  host?: string;
  key?: string;
  model?: string;
};

/** host/key/model 均非空才算可用。 */
export const isUsableAIConfig = (
  config: HeartbeatAIConfigLike | null | undefined,
): boolean =>
  Boolean(
    config?.host?.trim() && config?.key?.trim() && config?.model?.trim(),
  );

/**
 * 心跳触发时可选覆盖本次 AI 配置；不改群 currentAI。
 * listConfig 无效或未绑定时回退 baseConfig。
 */
export const pickHeartbeatAIConfig = <T extends HeartbeatAIConfigLike>(
  baseConfig: T,
  heartbeatAiName: string | undefined | null,
  listConfig: T | null | undefined,
): { config: T; applied: boolean; aiName?: string } => {
  const name = String(heartbeatAiName || "").trim();
  if (!name || !isUsableAIConfig(listConfig)) {
    return { config: baseConfig, applied: false, aiName: name || undefined };
  }
  return { config: listConfig as T, applied: true, aiName: name };
};

export const formatHeartbeatAILine = (aiName?: string | null): string =>
  aiName?.trim()
    ? `心跳模型：${aiName.trim()}`
    : "心跳模型：未绑定（使用群当前 AI）";

export const formatHeartbeatStatus = (task: HeartbeatTask | null): string => {
  if (!task) return "当前会话没有心跳任务。";
  const next = new Date(task.nextRunAt).toLocaleString("zh-CN");
  const aiLine = formatHeartbeatAILine(task.aiName);
  if (task.mode === "random") {
    const min = formatDurationMs(Number(task.minMs) || 0);
    const max = formatDurationMs(Number(task.maxMs) || 0);
    const ceiling =
      task.ceilingMs != null
        ? formatDurationMs(task.ceilingMs)
        : "(未单独设置，默认=max)";
    const enabled = task.enabled === false ? "关闭" : "开启";
    return [
      "心跳状态：随机",
      `开关：${enabled}`,
      `区间：${min}-${max}`,
      `上限：${ceiling}`,
      `权限：${formatPermissionMode(task.permissionMode)}`,
      aiLine,
      `下次：${next}`,
    ].join("\n");
  }
  if (task.mode === "daily") {
    return `心跳状态：固定每天 ${task.value}\n${aiLine}\n下次：${next}`;
  }
  const minutes = Number(task.value) / 60000;
  return `心跳状态：固定间隔每 ${minutes} 分钟\n${aiLine}\n下次：${next}`;
};

/** 去掉 random 专用字段，供固定心跳覆盖写入；保留 aiName（心跳模型绑定）。 */
export const stripRandomHeartbeatFields = <T extends Record<string, unknown>>(
  task: T,
): T => {
  const {
    minMs: _minMs,
    maxMs: _maxMs,
    ceilingMs: _ceilingMs,
    enabled: _enabled,
    permissionMode: _permissionMode,
    ownerMinMs: _ownerMinMs,
    ownerMaxMs: _ownerMaxMs,
    ...rest
  } = task as T & {
    minMs?: unknown;
    maxMs?: unknown;
    ceilingMs?: unknown;
    enabled?: unknown;
    permissionMode?: unknown;
    ownerMinMs?: unknown;
    ownerMaxMs?: unknown;
  };
  return rest as T;
};

export const resolveDurationInput = (
  value: string | number | undefined,
): number | null => {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= MIN_INTERVAL_MS ? value : null;
  }
  const parsed = parseDurationMs(String(value));
  return parsed ? parsed.ms : null;
};
