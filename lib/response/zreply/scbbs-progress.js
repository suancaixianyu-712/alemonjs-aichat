const createScbbsProgress = (event, loadAPI = () => import('@alemonjs/scbbs')) => {
    let api;
    let handle;
    let disabled = false;
    return {
        async append(summary) {
            if (event.Platform !== "scbbs" || disabled)
                return false;
            if (!summary.trim())
                return true;
            try {
                api ??= await loadAPI();
                const step = { type: "thought_summary", summary };
                if (handle) {
                    await api.updateAIProgressMessage({ ...handle, appendStep: step });
                }
                else {
                    const scope = event.name === "private.message.create" ? "private" : "group";
                    const result = await api.startAIProgressMessage({
                        scope,
                        targetId: (scope === "private"
                            ? event.UserId
                            : (event.ChannelId ?? event.GuildId)) ?? "",
                        steps: [step],
                    });
                    handle = { scope: result.scope, messageId: result.messageId };
                }
                return true;
            }
            catch (error) {
                disabled = true;
                console.error("发送 scbbs AI 进度失败，回退普通消息", error);
                return false;
            }
        },
        async finish(status) {
            if (!api || !handle)
                return;
            try {
                await api.updateAIProgressMessage({ ...handle, status });
            }
            catch (error) {
                console.error("更新 scbbs AI 进度状态失败", error);
            }
        },
    };
};

export { createScbbsProgress };
