import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import redisClient from '../config.js';

const PANEL_ACCESS_KEY = "ai:panel:access";
const emptyAccess = () => ({ enabled: "0", token: "" });
const normalizeAccess = (value) => {
    if (!value || typeof value !== "object")
        return emptyAccess();
    const record = value;
    const enabled = record.enabled === "1" ? "1" : "0";
    const token = String(record.token || "").trim();
    return { enabled, token };
};
const getPanelAccess = async () => {
    const raw = await redisClient.redis.get(PANEL_ACCESS_KEY);
    if (!raw)
        return emptyAccess();
    try {
        return normalizeAccess(JSON.parse(raw));
    }
    catch {
        return emptyAccess();
    }
};
const setPanelAccess = async (access) => {
    await redisClient.redis.set(PANEL_ACCESS_KEY, JSON.stringify({
        enabled: access.enabled === "1" ? "1" : "0",
        token: String(access.token || "").trim(),
    }));
};
/** 开启访问开关；无 token 时生成并复用已有 token。 */
const enablePanelAccess = async () => {
    const current = await getPanelAccess();
    const next = {
        enabled: "1",
        token: current.token || randomUUID(),
    };
    await setPanelAccess(next);
    return next;
};
/** 关闭访问开关，保留 token。 */
const disablePanelAccess = async () => {
    const current = await getPanelAccess();
    const next = {
        enabled: "0",
        token: current.token,
    };
    await setPanelAccess(next);
    return next;
};
const listPrivateIpv4 = () => {
    const result = [];
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries || []) {
            const family = entry.family;
            const isV4 = family === "IPv4" || family === 4;
            if (isV4 && !entry.internal)
                result.push(entry.address);
        }
    }
    return [...new Set(result)];
};
/** 短超时探测公网 IP；失败返回 null，不抛错。 */
const probePublicIpv4 = async (timeoutMs = 2000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch("https://api.ipify.org?format=text", {
            signal: controller.signal,
        });
        if (!response.ok)
            return null;
        const text = (await response.text()).trim();
        return text || null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
};
const buildPanelAccessUrls = (port, token, publicIp, privateIps) => {
    const path = `/${token}/panel/config`;
    const lines = [];
    if (publicIp) {
        lines.push(`公网：http://${publicIp}:${port}${path}`);
    }
    else {
        lines.push("公网：公网IP未知");
    }
    for (const ip of privateIps) {
        lines.push(`私网：http://${ip}:${port}${path}`);
    }
    lines.push(`本机：http://127.0.0.1:${port}${path}`);
    return lines;
};

export { PANEL_ACCESS_KEY, buildPanelAccessUrls, disablePanelAccess, enablePanelAccess, getPanelAccess, listPrivateIpv4, probePublicIpv4, setPanelAccess };
