import { getOpenAIProxyFetch } from "./openaiProxy";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DISPLAY_LIMIT = 40;

/** OpenAI 列表里常见非对话模型，与 add-ai 过滤规则一致 */
const OPENAI_NON_CHAT_KEYWORDS = [
  "embedding",
  "moderation",
  "whisper",
  "transcribe",
  "tts",
  "realtime",
  "audio",
  "image",
  "dall-e",
  "sora",
  "babbage",
  "davinci",
];

export const isOpenAIChatModel = (model: string) => {
  const id = model.toLowerCase();
  return !OPENAI_NON_CHAT_KEYWORDS.some((value) => id.includes(value));
};

/**
 * 规范化 API host：去掉尾部 `/`；若已以 `/v1` 结尾则不再追加 `/v1`。
 * modelsPath 默认 `/models`；grok 预设可用 `/language-models`。
 */
export const resolveModelsUrl = (
  host: string,
  options?: { provider?: string; modelsPath?: string },
): string => {
  const base = String(host || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return "";

  let path =
    options?.modelsPath != null
      ? String(options.modelsPath)
      : options?.provider === "grok"
        ? "/language-models"
        : "/models";
  path = path.trim();
  if (!path) return base;
  if (!path.startsWith("/")) path = `/${path}`;

  // host 已带路径时避免重复拼接（如 host 已是 .../v1/models）
  if (base.endsWith(path)) return base;

  return `${base}${path}`;
};

export type FetchProviderModelsOptions = {
  host: string;
  key: string;
  provider?: string;
  /** 覆盖默认 models 路径；add-ai 预设可传入 PROVIDERS[].modelsPath */
  modelsPath?: string;
  httpProxy?: string;
  useProxy?: boolean;
  timeoutMs?: number;
  /** 传入自定义 fetch（测试用） */
  fetchImpl?: typeof fetch;
};

/**
 * 向 OpenAI 兼容 /models（或厂商 modelsPath）拉取模型 id 列表。
 * 失败抛错；空列表返回 []。
 */
export const fetchProviderModels = async (
  options: FetchProviderModelsOptions,
): Promise<string[]> => {
  const url = resolveModelsUrl(options.host, {
    provider: options.provider,
    modelsPath: options.modelsPath,
  });
  const key = String(options.key || "").trim();
  if (!url || !key) {
    throw new Error("missing host or key");
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestFetch =
      options.fetchImpl ||
      getOpenAIProxyFetch(options.httpProxy, options.useProxy === true) ||
      fetch;
    const response = await requestFetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown }>;
      models?: Array<{ id?: unknown }>;
    };
    const provider = String(options.provider || "").toLowerCase();
    const source = provider === "grok" ? body.models : body.data;
    const models = (Array.isArray(source) ? source : [])
      .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
      .filter(Boolean)
      .filter((model) => provider !== "openai" || isOpenAIChatModel(model));
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timeout);
  }
};

/** 格式化展示：按字母序已排好；超过 limit 截断并注明总数 */
export const formatModelListMessage = (
  models: string[],
  options?: { limit?: number; title?: string },
): string => {
  const limit = options?.limit ?? DEFAULT_DISPLAY_LIMIT;
  const title = options?.title ?? "可用模型";
  const total = models.length;
  if (total === 0) return "";

  const shown = models.slice(0, limit);
  const lines = [
    `${title}：`,
    ...shown.map((model, index) => `${index + 1}. ${model}`),
  ];
  if (total > limit) {
    lines.push("", `共 ${total} 个，已显示前 ${limit} 个`);
  }
  return lines.join("\n");
};

export const MODEL_LIST_FAIL_TEXT = "获取模型列表失败";
export const MODEL_LIST_DISPLAY_LIMIT = DEFAULT_DISPLAY_LIMIT;
