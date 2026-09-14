import assert from "node:assert/strict";
import test from "node:test";
import {
  createActiveProgressAPI,
  createScbbsProgress,
} from "../lib/response/zreply/scbbs-progress.js";

test("通过当前事件绑定的活动平台客户端调用进度 API", async () => {
  const event = { Platform: "scbbs", UserId: "12" };
  const calls = [];
  const runtime = {
    ResultCode: { Ok: 200 },
    useClient(actualEvent) {
      assert.equal(actualEvent, event);
      return [
        new Proxy(
          {},
          {
            get(_target, action) {
              return async (options) => {
                calls.push({ action, options });
                return [
                  { code: 200, data: { scope: "private", messageId: 56 } },
                ];
              };
            },
          },
        ),
      ];
    },
  };
  const api = createActiveProgressAPI(event, runtime);

  assert.deepEqual(
    await api.startAIProgressMessage({
      scope: "private",
      targetId: "12",
      steps: [],
    }),
    { scope: "private", messageId: 56 },
  );
  assert.deepEqual(calls, [
    {
      action: "startAIProgressMessage",
      options: { scope: "private", targetId: "12", steps: [] },
    },
  ]);
});

for (const scope of ["private", "group"]) {
  test(`${scope}: 多轮共用消息并正确结束`, async () => {
    const calls = [];
    const progress = createScbbsProgress(
      {
        Platform: "scbbs",
        name: scope === "private" ? "private.message.create" : "message.create",
        UserId: "12",
        ChannelId: "34",
      },
      async () => ({
        startAIProgressMessage: async (options) => {
          calls.push(options);
          return { scope, messageId: 56 };
        },
        updateAIProgressMessage: async (options) => calls.push(options),
      }),
    );
    assert.equal(await progress.append("正在检查文件"), true);
    assert.equal(await progress.append("准备执行检查", "tool"), true);
    await progress.finish("completed");
    assert.deepEqual(calls, [
      {
        scope,
        targetId: scope === "private" ? "12" : "34",
        steps: [{ type: "thought_summary", summary: "正在检查文件" }],
      },
      {
        scope,
        messageId: 56,
        appendStep: { type: "tool", summary: "准备执行检查" },
      },
      { scope, messageId: 56, status: "completed" },
    ]);
  });
}

test("其他平台与空内容不加载适配器", async () => {
  const loader = async () => assert.fail("不应加载适配器");
  const other = createScbbsProgress({ Platform: "onebot" }, loader);
  assert.equal(await other.append("正在检查"), false);
  await other.finish("completed");
  const empty = createScbbsProgress({ Platform: "scbbs" }, loader);
  assert.equal(await empty.append("  "), true);
  await empty.finish("completed");
});

test("扫雷过程图片追加到同一条进度消息", async () => {
  const calls = [];
  const image = Buffer.from("image");
  const progress = createScbbsProgress(
    {
      Platform: "scbbs",
      name: "private.message.create",
      UserId: "12",
    },
    async () => ({
      startAIProgressMessage: async (options) => {
        calls.push(options);
        return { scope: "private", messageId: 56 };
      },
      updateAIProgressMessage: async (options) => calls.push(options),
    }),
  );

  assert.equal(await progress.append("开始分析"), true);
  assert.equal(await progress.appendImage("新增翻开 6 格", image), true);
  assert.deepEqual(calls, [
    {
      scope: "private",
      targetId: "12",
      steps: [{ type: "thought_summary", summary: "开始分析" }],
    },
    {
      scope: "private",
      messageId: 56,
      appendStep: { type: "result", summary: "新增翻开 6 格" },
      stepImage: `base64://${image.toString("base64")}`,
    },
  ]);
});

test("首次进度就是图片时也跨插件传递 base64 字符串", async () => {
  const calls = [];
  const image = new Uint8Array([1, 2, 3]);
  const progress = createScbbsProgress(
    {
      Platform: "scbbs",
      name: "private.message.create",
      UserId: "12",
    },
    async () => ({
      startAIProgressMessage: async (options) => {
        calls.push(options);
        return { scope: "private", messageId: 57 };
      },
      updateAIProgressMessage: async () => {},
    }),
  );

  assert.equal(await progress.appendImage("首次翻开", image), true);
  assert.equal(calls[0].stepImage, "base64://AQID");
});

for (const status of ["failed", "interrupted"]) {
  test(`保留 ${status} 终态`, async () => {
    const progress = createScbbsProgress(
      { Platform: "scbbs", name: "private.message.create", UserId: "12" },
      async () => ({
        startAIProgressMessage: async () => ({
          scope: "private",
          messageId: 56,
        }),
        updateAIProgressMessage: async (options) =>
          assert.equal(options.status, status),
      }),
    );
    await progress.append("正在检查");
    await progress.finish(status);
  });
}

test("适配器不可用时允许回退普通消息", async (t) => {
  t.mock.method(console, "error", () => {});
  let attempts = 0;
  const progress = createScbbsProgress({ Platform: "scbbs" }, async () => {
    attempts++;
    throw new Error("adapter unavailable");
  });
  assert.equal(await progress.append("第一轮"), false);
  assert.equal(await progress.append("第二轮"), false);
  await progress.finish("failed");
  assert.equal(attempts, 1);
});
