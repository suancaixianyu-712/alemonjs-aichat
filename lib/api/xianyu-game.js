import { Expose } from 'alemonjs';

const XIANYU_GAME_PROTOCOL = "xianyu-game-v1";
const pendingTurnTokens = new Map();
const getXianyuProvider = () => Expose.create().list(XIANYU_GAME_PROTOCOL).at(0) ?? null;
const setPendingXianyuGameTurn = (guid, token) => {
    pendingTurnTokens.set(guid, token);
};
const clearPendingXianyuGameTurn = (guid, token) => {
    if (!token || pendingTurnTokens.get(guid) === token) {
        pendingTurnTokens.delete(guid);
    }
};
const readSessionText = (value) => {
    const text = String(value ?? "").trim();
    return text || undefined;
};
/**
 * 从真实会话事件构造扫雷作用域。只能由宿主调用，结果会被覆盖式写入工具参数。
 * 缺失的字段不会写入，避免把 undefined 透传给插件。
 */
const buildXianyuGameSession = (event) => {
    const source = (event ?? {});
    const name = readSessionText(source.name);
    const isPrivateEvent = name === undefined || name === "private.message.create";
    const session = {
        IsPrivate: source.IsPrivate === true ? true : isPrivateEvent,
    };
    const guid = readSessionText(source.guid);
    if (guid)
        session.guid = guid;
    const userId = readSessionText(source.UserId);
    if (userId)
        session.UserId = userId;
    const channelId = readSessionText(source.ChannelId);
    if (channelId)
        session.ChannelId = channelId;
    const guildId = readSessionText(source.GuildId);
    if (guildId)
        session.GuildId = guildId;
    const spaceId = readSessionText(source.SpaceId);
    if (spaceId)
        session.SpaceId = spaceId;
    return session;
};
const getXianyuGameStatus = async (guid) => {
    const provider = getXianyuProvider();
    if (!provider) {
        return {
            ok: false,
            available: false,
            error: "未检测到已加载的咸鱼游戏插件",
            games: [],
        };
    }
    try {
        const status = await provider.invoke("status", { guid });
        return { ok: true, available: true, ...status };
    }
    catch (error) {
        return {
            ok: false,
            available: false,
            error: error?.message || "读取咸鱼游戏插件状态失败",
            games: [],
        };
    }
};
const useXianyuGameTool = async (input) => {
    const action = input.action || "status";
    const provider = getXianyuProvider();
    if (!provider) {
        return {
            ok: false,
            error: "未检测到已加载的咸鱼游戏插件。请确认 al... host 同时安装了 xianyu-plugin。",
        };
    }
    const guid = String(input.guid ?? "").trim();
    const session = input.session
        ? { ...input.session, guid: guid || input.session.guid }
        : guid
            ? { guid }
            : undefined;
    try {
        if (action === "status") {
            return { ok: true, result: await provider.invoke("status", { guid }) };
        }
        if (!guid) {
            return { ok: false, error: "当前会话缺少 guid" };
        }
        if (action === "gobang_snapshot") {
            return {
                ok: true,
                result: await provider.invoke("gobangSnapshot", { guid }),
            };
        }
        if (action === "gobang_move") {
            const token = pendingTurnTokens.get(guid);
            if (!token) {
                return {
                    ok: false,
                    error: "当前没有由系统派发的咸鱼五子棋 AI 回合，不能落子。",
                };
            }
            const result = await provider.invoke("gobangMove", {
                guid,
                // 对模型暴露 x/y，插件内部仍以 row/col 存储二维棋盘。
                row: input.y,
                col: input.x,
                token,
            });
            return result && typeof result === "object"
                ? result
                : { ok: true, result };
        }
        if (action === "minesweeper_snapshot") {
            return {
                ok: true,
                result: await provider.invoke("minesweeperSnapshot", { guid }),
            };
        }
        if (action === "minesweeper_start") {
            const result = await provider.invoke("minesweeperStart", {
                guid,
                difficulty: input.difficulty,
                session,
            });
            if (!result || typeof result !== "object") {
                return { ok: false, error: "咸鱼插件未能开始扫雷" };
            }
            // 棋盘图片只发到会话里，不回灌模型上下文，避免 base64 撑爆 token。
            const { progressMedia, ...safeResult } = result;
            if (progressMedia?.summary && input.progressReporter) {
                await input.progressReporter(progressMedia);
            }
            return safeResult;
        }
        if (action === "minesweeper_exit") {
            return provider.invoke("minesweeperExit", { guid, session });
        }
        if (action === "minesweeper_open" ||
            action === "minesweeper_mark" ||
            action === "minesweeper_unmark") {
            const result = await provider.invoke("minesweeperAction", {
                guid,
                operation: action.replace("minesweeper_", ""),
                cells: input.cells,
            });
            if (!result || typeof result !== "object")
                return result;
            const { progressMedia, ...safeResult } = result;
            if (progressMedia?.summary && input.progressReporter) {
                await input.progressReporter(progressMedia);
            }
            return safeResult;
        }
        return { ok: false, error: "不支持的咸鱼游戏操作" };
    }
    catch (error) {
        return { ok: false, error: error?.message || "咸鱼游戏工具调用失败" };
    }
};

export { XIANYU_GAME_PROTOCOL, buildXianyuGameSession, clearPendingXianyuGameTurn, getXianyuGameStatus, setPendingXianyuGameTurn, useXianyuGameTool };
