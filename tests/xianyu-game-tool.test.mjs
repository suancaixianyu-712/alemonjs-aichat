import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerExpose } from "alemonjs";

// 覆盖 Aichat 侧新加的扫雷动作：minesweeper_start / minesweeper_exit。
// 用一个假的咸鱼插件 provider 验证会话作用域注入与进度图片转发。
const {
  buildXianyuGameSession,
  useXianyuGameTool,
  XIANYU_GAME_PROTOCOL,
} = await import("../lib/api/xianyu-game.js");
const { tools } = await import("../lib/api/aitools.js");

const invocations = [];
const reporterCalls = [];

const startSnapshot = {
  game: "minesweeper",
  guid: "group-1",
  status: "playing",
  width: 9,
  height: 9,
  mineCount: 10,
  openedCount: 0,
  flagCount: 0,
  board: [["unknown"]],
};
const progressMedia = {
  summary: "已开始简单扫雷：9×9，共 10 雷。",
  image: Buffer.from("board"),
  final: false,
};

registerExpose("xianyu-plugin-test", [
  {
    name: XIANYU_GAME_PROTOCOL,
    description: "测试用咸鱼游戏服务",
    actions: {
      status: {
        handler: () => ({ protocol: XIANYU_GAME_PROTOCOL, games: [] }),
      },
      minesweeperSnapshot: {
        handler: (input) => {
          invocations.push(["minesweeperSnapshot", input]);
          return null;
        },
      },
      minesweeperStart: {
        handler: (input) => {
          invocations.push(["minesweeperStart", input]);
          if (input.difficulty === "地狱") {
            return { ok: false, error: "扫雷难度仅支持：简单、中等、困难" };
          }
          return {
            ok: true,
            started: true,
            difficulty: input.difficulty,
            snapshot: startSnapshot,
            progressMedia,
          };
        },
      },
      minesweeperExit: {
        handler: (input) => {
          invocations.push(["minesweeperExit", input]);
          return { ok: true, ended: true };
        },
      },
    },
  },
]);

const reporter = async (update) => {
  reporterCalls.push(update);
  return true;
};

test("buildXianyuGameSession 覆盖式提取真实会话作用域", () => {
  assert.deepEqual(
    buildXianyuGameSession({
      name: "message.create",
      guid: "group-1",
      UserId: "user-1",
      ChannelId: "channel-1",
      GuildId: "guild-1",
      SpaceId: "space-1",
      MessageText: "帮我玩扫雷",
      __route: { key: "扫雷", parsedArgs: ["困难"] },
    }),
    {
      guid: "group-1",
      UserId: "user-1",
      ChannelId: "channel-1",
      GuildId: "guild-1",
      SpaceId: "space-1",
      IsPrivate: false,
    },
  );

  assert.deepEqual(
    buildXianyuGameSession({
      name: "private.message.create",
      guid: "user-1",
      UserId: "user-1",
    }),
    { guid: "user-1", UserId: "user-1", IsPrivate: true },
  );
});

test("XianyuGame 工具声明了扫雷开始与结束动作", () => {
  const tool = tools.find((item) => item.function.name === "XianyuGame");
  assert.ok(tool, "XianyuGame 工具必须存在");
  assert.ok(tool.function.parameters.properties.action.enum.includes("minesweeper_start"));
  assert.ok(tool.function.parameters.properties.action.enum.includes("minesweeper_exit"));
  assert.deepEqual(tool.function.parameters.properties.difficulty.enum, [
    "简单",
    "中等",
    "困难",
  ]);
  assert.ok(tool.function.parameters.properties.session, "session 必须声明为系统注入参数");
  assert.ok(tool.function.description.includes("minesweeper_start"));
  assert.ok(tool.function.description.includes("minesweeper_exit"));
});

test("minesweeper_start 透传会话作用域与难度并转发进度图片", async () => {
  invocations.length = 0;
  reporterCalls.length = 0;
  const session = buildXianyuGameSession({
    name: "message.create",
    guid: "group-1",
    UserId: "user-1",
    ChannelId: "channel-1",
  });

  const result = await useXianyuGameTool({
    action: "minesweeper_start",
    guid: "group-1",
    difficulty: "中等",
    session,
    progressReporter: reporter,
  });

  assert.deepEqual(invocations, [
    [
      "minesweeperStart",
      { guid: "group-1", difficulty: "中等", session },
    ],
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.difficulty, "中等");
  assert.deepEqual(result.snapshot, startSnapshot);
  assert.equal("progressMedia" in result, false, "图片不应回灌模型上下文");
  assert.deepEqual(reporterCalls, [progressMedia]);
});

test("minesweeper_start 缺省难度时交给插件决定", async () => {
  invocations.length = 0;
  await useXianyuGameTool({
    action: "minesweeper_start",
    guid: "group-1",
    session: { guid: "group-1", UserId: "user-1" },
  });
  assert.deepEqual(invocations, [
    [
      "minesweeperStart",
      {
        guid: "group-1",
        difficulty: undefined,
        session: { guid: "group-1", UserId: "user-1" },
      },
    ],
  ]);
});

test("minesweeper_start 不支持的难度按插件返回原样透出", async () => {
  const result = await useXianyuGameTool({
    action: "minesweeper_start",
    guid: "group-1",
    difficulty: "地狱",
    session: { guid: "group-1", UserId: "user-1" },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /难度/);
});

test("minesweeper_exit 透传会话作用域", async () => {
  invocations.length = 0;
  const session = { guid: "group-1", UserId: "user-1", IsPrivate: false };
  const result = await useXianyuGameTool({
    action: "minesweeper_exit",
    guid: "group-1",
    session,
  });
  assert.deepEqual(invocations, [["minesweeperExit", { guid: "group-1", session }]]);
  assert.deepEqual(result, { ok: true, ended: true });
});

test("缺少 guid 时拒绝扫雷操作", async () => {
  const result = await useXianyuGameTool({ action: "minesweeper_start" });
  assert.equal(result.ok, false);
  assert.match(result.error, /guid/);
});

// alemonjs 运行时会在进程里保留常驻句柄，无法靠事件循环自然退出，
// 所以这里显式退出；node:test 的进程内 runner 不会同步 process.exitCode，
// 于是直接标记 stdout 里出现的 TAP 失败结果，任何失败都返回非 0。
let failedTest = false;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
  if (/^(not ok |✖ )/m.test(text)) failedTest = true;
  return write(chunk, ...rest);
};

after(() => {
  setImmediate(() => process.exit(failedTest ? 1 : 0));
});
