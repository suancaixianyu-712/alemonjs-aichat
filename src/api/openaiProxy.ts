import nodeFetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/**
 * 为 OpenAI SDK 创建直连 HTTP(S) 代理的 fetch。
 * 请求仍使用真实 API 地址，仅网络传输经过本地代理，不需要额外转发服务。
 */
export const createOpenAIProxyFetch = (proxyUrl?: string) => {
  const normalized = String(proxyUrl || "").trim();
  if (!normalized) return undefined;

  const agent = new HttpsProxyAgent(normalized);
  return ((url: any, init: any = {}) =>
    nodeFetch(url, { ...init, agent } as any)) as any;
};

/** 为 OpenAI 兼容客户端复用同一代理构造入口。 */
export const getOpenAIProxyFetch = (proxyUrl?: string) =>
  createOpenAIProxyFetch(proxyUrl);
