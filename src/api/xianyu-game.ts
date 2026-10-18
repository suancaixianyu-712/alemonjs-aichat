import { Expose } from "alemonjs";

export const XIANYU_GAME_PROTOCOL = "xianyu-game-v1";

const otherGameActions = {
  points24_snapshot: "points24Snapshot",
  points24_start: "points24Start",
  points24_action: "points24Action",
  points24_exit: "points24Exit",
  sokoban_snapshot: "sokobanSnapshot",
  sokoban_start: "sokobanStart",
  sokoban_action: "sokobanAction",
  sokoban_exit: "sokobanExit",
  chinese_chess_snapshot: "chineseChessSnapshot",
  chinese_chess_start: "chineseChessStart",
  chinese_chess_action: "chineseChessAction",
  chinese_chess_exit: "chineseChessExit",
  animal_chess_snapshot: "animalChessSnapshot",
  animal_chess_start: "animalChessStart",
  animal_chess_action: "animalChessAction",
  animal_chess_exit: "animalChessExit",
} as const;

type GameAction =
  | "status"
  | "gobang_snapshot"
  | "gobang_move"
  | "minesweeper_start"
  | "minesweeper_exit"
  | "minesweeper_snapshot"
  | "minesweeper_open"
  | "minesweeper_mark"
  | "minesweeper_unmark"
  | keyof typeof otherGameActions;

/**
 * 由宿主从真实会话事件里提取的作用域，覆盖式注入到 XianyuGame 工具参数中。
 * 模型不能伪造它：游戏操作始终使用真实玩家作用域。
 */
export type XianyuGameSessionScope = {
  guid?: string;
  UserId?: string;
  ChannelId?: string;
  GuildId?: string;
  SpaceId?: string;
  IsPrivate?: boolean;
};

/** 扫雷难度，必须与咸鱼插件 gameLevels 的键一致。 */
export type XianyuMinesweeperLevel = "简单" | "中等" | "困难";

const pendingTurnTokens = new Map<string, string>();

const getXianyuProvider = () =>
  Expose.create().list(XIANYU_GAME_PROTOCOL).at(0) ?? null;

export const setPendingXianyuGameTurn = (guid: string, token: string) => {
  pendingTurnTokens.set(guid, token);
};

export const clearPendingXianyuGameTurn = (guid: string, token?: string) => {
  if (!token || pendingTurnTokens.get(guid) === token) {
    pendingTurnTokens.delete(guid);
  }
};

const readSessionText = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text || undefined;
};

/**
 * 从真实会话事件构造游戏作用域。只能由宿主调用，结果会被覆盖式写入工具参数。
 * 缺失的字段不会写入，避免把 undefined 透传给插件。
 */
export const buildXianyuGameSession = (
  event: unknown,
): XianyuGameSessionScope => {
  const source = (event ?? {}) as Record<string, unknown>;
  const name = readSessionText(source.name);
  const isPrivateEvent =
    name === undefined || name === "private.message.create";
  const session: XianyuGameSessionScope = {
    IsPrivate: source.IsPrivate === true ? true : isPrivateEvent,
  };
  const guid = readSessionText(source.guid);
  if (guid) session.guid = guid;
  const userId = readSessionText(source.UserId);
  if (userId) session.UserId = userId;
  const channelId = readSessionText(source.ChannelId);
  if (channelId) session.ChannelId = channelId;
  const guildId = readSessionText(source.GuildId);
  if (guildId) session.GuildId = guildId;
  const spaceId = readSessionText(source.SpaceId);
  if (spaceId) session.SpaceId = spaceId;
  return session;
};

export const getXianyuGameStatus = async (guid?: string) => {
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
    return { ok: true, available: true, ...(status as Record<string, unknown>) };
  } catch (error: any) {
    return {
      ok: false,
      available: false,
      error: error?.message || "读取咸鱼游戏插件状态失败",
      games: [],
    };
  }
};

export const useXianyuGameTool = async (input: {
  action?: GameAction;
  guid?: string;
  x?: number;
  y?: number;
  cells?: string[];
  difficulty?: XianyuMinesweeperLevel;
  expression?: string;
  level?: number;
  operation?: "move" | "undo";
  directions?: string;
  move?: string;
  nickname?: string;
  session?: XianyuGameSessionScope;
  progressReporter?: (input: {
    summary: string;
    image?: string | Buffer | ArrayBuffer | NodeJS.ArrayBufferView;
    final?: boolean;
  }) => Promise<unknown>;
}) => {
  const action = input.action || "status";
  const provider = getXianyuProvider();
  if (!provider) {
    return {
      ok: false,
      error: "未检测到已加载的咸鱼游戏插件。请确认 al... host 同时安装了 xianyu-plugin。",
    };
  }
  const guid = String(input.guid ?? "").trim();
  const session: XianyuGameSessionScope | undefined = input.session
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
      const { progressMedia, ...safeResult } = result as Record<string, any>;
      if (progressMedia?.summary && input.progressReporter) {
        await input.progressReporter(progressMedia);
      }
      return safeResult;
    }
    if (action === "minesweeper_exit") {
      return provider.invoke("minesweeperExit", { guid, session });
    }
    if (
      action === "minesweeper_open" ||
      action === "minesweeper_mark" ||
      action === "minesweeper_unmark"
    ) {
      const result = await provider.invoke("minesweeperAction", {
        guid,
        operation: action.replace("minesweeper_", ""),
        cells: input.cells,
      });
      if (!result || typeof result !== "object") return result;
      const { progressMedia, ...safeResult } = result as Record<string, any>;
      if (progressMedia?.summary && input.progressReporter) {
        await input.progressReporter(progressMedia);
      }
      return safeResult;
    }
    if (Object.hasOwn(otherGameActions, action)) {
      const gameAction = action as keyof typeof otherGameActions;
      const method = otherGameActions[gameAction];
      const args: Record<string, unknown> = { guid };
      const isSingleGame = gameAction.startsWith("points24_") || gameAction.startsWith("sokoban_");
      if (isSingleGame || !gameAction.endsWith("_snapshot")) {
        args.session = session;
      }
      if (gameAction === "points24_action") args.expression = input.expression;
      if (gameAction === "sokoban_start") args.level = input.level;
      if (gameAction === "sokoban_action") {
        args.operation = input.operation;
        args.directions = input.directions;
      }
      if (gameAction === "chinese_chess_start" || gameAction === "animal_chess_start") {
        args.nickname = input.nickname;
      }
      if (gameAction === "chinese_chess_action" || gameAction === "animal_chess_action") {
        args.move = input.move;
      }
      const result = await provider.invoke(method, args);
      return gameAction.endsWith("_snapshot") ? { ok: true, result } : result;
    }
    return { ok: false, error: "不支持的咸鱼游戏操作" };
  } catch (error: any) {
    return { ok: false, error: error?.message || "咸鱼游戏工具调用失败" };
  }
};
