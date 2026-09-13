type ProgressAPI = Pick<
  typeof import("@alemonjs/scbbs"),
  "startAIProgressMessage" | "updateAIProgressMessage"
>;
type ProgressStatus = "completed" | "failed" | "interrupted";

export const createScbbsProgress = (
  event: {
    Platform?: string;
    name?: string;
    UserId?: string;
    ChannelId?: string;
    GuildId?: string;
  },
  loadAPI: () => Promise<ProgressAPI> = () => import("@alemonjs/scbbs"),
) => {
  let api: ProgressAPI | undefined;
  let handle: { scope: "private" | "group"; messageId: number } | undefined;
  let disabled = false;

  return {
    async append(summary: string): Promise<boolean> {
      if (event.Platform !== "scbbs" || disabled) return false;
      if (!summary.trim()) return true;
      try {
        api ??= await loadAPI();
        const step = { type: "thought_summary" as const, summary };
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
