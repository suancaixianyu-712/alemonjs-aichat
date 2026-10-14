/** 群聊里只 @ 机器人、没有任何内容时静默跳过（capi/res 共用） */
const MEDIA_SEGMENT = /\[CQ:(image|file|record|video|reply|forward|json|xml|mface|marketface)\b/i;
const IGNORED_SEGMENT = /\[CQ:(at|face)\b[^\]]*\]/gi;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu;
const isPrivateEvent = (e) => e?.name === "private.message.create" || e?.Name === "private.message.create";
/** 去掉 @、表情和空白后是否没有文字、图片、文件，且不是引用回复 */
const isEmptyAtBotMessage = (e) => {
    if (!e || isPrivateEvent(e) || !e.atBot)
        return false;
    if (e.reply)
        return false;
    if (e.tag === "NOTICE_GROUP_UPLOAD" || e.tag === "NOTICE_OFFLINE_FILE")
        return false;
    if (Array.isArray(e.MessageMedia) && e.MessageMedia.length > 0)
        return false;
    const raw = String(e.value?.raw_message || e.raw_message || "");
    if (MEDIA_SEGMENT.test(raw))
        return false;
    const botName = String(e.bot?.nickname || "").trim();
    const strip = (text) => {
        let rest = text.replace(IGNORED_SEGMENT, "");
        if (botName)
            rest = rest.split(`@${botName}`).join("");
        return rest.replace(EMOJI, "").replace(/\s+/g, "");
    };
    return strip(raw) === "" && strip(String(e.msg || "")) === "";
};

export { isEmptyAtBotMessage };
