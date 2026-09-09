import { ProxyAgent, setGlobalDispatcher } from "undici";
import { getAiChatConfigValue } from "../config/app";

/**
 * 全局网络代理。
 *
 * 配置示例（alemon.config.yaml 的 aiChat / alemonjs-aichat 命名空间，或工作台）：
 *
 *   proxy: "http://127.0.0.1:7890"
 *
 * 也支持对象写法，便于按需关闭与追加白名单：
 *
 *   proxy:
 *     url: "http://127.0.0.1:7890"
 *     enabled: true
 *     noProxy: ["api.example.com"]
 *
 * 说明：
 * - 通过 setGlobalDispatcher 让 Node 原生 fetch / undici 全局走代理，
 *   项目内所有 fetch(...) 调用（含 openai、ai-sdk 等等三方 SDK）无需改动。
 * - 同时写入 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量，
 *   兼容 spawn 的子进程（例如 opencode、playwright 的部分场景）。
 * - 未配置 proxy 时不做任何事，行为与此前完全一致。
 * - playwright-core 的浏览器不走 fetch，需要单独在 launch 时传 proxy，
 *   不在本文件处理范围内。
 */

/** 默认不经过代理的地址，避免本地/内网请求被绕出去。 */
export const DEFAULT_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

export type ProxySetting = {
  url: string;
  enabled: boolean;
  noProxy: string[];
};

let initialized = false;

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeNoProxy = (value: unknown): string[] => {
  const list = Array.isArray(value)
    ? value.map((item) => String(item).trim())
    : typeof value === "string"
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  return list.filter(Boolean);
};

/** 读取配置中的 proxy 字段，缺省或格式错误时返回 null。 */
export const getProxySetting = (): ProxySetting | null => {
  const raw = getAiChatConfigValue().proxy;

  if (typeof raw === "string") {
    const url = raw.trim();
    return url
      ? { url, enabled: true, noProxy: [...DEFAULT_NO_PROXY] }
      : null;
  }

  if (!isRecord(raw)) return null;

  const url = String(raw.url ?? raw.host ?? "").trim();
  if (!url) return null;

  return {
    url,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    noProxy: normalizeNoProxy(raw.noProxy ?? raw.no_proxy),
  };
};

/** 把代理写入环境变量，供非 fetch 的客户端与子进程使用。 */
const applyEnvProxy = ({ url, noProxy }: ProxySetting) => {
  process.env.HTTP_PROXY = url;
  process.env.HTTPS_PROXY = url;
  process.env.http_proxy = url;
  process.env.https_proxy = url;
  if (noProxy.length) {
    const value = noProxy.join(",");
    process.env.NO_PROXY = value;
    process.env.no_proxy = value;
  }
};

/**
 * 初始化全局代理，应在进程启动早期调用一次。
 * 重复调用是安全的，后续调用会直接返回。
 */
export const setupGlobalProxy = (): ProxySetting | null => {
  if (initialized) return getProxySetting();
  initialized = true;

  let setting: ProxySetting | null = null;
  try {
    setting = getProxySetting();
  } catch (error) {
    logger.error({
      message: "读取代理配置失败",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!setting) {
    return null;
  }

  if (!setting.enabled) {
    logger.info({ message: "全局代理已配置但处于关闭状态", proxy: setting.url });
    return setting;
  }

  try {
    setGlobalDispatcher(new ProxyAgent(setting.url));
    applyEnvProxy(setting);

    logger.info({
      message: "全局代理已启用",
      proxy: setting.url,
      noProxy: setting.noProxy.length ? setting.noProxy.join(",") : "无",
    });
  } catch (error) {
    logger.error({
      message: "全局代理初始化失败, 将直连",
      proxy: setting.url,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return setting;
};
