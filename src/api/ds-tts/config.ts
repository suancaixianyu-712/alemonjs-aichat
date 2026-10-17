/**
 * ds-tts 配置：默认值 ⊕ `data/ds-tts/config.json` 热读 ⊕ Redis `ai:ds_tts:config` 镜像。
 * 刻意不含任何凭据字段。
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DsTtsConfigPatch, DsTtsConfigView, DsTtsFormat, DsTtsMode } from "./protocol";
import { configFilePath } from "./paths";

export const DS_TTS_REDIS_CONFIG_KEY = "ai:ds_tts:config";

export const DS_TTS_VOICES = ["mira", "echo", "stella", "tide"] as const;
export type DsTtsVoiceId = (typeof DS_TTS_VOICES)[number];

/** 部署默认值（v1 固定 echo 投递）。 */
export const DEFAULT_DS_TTS_CONFIG: DsTtsConfigView = {
  voice: "mira",
  format: "pcm",
  mode: "echo",
  maxChars: 2000,
  cdpUrl: "",
  cdpPort: 9222,
  browserPath: "",
  userDataDir: "",
  autoLaunch: true,
  chatSessionId: "",
  echoPrompt:
    "请原样输出下面这段文本，不要添加任何解释、标题、序号或 Markdown 格式，也不要翻译：\n\n{text}",
  echoVerify: true,
  timeoutMs: 120000,
  cacheEnabled: true,
  cacheKeepDays: 30,
  ffplayPath: "",
};

export interface DsTtsRuntimeState {
  userModeSupported: boolean | null;
  chatSessionId: string;
  lastProbe: { code: number; msg: string; at: number } | null;
  voicesCache: { at: number; currentVoiceId: string; voices: unknown[] } | null;
}

interface OverlayFile {
  config?: DsTtsConfigPatch;
  runtime?: Partial<DsTtsRuntimeState>;
}

function normalizeFormat(value: unknown, fallback: DsTtsFormat): DsTtsFormat {
  return value === "opus" || value === "pcm" ? value : fallback;
}

function normalizeMode(value: unknown, fallback: DsTtsMode): DsTtsMode {
  // v1 固定 echo；文件里即便写了 auto/user 也压成 echo，避免白跑投递
  if (value === "echo" || value === "user" || value === "auto") return "echo";
  return fallback;
}

export function isDsTtsVoiceId(value: unknown): value is DsTtsVoiceId {
  return typeof value === "string" && (DS_TTS_VOICES as readonly string[]).includes(value);
}

/** 把任意补丁规整成合法视图字段。 */
export function normalizeConfigPatch(patch: Record<string, unknown>): DsTtsConfigPatch {
  const out: DsTtsConfigPatch = {};
  if (typeof patch.voice === "string" && patch.voice.trim()) {
    const v = patch.voice.trim().toLowerCase();
    if (isDsTtsVoiceId(v)) out.voice = v;
  }
  if (patch.format === "pcm" || patch.format === "opus") out.format = patch.format;
  // v1 不允许改 mode；始终 echo
  if (patch.mode !== undefined) out.mode = "echo";
  if (typeof patch.maxChars === "number" && Number.isFinite(patch.maxChars)) {
    out.maxChars = Math.min(20000, Math.max(50, Math.round(patch.maxChars)));
  }
  if (typeof patch.cdpUrl === "string") out.cdpUrl = patch.cdpUrl.trim();
  if (typeof patch.cdpPort === "number" && Number.isFinite(patch.cdpPort)) {
    out.cdpPort = Math.min(65535, Math.max(1, Math.round(patch.cdpPort)));
  }
  if (typeof patch.browserPath === "string") out.browserPath = patch.browserPath.trim();
  if (typeof patch.userDataDir === "string") out.userDataDir = patch.userDataDir.trim();
  if (typeof patch.autoLaunch === "boolean") out.autoLaunch = patch.autoLaunch;
  if (typeof patch.chatSessionId === "string") out.chatSessionId = patch.chatSessionId.trim();
  if (typeof patch.echoPrompt === "string" && patch.echoPrompt.includes("{text}")) {
    out.echoPrompt = patch.echoPrompt;
  }
  if (typeof patch.echoVerify === "boolean") out.echoVerify = patch.echoVerify;
  if (typeof patch.timeoutMs === "number" && Number.isFinite(patch.timeoutMs)) {
    out.timeoutMs = Math.min(600000, Math.max(5000, Math.round(patch.timeoutMs)));
  }
  if (typeof patch.cacheEnabled === "boolean") out.cacheEnabled = patch.cacheEnabled;
  if (typeof patch.cacheKeepDays === "number" && Number.isFinite(patch.cacheKeepDays)) {
    out.cacheKeepDays = Math.max(0, Math.round(patch.cacheKeepDays));
  }
  if (typeof patch.ffplayPath === "string") out.ffplayPath = patch.ffplayPath.trim();
  return out;
}

function applyDefaults(merged: DsTtsConfigView): DsTtsConfigView {
  return {
    ...merged,
    voice: merged.voice || "mira",
    format: normalizeFormat(merged.format, "pcm"),
    mode: normalizeMode(merged.mode, "echo"),
    maxChars: Math.min(20000, Math.max(50, Math.round(merged.maxChars))),
    cdpPort: Math.min(65535, Math.max(1, Math.round(merged.cdpPort))),
    timeoutMs: Math.min(600000, Math.max(5000, Math.round(merged.timeoutMs))),
    cacheKeepDays: Math.max(0, Math.round(merged.cacheKeepDays)),
  };
}

/** 配置存储：本地 JSON 热读 + Redis 镜像（供指令查询）。 */
export class ConfigStore {
  private overlay: OverlayFile = {};
  private overlayMtimeMs = -1;
  private loaded = false;

  get filePath(): string {
    return configFilePath();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<void> {
    await this.refresh();
    this.loaded = true;
  }

  private async refresh(): Promise<void> {
    let mtimeMs = -1;
    try {
      mtimeMs = (await stat(this.filePath)).mtimeMs;
    } catch {
      // missing
    }
    if (mtimeMs === this.overlayMtimeMs) return;
    this.overlayMtimeMs = mtimeMs;
    if (mtimeMs < 0) {
      this.overlay = {};
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      this.overlay = typeof parsed === "object" && parsed !== null ? (parsed as OverlayFile) : {};
    } catch {
      this.overlay = {};
    }
  }

  private applyOverlay(): DsTtsConfigView {
    return applyDefaults({ ...DEFAULT_DS_TTS_CONFIG, ...(this.overlay.config ?? {}) });
  }

  async view(): Promise<DsTtsConfigView> {
    await this.refresh();
    return this.applyOverlay();
  }

  current(): DsTtsConfigView {
    return this.applyOverlay();
  }

  async patch(patch: DsTtsConfigPatch): Promise<DsTtsConfigView> {
    await this.refresh();
    const nextConfig: DsTtsConfigPatch = { ...(this.overlay.config ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (nextConfig as Record<string, unknown>)[key] = value;
    }
    await this.write({ ...this.overlay, config: nextConfig });
    await this.mirrorRedis(nextConfig);
    return this.applyOverlay();
  }

  async runtime(): Promise<DsTtsRuntimeState> {
    await this.refresh();
    const r = this.overlay.runtime ?? {};
    return {
      userModeSupported: r.userModeSupported ?? null,
      chatSessionId: r.chatSessionId ?? "",
      lastProbe: r.lastProbe ?? null,
      voicesCache: (r.voicesCache as DsTtsRuntimeState["voicesCache"]) ?? null,
    };
  }

  async setRuntime(patch: Partial<DsTtsRuntimeState>): Promise<void> {
    await this.refresh();
    await this.write({ ...this.overlay, runtime: { ...(this.overlay.runtime ?? {}), ...patch } });
  }

  private async write(next: OverlayFile): Promise<void> {
    const target = this.filePath;
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid.toString()}`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmp, target);
    this.overlay = next;
    try {
      this.overlayMtimeMs = (await stat(target)).mtimeMs;
    } catch {
      this.overlayMtimeMs = -1;
    }
  }

  /** Redis 只存用户可改字段镜像，不含 runtime / 凭据。懒加载，避免 import 时连 Redis。 */
  private async mirrorRedis(config: DsTtsConfigPatch): Promise<void> {
    try {
      const { default: redisClient } = await import("@src/config");
      const view = applyDefaults({ ...DEFAULT_DS_TTS_CONFIG, ...config });
      const publicView = {
        voice: view.voice,
        maxChars: view.maxChars,
        timeoutMs: view.timeoutMs,
        cdpPort: view.cdpPort,
        autoLaunch: view.autoLaunch,
        browserPath: view.browserPath,
        cdpUrl: view.cdpUrl,
        echoVerify: view.echoVerify,
        cacheEnabled: view.cacheEnabled,
        mode: view.mode,
      };
      await redisClient.redis.set(DS_TTS_REDIS_CONFIG_KEY, JSON.stringify(publicView));
    } catch {
      // Redis 不可用不阻断本地配置
    }
  }
}

let storeSingleton: ConfigStore | undefined;

export function getDsTtsConfigStore(): ConfigStore {
  if (!storeSingleton) storeSingleton = new ConfigStore();
  return storeSingleton;
}

/** 测试用：重置单例。 */
export function resetDsTtsConfigStoreForTests(): void {
  storeSingleton = undefined;
}
