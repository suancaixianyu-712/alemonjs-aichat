import type { AIConfig } from "@src/types";

export type BuiltinToolName =
  | "web_search"
  | "web_extractor"
  | "x_search";

export const BUILTIN_TOOL_LABELS: Record<BuiltinToolName, string> = {
  web_search: "网页搜索",
  web_extractor: "网页提取",
  x_search: "X 搜索",
};

const TOOL_ALIASES: Record<string, BuiltinToolName> = {
  网页搜索: "web_search",
  联网搜索: "web_search",
  搜索: "web_search",
  websearch: "web_search",
  web_search: "web_search",
  网页提取: "web_extractor",
  网页解析: "web_extractor",
  webextractor: "web_extractor",
  web_extractor: "web_extractor",
  x搜索: "x_search",
  推特搜索: "x_search",
  xsearch: "x_search",
  x_search: "x_search",
};

export const resolveBuiltinToolName = (
  value: string,
): BuiltinToolName | null => {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  return TOOL_ALIASES[normalized] ?? null;
};

export const isBuiltinToolEnabled = (
  config: AIConfig,
  tool: BuiltinToolName,
) => {
  const override = config.builtinTools?.overrides?.[tool];
  if (typeof override === "boolean") return override;
  return config.builtinTools?.enabled !== false;
};

export type NativeProvider =
  | "openai"
  | "deepseek"
  | "qwen"
  | "doubao"
  | "grok"
  | "unknown";

export const detectNativeProvider = (config: AIConfig): NativeProvider => {
  const model = String(config.model || "").toLowerCase();
  const host = String(config.host || "").toLowerCase();
  // 内置工具由实际 API 平台提供，因此主机特征优先于模型名称。
  if (host.includes("dashscope") || host.includes("aliyuncs.com")) {
    return "qwen";
  }
  if (host.includes("volces.com") || host.includes("volcengine.com")) {
    return "doubao";
  }
  if (host.includes("api.x.ai")) return "grok";
  if (host.includes("api.openai.com")) return "openai";
  if (host.includes("deepseek")) return "deepseek";
  if (
    config.provider === "deepseek" ||
    model.includes("deepseek")
  ) {
    return "deepseek";
  }
  if (model.includes("qwen") || model.includes("qwq")) {
    return "qwen";
  }
  if (
    model.includes("doubao") ||
    model.includes("seed-")
  ) {
    return "doubao";
  }
  if (
    config.provider === "grok" ||
    model.includes("grok")
  ) {
    return "grok";
  }
  if (
    config.provider === "openai"
  ) {
    return "openai";
  }
  return "unknown";
};

export const getSupportedBuiltinTools = (
  config: AIConfig,
): BuiltinToolName[] => {
  switch (detectNativeProvider(config)) {
    case "qwen":
      return config.apiMode === "rapi"
        ? ["web_search", "web_extractor"]
        : ["web_search"];
    case "grok":
      return config.apiMode === "rapi"
        ? ["web_search", "x_search"]
        : [];
    case "openai":
    case "deepseek":
    case "doubao":
      return config.apiMode === "rapi" ? ["web_search"] : [];
    default:
      return [];
  }
};

/** 生成厂商原生参数；本地 Function tools 仍由原有工具开关独立控制。 */
export const getProviderBuiltinToolParams = (config: AIConfig) => {
  const provider = detectNativeProvider(config);
  const supported = getSupportedBuiltinTools(config);
  let enabled = supported.filter((tool) =>
    isBuiltinToolEnabled(config, tool),
  );
  // Qwen 的网页提取依赖网页搜索；关闭搜索时同时视为不可用。
  if (!enabled.includes("web_search")) {
    enabled = enabled.filter((tool) => tool !== "web_extractor");
  }

  if (config.apiMode === "rapi") {
    const tools = enabled.flatMap((tool) => {
      return [{ type: tool }];
    });
    const include =
      enabled.includes("web_search") &&
      (provider === "openai" || provider === "qwen" || provider === "grok")
      ? ["web_search_call.action.sources"]
      : [];
    return { provider, supported, enabled, rapiTools: tools, include };
  }

  // Qwen 的 OpenAI-compatible Chat Completions 明确使用 enable_search。
  const capiParams =
    provider === "qwen" && enabled.includes("web_search")
      ? { enable_search: true }
      : {};
  return { provider, supported, enabled, rapiTools: [], include: [], capiParams };
};
