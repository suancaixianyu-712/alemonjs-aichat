import { Expose } from 'alemonjs';
import redisClient from '../config.js';
import { toolSessionController } from './tool-session-controller.js';
import { CApiReply } from '../response/zreply/capi.js';
import { setPendingXianyuGameTurn, clearPendingXianyuGameTurn } from './xianyu-game.js';

const XIANYU_GAME_AGENT_PROTOCOL = "xianyu-game-agent-v1";
const XIANYU_GAME_AGENT_ID = "aichat";
const XIANYU_GAME_TOOL_NAME = "XianyuGame";
const getAvailability = async (guid) => {
    const safeGuid = String(guid ?? "").trim();
    if (!safeGuid)
        return { ready: false, reason: "缺少当前会话 guid" };
    if ((await toolSessionController.getCurrentTool(safeGuid)) !== "default") {
        return { ready: false, reason: "当前会话未使用默认工具" };
    }
    if ((await redisClient.getToolSwitch(safeGuid)) !== "1") {
        return { ready: false, reason: "当前会话已关闭工具调用" };
    }
    if ((await redisClient.getToolStatus(safeGuid, XIANYU_GAME_TOOL_NAME)) === "1") {
        return { ready: false, reason: "XianyuGame 工具已被禁用" };
    }
    const config = await redisClient.getAIConfig(safeGuid);
    if (!config.host.trim() || !config.key.trim() || !config.model.trim()) {
        return { ready: false, reason: "当前会话没有可用的 AI 配置" };
    }
    return { ready: true };
};
const createGameOutput = () => {
    const output = [];
    return {
        output,
        message: {
            send: async () => [],
            sendText: async (text) => {
                output.push(text);
                return [];
            },
            sendAIReply: async (reply) => {
                output.push(JSON.stringify(reply));
                return true;
            },
            sendToolResult: async () => undefined,
            delete: async () => undefined,
        },
    };
};
const runGobangTurn = async (input) => {
    const guid = String(input?.guid ?? "").trim();
    const token = String(input?.token ?? "").trim();
    if (input?.game !== "gobang" || !guid || !token) {
        return { ok: false, error: "无效的咸鱼五子棋 AI 回合" };
    }
    const availability = await getAvailability(guid);
    if (!availability.ready)
        return { ok: false, ...availability };
    setPendingXianyuGameTurn(guid, token);
    const { message, output } = createGameOutput();
    const snapshot = input.snapshot || {};
    const event = {
        name: "private.message.create",
        guid,
        Platform: "xianyu-game",
        IsPrivate: true,
        UserId: "__xianyu_game_turn__",
        UserName: "咸鱼游戏系统",
        GroupName: "咸鱼五子棋",
        bot: { user_id: "__aichat_game_agent__", nickname: "Aichat" },
        atBot: true,
        regexTriggered: true,
        MessageMedia: [],
        __allowedToolNames: ["getSKILLDetail", "XianyuGame"],
        msg: [
            "【系统任务：咸鱼五子棋 AI 回合】",
            "这是 Aichat 执白棋的正式回合，不是普通聊天。",
            "必须先调用 getSKILLDetail 获取 xianyu-gobang 技能并严格执行；随后调用 XianyuGame 的 gobang_snapshot 读取当前棋盘，再调用 gobang_move 选择一个空位落子。",
            "坐标统一为 x y：x 是从左到右的横坐标，y 是从上到下的纵坐标，均从 1 开始。棋盘数组用 board[y-1][x-1] 读取。调用 gobang_move 时必须传 x 和 y，绝不能交换。",
            "快照的 tactics 是咸鱼插件根据真实全局棋盘计算的战术提示：白棋有必胜点应优先赢；否则黑棋有下一手必胜点应优先从 priorityMoves 封堵。它不会替你强制选择落点，最终决策仍由你作出。",
            "若没有强制点，优先采用 tactics.recommendedMoves 中最高分的候选；这是咸鱼内置 AI 已验证的攻防评分结果。",
            "不要调用其他工具；落子成功后只给出简短确认。",
            `当前推送状态：${JSON.stringify(snapshot)}`,
        ].join("\n"),
        value: { raw_message: "咸鱼五子棋 AI 回合" },
    };
    try {
        const result = await CApiReply(event, message);
        return { ok: !result?.busy, busy: Boolean(result?.busy), output };
    }
    catch (error) {
        return { ok: false, error: error?.message || "Aichat 五子棋回合执行失败", output };
    }
    finally {
        clearPendingXianyuGameTurn(guid, token);
    }
};
const xianyuGameAgentExpose = Expose.create().provide({
    name: XIANYU_GAME_AGENT_PROTOCOL,
    description: "Aichat 自动订阅咸鱼游戏服务，在默认工具模式下接管 AI 对手回合。",
    actions: {
        describe: {
            description: "返回 Aichat 的订阅状态和支持的游戏。",
            handler: async (input = {}) => {
                const availability = await getAvailability(input.guid);
                return {
                    id: XIANYU_GAME_AGENT_ID,
                    name: "Aichat",
                    games: ["gobang"],
                    ...availability,
                };
            },
        },
        takeTurn: {
            description: "接收咸鱼游戏服务推送的 AI 回合，并通过默认 AITools 完成落子。",
            handler: runGobangTurn,
        },
    },
});

export { XIANYU_GAME_AGENT_ID, XIANYU_GAME_AGENT_PROTOCOL, xianyuGameAgentExpose };
