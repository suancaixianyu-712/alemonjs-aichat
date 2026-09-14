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

type ProgressImage = string | Buffer | ArrayBuffer | NodeJS.ArrayBufferView;

const serializeProgressImage = (image: ProgressImage): string => {
  if (typeof image === "string") return image;
  if (Buffer.isBuffer(image)) {
    return `base64://${image.toString("base64")}`;
  }
  if (image instanceof ArrayBuffer) {
    return `base64://${Buffer.from(image).toString("base64")}`;
  }
  return `base64://${Buffer.from(
    image.buffer,
    image.byteOffset,
    image.byteLength,
  ).toString("base64")}`;
};

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
      image: ProgressImage,
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
            // useClient 会跨插件调用并序列化参数，Buffer 直接传递会退化为
            // { type: "Buffer", data: [...] }，统一转字符串避免适配器误判。
            stepImage: serializeProgressImage(image),
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
            stepImage: serializeProgressImage(image),
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
