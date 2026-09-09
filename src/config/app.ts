import { getConfigValue } from "alemonjs";

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const mergeConfig = (
  legacy: Record<string, any>,
  current: Record<string, any>,
): Record<string, any> => {
  const merged = { ...legacy };

  for (const [key, value] of Object.entries(current)) {
    merged[key] =
      isRecord(merged[key]) && isRecord(value)
        ? mergeConfig(merged[key], value)
        : value;
  }

  return merged;
};

/**
 * 读取 AI Chat 配置。
 *
 * AlemonX 按当前 npm 包名写入 `alemonjs-aichat:`；旧版项目使用
 * `aichat:` / `aiChat:`。合并这些命名空间可让工作台配置生效，同时保留
 * 现有配置文件兼容性。
 */
export const getAiChatConfigValue = (): Record<string, any> => {
  const root = getConfigValue() as Record<string, any>;
  if (!isRecord(root)) return {};

  const topLevelKeys = [
    "searchApiKey",
    "ai",
    "xaiImgProxy",
    "httpProxy",
    "ttsServer",
    "baidu",
    "skills_dir",
    "opencodeServer",
    "localBrowser",
  ];
  const topLevel = Object.fromEntries(
    topLevelKeys
      .filter((key) => root[key] !== undefined)
      .map((key) => [key, root[key]]),
  );
  const legacyLowercase = isRecord(root.aichat) ? root.aichat : {};
  const legacy = isRecord(root.aiChat) ? root.aiChat : {};
  const current = isRecord(root["alemonjs-aichat"])
    ? root["alemonjs-aichat"]
    : {};

  return mergeConfig(
    mergeConfig(mergeConfig(topLevel, legacyLowercase), legacy),
    current,
  );
};

export type DeclaredAIConfig = {
  name: string;
  host: string;
  key: string;
  model: string;
};

/** 返回 AlemonX 中声明的单个 AI；配置不完整时不加入可用列表。 */
export const getDeclaredAIConfig = (): DeclaredAIConfig | null => {
  const ai = getAiChatConfigValue().ai;
  if (!isRecord(ai)) return null;

  const config = {
    name: String(ai.name || "").trim(),
    host: String(ai.host || "").trim(),
    key: String(ai.key || "").trim(),
    model: String(ai.model || "").trim(),
  };

  return Object.values(config).every(Boolean) ? config : null;
};
