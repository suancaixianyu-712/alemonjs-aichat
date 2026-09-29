export type AIToolLoopState = {
  processing: true;
  ownerId: string;
  userID: string;
  startedAt: number;
  updatedAt: number;
  /** Currently executing tools; last entry is the innermost. */
  toolStack: string[];
};

const normalizeToolStack = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((name) => String(name || "").trim()).filter(Boolean);
};

/** Innermost currently executing tool name, or empty when idle. */
export const getAIToolLoopCurrentTool = (
  state: AIToolLoopState | null | undefined,
): string => {
  const stack = state?.toolStack;
  if (!Array.isArray(stack) || stack.length === 0) return "";
  return String(stack[stack.length - 1] || "");
};

/** 只恢复本进程创建且仍未过期的工具调用锁。 */
export const parseOwnedAIToolLoopState = (
  serialized: string,
  ownerId: string,
  staleMs: number,
  now = Date.now(),
): AIToolLoopState | null => {
  if (serialized === "1") return null;

  try {
    const parsed = JSON.parse(serialized);
    if (parsed?.processing !== true || parsed.ownerId !== ownerId) return null;
    const updatedAt = Number(parsed.updatedAt || parsed.startedAt || 0);
    if (!updatedAt || now - updatedAt > staleMs) return null;
    return {
      processing: true,
      ownerId,
      userID: String(parsed.userID || ""),
      startedAt: Number(parsed.startedAt || updatedAt),
      updatedAt,
      toolStack: normalizeToolStack(parsed.toolStack),
    };
  } catch {
    return null;
  }
};
