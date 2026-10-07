/** 一分钟跟进时，把模型附在静默标记后的自言自语视为不回复。 */
const shouldSuppressFollowupReply = (reply, botName) => {
    const prefix = `${botName}:`;
    const trimmed = reply.trim();
    const body = (trimmed.startsWith(prefix)
        ? trimmed.slice(prefix.length)
        : trimmed).trim();
    if (body.startsWith("[]"))
        return true;
    // 模型有时不输出静默标记，只输出一段或多段括号中的旁白。
    return /^(?:\([^()]*\)|（[^（）]*）)(?:\s*(?:\([^()]*\)|（[^（）]*）))*$/s.test(body);
};

export { shouldSuppressFollowupReply };
