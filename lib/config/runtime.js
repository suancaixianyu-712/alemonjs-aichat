import { getConfigValue, getConfig } from 'alemonjs';

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
/**
 * 从 package.json 的 alemonjs.config 数组读取某项的 default。
 * 与 ALemonX 的 packageschema 约定一致（字段 name/type/required/description/default）。
 */
function readDeclaredDefault(key) {
    try {
        const pkg = getConfig().package;
        const alemonjs = pkg?.alemonjs;
        const configList = alemonjs?.config;
        if (!Array.isArray(configList))
            return undefined;
        const field = configList.find((item) => item?.name === key);
        const defaultValue = field?.default;
        return typeof defaultValue === "string" ? defaultValue : undefined;
    }
    catch {
        return undefined;
    }
}
/** 从 alemon.config.yaml 读取候选命名空间下的配置值 */
function readConfigValue(key) {
    try {
        const value = getConfigValue();
        if (!value || typeof value !== "object")
            return undefined;
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
    }
    catch {
        return undefined;
    }
}
function normalizeRuntimeMode(raw) {
    return raw === "external" ? "external" : "local";
}
function normalizeTransport(raw) {
    return raw === "http" ? "http" : "websocket";
}
function resolveValue(key) {
    return readConfigValue(key) ?? readDeclaredDefault(key);
}
/**
 * 读取运行时模式。默认 "local"（插件托管）。
 */
function getRuntimeMode() {
    return normalizeRuntimeMode(resolveValue("runtime_mode"));
}
/**
 * 读取消息桥接传输方式。默认 "websocket"。
 */
function getTransport() {
    return normalizeTransport(resolveValue("transport"));
}
/**
 * 读取 GsCore HTTP 地址。默认空字符串（未启用外部托管）。
 */
function getGscoreUrl() {
    return (resolveValue("gscore_url") ?? "").trim();
}
/**
 * 一次性读取全部引擎级运行时配置。
 */
function getRuntimeConfig() {
    return {
        runtime_mode: getRuntimeMode(),
        transport: getTransport(),
        gscore_url: getGscoreUrl(),
    };
}

export { getGscoreUrl, getRuntimeConfig, getRuntimeMode, getTransport };
