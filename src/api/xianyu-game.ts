import { Expose } from "alemonjs";

export const XIANYU_GAME_PROTOCOL = "xianyu-game-v1";

type GameAction =
  | "status"
  | "gobang_snapshot"
  | "gobang_move"
  | "minesweeper_snapshot"
  | "minesweeper_open"
  | "minesweeper_mark"
  | "minesweeper_unmark";

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
    return { ok: false, error: "不支持的咸鱼游戏操作" };
  } catch (error: any) {
    return { ok: false, error: error?.message || "咸鱼游戏工具调用失败" };
  }
};
