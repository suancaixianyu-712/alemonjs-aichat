type AITurnRecord = {
  id: symbol;
  guid: string;
  platform?: string;
  controller: AbortController;
};

const activeAITurns = new Set<AITurnRecord>();

export const beginAITurn = (guid: string, platform?: string) => {
  const record: AITurnRecord = {
    id: Symbol("ai-turn"),
    guid,
    platform,
    controller: new AbortController(),
  };
  activeAITurns.add(record);

  return {
    signal: record.controller.signal,
    finish: () => activeAITurns.delete(record),
  };
};

export const abortAITurns = (options: {
  guid: string;
  platform?: string;
}): { aborted: number } => {
  let aborted = 0;

  for (const turn of activeAITurns) {
    if (turn.guid !== options.guid) continue;
    if (options.platform && turn.platform !== options.platform) continue;
    if (turn.controller.signal.aborted) continue;

    turn.controller.abort(new Error("当前 AI 回复已被用户停止"));
    aborted += 1;
  }

  return { aborted };
};

export const throwIfAITurnAborted = (signal: AbortSignal) => {
  if (!signal.aborted) return;

  const error: any = signal.reason || new Error("当前 AI 回复已被用户停止");
  error.aiTurnAborted = true;
  throw error;
};

export const awaitWithAITurnAbort = async <T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  throwIfAITurnAborted(signal);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      try {
        throwIfAITurnAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([task, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

export const isAITurnAbortError = (error: any, signal: AbortSignal) =>
  signal.aborted === true || error?.aiTurnAborted === true;
