import { getConfig, getConfigValue } from "alemonjs";

/**
 * AlemonJS 引擎级运行时配置。
 *
 * 这些配置项在 package.json 的 "alemonjs" 字段中声明（config 数组），
 * 供 ALemonX 工作台在机器人配置页展示与写入。写入后会被保存到
 * alemon.config.yaml 的命名空间下（对非 @alemonjs/* 包，命名空间即包名
 * alemonjs-aichat）。业务代码通过 getConfigValue() 读取。
 *
 * 约定：
 * - 读取优先级：alemon.config.yaml（alemonjs-aichat / aiChat 命名空间 / 顶层）
 *   > package.json 声明的 default。
 * - 默认值保持 local + websocket，确保不配置时行为零变化。
 */

const NAMESPACES = ["alemonjs-aichat", "aiChat"];

type RuntimeMode = "local" | "external";
type TransportMode = "websocket" | "http";

export type RuntimeConfig = {
  /** 运行时模式：local（插件托管，默认）、external（外部进程托管） */
  runtime_mode: RuntimeMode;
  /** 消息桥接传输方式：websocket（默认）或 http（兼容网关服务） */
  transport: TransportMode;
  /** GsCore HTTP 地址，用于 external 运行时连接外部托管网关 */
  gscore_url: string;
};

/** package.json 中 alemonjs.config 声明的默认值 */
const DECLARED_DEFAULTS: RuntimeConfig = {
  runtime_mode: "local",
  transport: "websocket",
  gscore_url: "",
};

/**
 * 从 package.json 的 alemonjs.config 数组读取某项的 default。
 * 与 ALemonX 的 packageschema 约定一致（字段 name/type/required/description/default）。
 */
function readDeclaredDefault(key: keyof RuntimeConfig): string | undefined {
  try {
    const pkg = getConfig().package as Record<string, any> | null;
    const alemonjs = pkg?.alemonjs as Record<string, any> | undefined;
    const configList = alemonjs?.config as Array<Record<string, any>> | undefined;
    if (!Array.isArray(configList)) return undefined;
    const field = configList.find((item) => item?.name === key);
    const defaultValue = field?.default;
    return typeof defaultValue === "string" ? defaultValue : undefined;
  } catch {
    return undefined;
  }
}

/** 从 alemon.config.yaml 读取候选命名空间下的配置值 */
function readConfigValue(key: keyof RuntimeConfig): string | undefined {
  try {
    const value = getConfigValue() as Record<string, any>;
    if (!value || typeof value !== "object") return undefined;
    for (const namespace of NAMESPACES) {
      const section = value[namespace];
      const raw = section && typeof section === "object" ? section[key] : undefined;
      if (raw !== undefined && raw !== null) {
        return typeof raw === "string" ? raw : String(raw);
      }
      // 少数场景用户直接放在顶层
      const top = value[key];
      if (top !== undefined && top !== null) {
        return typeof top === "string" ? top : String(top);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeRuntimeMode(raw?: string): RuntimeMode {
  return raw === "external" ? "external" : "local";
}

function normalizeTransport(raw?: string): TransportMode {
  return raw === "http" ? "http" : "websocket";
}

function resolveValue(key: keyof RuntimeConfig): string | undefined {
  return readConfigValue(key) ?? readDeclaredDefault(key);
}

/**
 * 读取运行时模式。默认 "local"（插件托管）。
 */
export function getRuntimeMode(): RuntimeMode {
  return normalizeRuntimeMode(resolveValue("runtime_mode"));
}

/**
 * 读取消息桥接传输方式。默认 "websocket"。
 */
export function getTransport(): TransportMode {
  return normalizeTransport(resolveValue("transport"));
}

/**
 * 读取 GsCore HTTP 地址。默认空字符串（未启用外部托管）。
 */
export function getGscoreUrl(): string {
  return (resolveValue("gscore_url") ?? "").trim();
}

/**
 * 一次性读取全部引擎级运行时配置。
 */
export function getRuntimeConfig(): RuntimeConfig {
  return {
    runtime_mode: getRuntimeMode(),
    transport: getTransport(),
    gscore_url: getGscoreUrl(),
  };
}
