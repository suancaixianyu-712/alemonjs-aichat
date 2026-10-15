/** 深度思考 / reasoning effort 档位（rapi 透传；capi/doubao 只用 on/off） */

export const DEEP_THOUGHT_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type DeepThoughtEffort = (typeof DEEP_THOUGHT_EFFORTS)[number];

export const DEEP_THOUGHT_EFFORT_KEY_PREFIX = "ai:deep_thought:effort:";
export const DEEP_THOUGHT_SWITCH_KEY_PREFIX = "ai:deep_thought:switch:";

const EFFORT_SET = new Set<string>(DEEP_THOUGHT_EFFORTS);

export const isDeepThoughtEffort = (value: unknown): value is DeepThoughtEffort =>
  typeof value === "string" && EFFORT_SET.has(value.trim().toLowerCase());

/** 非法值回落为 none（不自动降级到其它合法档位） */
export const normalizeDeepThoughtEffort = (
  value: unknown,
): DeepThoughtEffort => {
  if (typeof value !== "string") return "none";
  const v = value.trim().toLowerCase();
  return EFFORT_SET.has(v) ? (v as DeepThoughtEffort) : "none";
};

/** 仅有旧 switch、没有 effort 时：1→medium，0/缺省→none */
export const migrateEffortFromSwitch = (
  switchValue: string | null | undefined,
): DeepThoughtEffort => (switchValue === "1" ? "medium" : "none");

/**
 * 读取优先级：合法 effort → 否则按旧 switch 迁移解释。
 * 不写回 Redis（写回由 set 负责）。
 */
export const resolveDeepThoughtEffort = (input: {
  effort?: string | null;
  switchValue?: string | null;
}): DeepThoughtEffort => {
  if (input.effort != null && String(input.effort).trim() !== "") {
    const raw = String(input.effort).trim().toLowerCase();
    if (EFFORT_SET.has(raw)) return raw as DeepThoughtEffort;
  }
  return migrateEffortFromSwitch(input.switchValue);
};

export const effortToSwitch = (effort: DeepThoughtEffort): "0" | "1" =>
  effort === "none" ? "0" : "1";

/** #AI配置 展示：关闭 或档位名 */
export const formatDeepThoughtDisplay = (effort: DeepThoughtEffort): string =>
  effort === "none" ? "关闭" : effort;

export const listDeepThoughtEffortsText = (): string =>
  DEEP_THOUGHT_EFFORTS.join(" | ");

/**
 * 按 apiMode + 模型拼 reasoning / thinking 参数。
 * - rapi：openai/deepseek/qwen 透传 effort；doubao 仅 on/off；未知模型不传
 * - capi：仅 on/off；需要 effort 字符串的厂商固定 medium，不把 xhigh/max 传给 capi
 */
export const getDeepThoughtReasoning = (cfg: {
  deepThoughtEffort?: string;
  deepThoughtSwitch?: string;
  config?: { model?: string; apiMode?: string };
}) => {
  const model = String(cfg?.config?.model || "").toLowerCase();
  const effort = resolveDeepThoughtEffort({
    effort: cfg.deepThoughtEffort,
    switchValue: cfg.deepThoughtSwitch,
  });
  const enabled = effort !== "none";
  const apiMode = cfg?.config?.apiMode === "rapi" ? "rapi" : "capi";
  const isOpenAIReasoningModel =
    model.startsWith("gpt-5") ||
    model.startsWith("gpt-6") ||
    /^o\d/.test(model);

  if (apiMode === "rapi") {
    // 火山方舟 Responses API 使用自己的 thinking 开关。
    if (model.includes("doubao")) {
      return {
        thinking: { type: enabled ? "enabled" : "disabled" },
      };
    }

    // OpenAI、DeepSeek 和 Qwen 的 Responses API 均使用 reasoning.effort。
    if (
      model.includes("deepseek") ||
      model.includes("qwen") ||
      isOpenAIReasoningModel
    ) {
      return {
        reasoning: { effort },
      };
    }
    return {};
  }

  // Chat Completions API：只表达 on/off；需要 effort 字段时固定 medium。
  const capiEffort = enabled ? "medium" : "none";

  if (model.includes("deepseek")) {
    return enabled
      ? {
          thinking: { type: "enabled" },
          reasoning_effort: "medium",
        }
      : {
          thinking: { type: "disabled" },
        };
  }
  if (model.includes("doubao")) {
    return enabled
      ? {
          thinking: { type: "enabled" },
          reasoning_effort: "medium",
        }
      : {
          thinking: { type: "disabled" },
        };
  }
  if (model.includes("qwen")) {
    return {
      enable_thinking: enabled,
    };
  }
  if (isOpenAIReasoningModel) {
    return {
      reasoning_effort: capiEffort,
    };
  }
  return {};
};
