type ProgressAPI = Pick<
  typeof import("@alemonjs/scbbs"),
  "startAIProgressMessage" | "updateAIProgressMessage"
>;
type ProgressStatus = "completed" | "failed" | "interrupted";
type ProgressStepType =
  "status" | "tool" | "command" | "result" | "thought_summary";

type ProgressEvent = {
  Platform?: string;
  name?: string;
  UserId?: string;
  ChannelId?: string;
  GuildId?: string;
};

type ClientRuntime = Pick<
  typeof import("alemonjs"),
  "ResultCode" | "useClient"
>;

export const createActiveProgressAPI = (
  event: ProgressEvent,
  { ResultCode, useClient }: ClientRuntime,
): ProgressAPI => {
  const [client] = useClient<any>(event as any);
  const call = async <T>(
    action: "startAIProgressMessage" | "updateAIProgressMessage",
    options: unknown,
  ): Promise<T> => {
    const results = await client[action](options);
    const result = Array.isArray(results)
      ? results.find((item) => item?.code === ResultCode.Ok)
      : undefined;
    if (!result?.data) {
      const message = Array.isArray(results)
        ? results.find((item) => item?.message)?.message
        : undefined;
      throw new Error(message || `SCBBS ${action} 调用失败`);
    }
    return result.data as T;
  };

  return {
    startAIProgressMessage: (options) =>
      call<Awaited<ReturnType<ProgressAPI["startAIProgressMessage"]>>>(
        "startAIProgressMessage",
        options,
      ),
    updateAIProgressMessage: (options) =>
      call<Awaited<ReturnType<ProgressAPI["updateAIProgressMessage"]>>>(
        "updateAIProgressMessage",
        options,
      ),
  };
};

const loadActiveProgressAPI = async (
  event: ProgressEvent,
): Promise<ProgressAPI> =>
  createActiveProgressAPI(event, await import("alemonjs"));

export const createScbbsProgress = (
  event: ProgressEvent,
  loadAPI: (
    event: ProgressEvent,
  ) => Promise<ProgressAPI> = loadActiveProgressAPI,
) => {
  let api: ProgressAPI | undefined;
  let handle: { scope: "private" | "group"; messageId: number } | undefined;
  let disabled = false;

  return {
    async append(
      summary: string,
      type: ProgressStepType = "thought_summary",
    ): Promise<boolean> {
      if (event.Platform !== "scbbs" || disabled) return false;
      if (!summary.trim()) return true;
      try {
        api ??= await loadAPI(event);
        const step = { type, summary };
        if (handle) {
          await api.updateAIProgressMessage({ ...handle, appendStep: step });
        } else {
          const scope =
            event.name === "private.message.create" ? "private" : "group";
          const result = await api.startAIProgressMessage({
            scope,
            targetId:
              (scope === "private"
                ? event.UserId
                : (event.ChannelId ?? event.GuildId)) ?? "",
            steps: [step],
          });
          handle = { scope: result.scope, messageId: result.messageId };
        }
        return true;
      } catch (error) {
        disabled = true;
        console.error("发送 scbbs AI 进度失败，回退普通消息", error);
        return false;
      }
    },
    async appendImage(
      summary: string,
      image: string | Buffer | ArrayBuffer | NodeJS.ArrayBufferView,
    ): Promise<boolean> {
      if (event.Platform !== "scbbs" || disabled) return false;
      if (!summary.trim()) return true;
      try {
        api ??= await loadAPI(event);
        const step = { type: "result" as const, summary };
        if (handle) {
          await api.updateAIProgressMessage({
            ...handle,
            appendStep: step,
            stepImage: image,
          });
        } else {
          const scope =
            event.name === "private.message.create" ? "private" : "group";
          const result = await api.startAIProgressMessage({
            scope,
            targetId:
              (scope === "private"
                ? event.UserId
                : (event.ChannelId ?? event.GuildId)) ?? "",
            steps: [step],
            stepImage: image,
          });
          handle = { scope: result.scope, messageId: result.messageId };
        }
        return true;
      } catch (error) {
        disabled = true;
        console.error("发送 scbbs AI 进度图片失败，回退普通消息", error);
        return false;
      }
    },
    async finish(status: ProgressStatus) {
      if (!api || !handle) return;
      try {
        await api.updateAIProgressMessage({ ...handle, status });
      } catch (error) {
        console.error("更新 scbbs AI 进度状态失败", error);
      }
    },
  };
};
