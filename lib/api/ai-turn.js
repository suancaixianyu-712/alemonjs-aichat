const activeAITurns = new Set();
const beginAITurn = (guid, platform, userID) => {
    const record = {
        id: Symbol("ai-turn"),
        guid,
        platform,
        userID,
        controller: new AbortController(),
    };
    activeAITurns.add(record);
    return {
        signal: record.controller.signal,
        finish: () => activeAITurns.delete(record),
    };
};
const abortAITurns = (options) => {
    let aborted = 0;
    for (const turn of activeAITurns) {
        if (turn.guid !== options.guid)
            continue;
        if (options.platform && turn.platform !== options.platform)
            continue;
        if (turn.userID !== options.userID)
            continue;
        if (turn.controller.signal.aborted)
            continue;
        turn.controller.abort(new Error("当前 AI 回复已被用户停止"));
        aborted += 1;
    }
    return { aborted };
};
const throwIfAITurnAborted = (signal) => {
    if (!signal.aborted)
        return;
    const error = signal.reason || new Error("当前 AI 回复已被用户停止");
    error.aiTurnAborted = true;
    throw error;
};
const awaitWithAITurnAbort = async (task, signal) => {
    throwIfAITurnAborted(signal);
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => {
            try {
                throwIfAITurnAborted(signal);
            }
            catch (error) {
                reject(error);
            }
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([task, aborted]);
    }
    finally {
        if (onAbort)
            signal.removeEventListener("abort", onAbort);
    }
};
const isAITurnAbortError = (error, signal) => signal.aborted === true || error?.aiTurnAborted === true;

export { abortAITurns, awaitWithAITurnAbort, beginAITurn, isAITurnAbortError, throwIfAITurnAborted };
