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
        };
    }
    catch {
        return null;
    }
};

export { parseOwnedAIToolLoopState };
