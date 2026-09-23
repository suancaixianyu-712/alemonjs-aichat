import nodeFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * 为 OpenAI SDK 创建直连 HTTP(S) 代理的 fetch。
 * 请求仍使用真实 API 地址，仅网络传输经过本地代理，不需要额外转发服务。
 */
const createOpenAIProxyFetch = (proxyUrl) => {
    const normalized = String(proxyUrl || "").trim();
    if (!normalized)
        return undefined;
    const agent = new HttpsProxyAgent(normalized);
    return ((url, init = {}) => nodeFetch(url, { ...init, agent }));
};
/**
 * 为 OpenAI 兼容客户端复用同一代理构造入口。
 * enabled 来自单个 AI 配置的 useProxy，未开启时直连。
 */
const getOpenAIProxyFetch = (proxyUrl, enabled = false) => {
    if (!enabled)
        return undefined;
    return createOpenAIProxyFetch(proxyUrl);
};

export { createOpenAIProxyFetch, getOpenAIProxyFetch };
