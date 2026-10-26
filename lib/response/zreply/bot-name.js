/** 账号昵称读不到时使用的默认名字；模型也常沿用它们做回复前缀。 */
const DEFAULT_BOT_NAMES = ["小喵酱", "小咸鱼"];
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 当前昵称 + 默认名字（去重、长名优先），用于剔除回复前缀。 */
const botNameCandidates = (botName) => {
    const names = [String(botName || "").trim(), ...DEFAULT_BOT_NAMES].filter(Boolean);
    return [...new Set(names)].sort((a, b) => b.length - a.length);
};
/** 匹配「名字:」或「名字：」前缀（全局）。 */
const botNamePrefixRegex = (botName, flags = "g") => new RegExp(`(?:${botNameCandidates(botName).map(escapeRegExp).join("|")})\\s*[:：]`, flags);
/** 去掉开头的名字前缀。 */
const stripBotNamePrefix = (text, botName) => text.replace(new RegExp(`^\\s*${botNamePrefixRegex(botName, "").source}`), "");
/** 是否是「名字:[]」静默标记。 */
const isSilentReply = (text, botName) => stripBotNamePrefix(String(text || "").trim(), botName).trim() === "[]";

export { DEFAULT_BOT_NAMES, botNameCandidates, botNamePrefixRegex, isSilentReply, stripBotNamePrefix };
