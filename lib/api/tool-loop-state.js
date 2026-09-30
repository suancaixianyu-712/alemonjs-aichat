const normalizeToolStack = (value) => {
    if (!Array.isArray(value))
        return [];
    return value.map((name) => String(name || "").trim()).filter(Boolean);
};
/** Innermost currently executing tool name, or empty when idle. */
const getAIToolLoopCurrentTool = (state) => {
    const stack = state?.toolStack;
    if (!Array.isArray(stack) || stack.length === 0)
        return "";
    return String(stack[stack.length - 1] || "");
};
/** 只恢复本进程创建且仍未过期的工具调用锁。 */
const parseOwnedAIToolLoopState = (serialized, ownerId, staleMs, now = Date.now()) => {
    if (serialized === "1")
        return null;
    try {
        const parsed = JSON.parse(serialized);
        if (parsed?.processing !== true || parsed.ownerId !== ownerId)
            return null;
        const updatedAt = Number(parsed.updatedAt || parsed.startedAt || 0);
        if (!updatedAt || now - updatedAt > staleMs)
            return null;
        return {
            processing: true,
            ownerId,
            userID: String(parsed.userID || ""),
            startedAt: Number(parsed.startedAt || updatedAt),
            updatedAt,
            toolStack: normalizeToolStack(parsed.toolStack),
        };
    }
    catch {
        return null;
    }
};

export { getAIToolLoopCurrentTool, parseOwnedAIToolLoopState };
