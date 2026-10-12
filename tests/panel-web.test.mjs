import assert from "node:assert/strict";
import { after, test, mock } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  startPanelTestRuntime,
  calls,
  client,
  imageSource,
} from "./helpers/panel-runtime.mjs";

const runtime = await startPanelTestRuntime();
after(() => runtime.close());
const panelService = await import("../lib/panel/server.js");
after(() => panelService.stopPanelServer());
const request = (path, options) => fetch(runtime.origin + path, options);
const post = (path, values) =>
  request(path, {
    method: "POST",
    body: new URLSearchParams(values),
    redirect: "manual",
  });

for (const base of [
  "",
  "/app/api",
  "/apps/alemonjs-aichat/api",
  "/robot-proxy/apps/alemonjs-aichat/api",
]) {
  test(`${base || "standalone"}: pages, links, forms, images, scripts`, async () => {
    for (const page of ["config", "chat"]) {
      const response = await request(`${base}/panel/${page}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/html/);
      const html = await response.text();
      assert.doesNotMatch(html, /ttsResponseSwitch|语音回复/);
      const relativeBase = base ? ".." : "";
      assert.ok(html.includes(`href="${relativeBase}/panel/config"`));
      assert.ok(html.includes(`href="${relativeBase}/panel/chat`));
      for (const match of html.matchAll(/(?:action|href|src)="([^" ]*)"/g)) {
        const resolved = new URL(
          match[1].replaceAll("&amp;", "&"),
          response.url,
        );
        assert.ok(resolved.pathname.startsWith(`${base}/`), resolved.href);
      }
      for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
        new vm.Script(script[1]);
      if (page === "chat") {
        assert.ok(html.includes(`data-panel-base-path="${relativeBase}"`));
        assert.ok(html.includes(`src="${relativeBase}/panel/image?`));
        assert.ok(
          html.includes('fetch(basePath + "/panel/action/chat/stream"'),
        );
        assert.ok(html.includes("basePath + src"));
      }
    }
  });

  test(`${base || "standalone"}: all POST actions preserve redirect and state`, async () => {
    const actions = [
      ["use-ai", { name: "Test AI" }, "config", "switchAI"],
      ["delete-ai", { name: "Test AI" }, "config", "deleteAI"],
      [
        "add-group-config",
        {
          guid: `new-${base || "standalone"}`,
          currentAI: "Test AI",
          chatSwitch: "1",
        },
        "config",
        "switchAI",
      ],
      [
        "update-group-config",
        {
          currentAI: "Test AI",
          chatSwitch: "1",
          toolSwitch: "1",
          imageBedSwitch: "1",
          capiContextLimit: "8192",
        },
        "config",
        "setToolSwitch",
      ],
      ["chat/use-ai", { name: "Test AI" }, "chat", "switchAI"],
      ["chat/switch-model", { model: "new-model" }, "chat", "setAIConfig"],
      [
        "chat/switch-context-limit",
        { capiContextLimit: "8192" },
        "chat",
        "setCAPIContextLimit",
      ],
      ["chat/switch-prompt", { prompt: "测试提示词" }, "chat", "switchPrompt"],
      ["chat", { message: "测试消息" }, "chat", "sendPanelChatMessage"],
      ["clear-chat", {}, "chat", "clearPanelChatMessages"],
      [
        "update-group-config",
        {
          source: "chat",
          currentAI: "Test AI",
          chatSwitch: "1",
          imageBedSwitch: "1",
        },
        "chat",
        "setToolSwitch",
      ],
    ];
    for (const [action, data, target, operation] of actions) {
      const before = calls.length;
      const response = await post(`${base}/panel/action/${action}`, {
        guid: "test-group",
        userId: "webuser",
        nickname: "中文昵称",
        panelScrollY: "125",
        panelOpenGroups: '["test-group"]',
        chatConfigOpen: "1",
        ...data,
      });
      assert.equal(response.status, 302, action);
      const location = new URL(response.headers.get("location"), response.url);
      assert.equal(location.pathname, `${base}/panel/${target}`, action);
      assert.equal(
        location.searchParams.get("panelStatus"),
        "success",
        location.href,
      );
      assert.ok(
        calls.slice(before).some((call) => call[0] === operation),
        operation,
      );
      assert.equal(
        location.searchParams.get(
          target === "chat" ? "nickname" : "panelScrollY",
        ),
        target === "chat" ? "中文昵称" : "125",
      );
    }
    const invalid = await post(`${base}/panel/action/chat/switch-model`, {
      guid: "test-group",
    });
    assert.equal(
      new URL(invalid.headers.get("location"), runtime.origin).searchParams.get(
        "panelStatus",
      ),
      "error",
    );
  });

  test(`${base || "standalone"}: streaming is incremental and images load`, async () => {
    const response = await post(`${base}/panel/action/chat/stream`, {
      guid: "test-group",
      userId: "webuser",
      message: "你好",
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"type":"delta"/);
    assert.doesNotMatch(first, /"type":"done"/);
    let tail = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      tail += new TextDecoder().decode(value);
    }
    assert.match(tail, /"type":"replace"/);
    assert.match(tail, /"type":"done"/);
    const image = await request(
      `${base}/panel/image?guid=test-group&source=${encodeURIComponent(imageSource)}`,
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.ok((await image.arrayBuffer()).byteLength > 0);
  });

  test(`${base || "standalone"}: jsxp resources use the same mount`, async () => {
    const response = await request(`${base}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const assets = [
      ...html.matchAll(/(?:src|href)="([^"]*\/_jsxp_file\?[^"]*)"/g),
    ];
    assert.ok(assets.length > 0);
    for (const [, url] of assets) {
      const resolved = new URL(url.replaceAll("&amp;", "&"), response.url);
      assert.equal(resolved.pathname, `${base}/_jsxp_file`);
      assert.equal((await fetch(resolved)).status, 200);
    }
    const localImage = fileURLToPath(
      new URL("../lib/assets/error.png.js", import.meta.url),
    );
    assert.equal(
      (
        await request(
          `${base}/_jsxp_file?path=${encodeURIComponent(localImage)}`,
        )
      ).status,
      200,
    );
    const asset = (
      await readdir(new URL("../lib/assets/", import.meta.url))
    ).find((name) => name.endsWith(".png"));
    const staticImage = await request(`${base}/${asset}`);
    assert.equal(staticImage.status, 200);
    assert.equal(staticImage.headers.get("content-type"), "image/png");
  });
}

test("hosted trailing slashes and bare API root keep relative navigation correct", async () => {
  const base = "/robot-proxy/apps/alemonjs-aichat/api";
  const root = await request(base, { redirect: "manual" });
  assert.equal(
    new URL(root.headers.get("location"), root.url).pathname,
    `${base}/`,
  );
  const response = await request(`${base}/panel/chat/`);
  const html = await response.text();
  const action = html.match(/action="([^"]*\/panel\/action\/chat)"/)[1];
  assert.equal(
    new URL(action, response.url).pathname,
    `${base}/panel/action/chat`,
  );
  const result = await post(`${base}/panel/action/chat/switch-model/`, {
    guid: "test-group",
    model: "slash-model",
  });
  assert.equal(
    new URL(result.headers.get("location"), result.url).pathname,
    `${base}/panel/chat`,
  );
});

test("AlemonX static entry is packaged and served for main and plugin", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url)),
  );
  assert.equal(pkg.alemonjs.web.config.serverPort, true);
  for (const base of [
    "/app",
    "/apps/alemonjs-aichat",
    "/robot-proxy/apps/alemonjs-aichat",
  ]) {
    const response = await request(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /url=\.\/api\/panel\/config/);
  }
});

test("concurrent independent and hosted renders do not share a path", async () => {
  const bases = Array.from(
    { length: 12 },
    (_, i) => ["", "/app/api", "/apps/alemonjs-aichat/api"][i % 3],
  );
  await Promise.all(
    bases.map(async (base) => {
      const html = await (await request(`${base}/panel/chat`)).text();
      const relativeBase = base ? ".." : "";
      assert.ok(html.includes(`data-panel-base-path="${relativeBase}"`));
      assert.ok(html.includes(`action="${relativeBase}/panel/action/chat"`));
    }),
  );
});

test("already parsed host form body does not hang", async () => {
  const parsed = await startPanelTestRuntime({ parseBody: true });
  try {
    const response = await fetch(
      `${parsed.origin}/apps/alemonjs-aichat/api/panel/action/use-ai`,
      {
        method: "POST",
        body: new URLSearchParams({ name: "Test AI", guid: "parsed-body" }),
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      },
    );
    assert.equal(response.status, 302);
    assert.ok(
      calls.some(([op, guid]) => op === "switchAI" && guid === "parsed-body"),
    );
  } finally {
    await parsed.close();
  }
});

const reservePort = async () => {
  const server = createServer((_, response) => response.end("reserved"));
  server.listen(0);
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
const availablePort = async () => {
  const reservation = await reservePort();
  await reservation.close();
  return reservation.port;
};
const hostedBase = "/robot-proxy/apps/alemonjs-aichat/api";
const PANEL_ACCESS_KEY = "ai:panel:access";
const enableStandaloneAccess = async (token = "test-panel-token") => {
  await client.redis.set(
    PANEL_ACCESS_KEY,
    JSON.stringify({ enabled: "1", token }),
  );
  return token;
};
const standaloneUrl = (port, token, path = "/panel/config") =>
  `http://127.0.0.1:${port}/${token}${path}`;

test("independent listener defaults to stopped; only hosted config shows controls", async () => {
  assert.equal(panelService.getPanelServerStatus().running, false);
  const hosted = await (await request(`${hostedBase}/panel/config`)).text();
  assert.match(hosted, /开启独立网页/);
  assert.match(hosted, /name="port"/);
  const standalone = await (await request("/panel/config")).text();
  assert.doesNotMatch(standalone, /开启独立网页/);
  assert.equal(
    (await post("/panel/action/server/start", { port: "8080" })).status,
    405,
  );
});

test("hosted controls start a real listener on custom port and stop only that listener", async () => {
  const port = await availablePort();
  try {
    for (const badPort of ["0", "-1", "65536", "12.5", "1e3", "bad"]) {
      const result = await post(`${hostedBase}/panel/action/server/start`, {
        port: badPort,
      });
      assert.equal(
        new URL(result.headers.get("location"), result.url).searchParams.get(
          "panelStatus",
        ),
        "error",
      );
      assert.equal(panelService.getPanelServerStatus().running, false);
    }
    const started = await post(`${hostedBase}/panel/action/server/start`, {
      port: String(port),
    });
    assert.equal(
      new URL(started.headers.get("location"), started.url).searchParams.get(
        "panelStatus",
      ),
      "success",
    );
    assert.deepEqual(panelService.getPanelServerStatus(), {
      running: true,
      port,
    });
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/panel/config`)).status,
      403,
    );
    const token = await enableStandaloneAccess();
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/panel/config`)).status,
      401,
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/wrong-token/panel/config`)).status,
      401,
    );
    const standalone = await fetch(standaloneUrl(port, token));
    assert.equal(standalone.status, 200);
    const standaloneHtml = await standalone.text();
    assert.doesNotMatch(standaloneHtml, /关闭独立网页/);
    assert.ok(standaloneHtml.includes(`href="/${token}/panel/config"`));
    const hosted = await (await request(`${hostedBase}/panel/config`)).text();
    assert.match(hosted, /关闭独立网页/);
    assert.ok(hosted.includes(`端口 ${port}`));
    const stopped = await post(`${hostedBase}/panel/action/server/stop`, {});
    assert.equal(
      new URL(stopped.headers.get("location"), stopped.url).searchParams.get(
        "panelStatus",
      ),
      "success",
    );
    assert.deepEqual(panelService.getPanelServerStatus(), {
      running: false,
      port,
    });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/panel/config`));
    assert.equal((await request(`${hostedBase}/panel/chat`)).status, 200);
  } finally {
    await panelService.stopPanelServer();
  }
});

test("occupied port reports failure and can be retried after it is released", async () => {
  const reservation = await reservePort();
  try {
    await assert.rejects(
      panelService.createPanelServer(reservation.port),
      /已被占用/,
    );
    assert.equal(panelService.getPanelServerStatus().running, false);
  } finally {
    await reservation.close();
  }
  try {
    const state = await panelService.createPanelServer(reservation.port);
    assert.deepEqual(state, { running: true, port: reservation.port });
    const otherPort = await availablePort();
    await assert.rejects(panelService.createPanelServer(otherPort), /先关闭/);
    const token = await enableStandaloneAccess();
    assert.equal(
      (await fetch(standaloneUrl(reservation.port, token, "/panel/chat")))
        .status,
      200,
    );
  } finally {
    await panelService.stopPanelServer();
  }
});

test("concurrent start and stop operations are serialized and reopening remembers the port", async () => {
  const port = await availablePort();
  try {
    const states = await Promise.all([
      panelService.createPanelServer(port),
      panelService.createPanelServer(port),
      panelService.stopPanelServer(),
      panelService.createPanelServer(),
    ]);
    assert.deepEqual(
      states.map((state) => state.running),
      [true, true, false, true],
    );
    assert.ok(states.every((state) => state.port === port));
    const token = await enableStandaloneAccess();
    assert.equal(
      (await fetch(standaloneUrl(port, token))).status,
      200,
    );
  } finally {
    await panelService.stopPanelServer();
  }
});

test("owner commands enforce event identity and share state with hosted controls", async () => {
  const replies = [];
  // 指令测试只替换消息封装，避免完整框架入口启动配置文件监听。
  mock.module("alemonjs", { namedExports: { Text: (text) => text } });
  const globalNames = ["onSelects", "onResponse", "format"];
  const previousGlobals = globalNames.map((name) => globalThis[name]);
  globalThis.onSelects = (select) => select;
  globalThis.onResponse = (select, current) => ({ select, current });
  globalThis.format = (text) => text;
  mock.module(
    new URL("../lib/utils/command-message.js", import.meta.url).href,
    {
      namedExports: {
        useMessage: () => [
          { send: async (payload) => replies.push(JSON.stringify(payload)) },
        ],
      },
    },
  );
  const { default: command } = await import("../lib/response/panel/res.js");
  const port = await availablePort();
  try {
    await command.current({
      IsMaster: false,
      MessageText: `#开启网页 ${port}`,
      args: { IsMaster: true },
    });
    assert.equal(panelService.getPanelServerStatus().running, false);
    assert.match(replies.at(-1), /仅主人/);
    await command.current({ IsMaster: true, MessageText: `#开启网页 ${port}` });
    assert.deepEqual(panelService.getPanelServerStatus(), {
      running: true,
      port,
    });
    assert.match(replies.at(-1), /已开启/);
    assert.match(replies.at(-1), /访问地址请私聊发 #登录面板/);
    assert.doesNotMatch(replies.at(-1), /\/panel\/config/);
    await command.current({ IsMaster: false, MessageText: "#关闭网页" });
    assert.equal(panelService.getPanelServerStatus().running, true);
    await command.current({ IsMaster: true, MessageText: "/网页状态" });
    assert.match(replies.at(-1), /运行中/);
    await post(`${hostedBase}/panel/action/server/stop`, {});
    await command.current({ IsMaster: true, MessageText: "#网页状态" });
    assert.match(replies.at(-1), /未开启/);
    await command.current({ IsMaster: true, MessageText: "#开启网页 invalid" });
    assert.match(replies.at(-1), /端口号必须/);
    await command.current({ IsMaster: true, MessageText: "/开启网页" });
    assert.deepEqual(panelService.getPanelServerStatus(), {
      running: true,
      port,
    });
    await command.current({ IsMaster: true, MessageText: "#关闭网页" });
    assert.equal(panelService.getPanelServerStatus().running, false);
    const closedAccess = JSON.parse(
      (await client.redis.get(PANEL_ACCESS_KEY)) || "{}",
    );
    assert.equal(closedAccess.enabled, "0");

    await command.current({
      IsMaster: true,
      name: "message.create",
      MessageText: "#登录面板",
    });
    assert.match(replies.at(-1), /仅限私聊/);
    await command.current({
      IsMaster: true,
      name: "private.message.create",
      MessageText: "#登录面板",
    });
    assert.match(replies.at(-1), /面板已开启访问/);
    assert.match(replies.at(-1), /\/panel\/config/);
    const openedAccess = JSON.parse(await client.redis.get(PANEL_ACCESS_KEY));
    assert.equal(openedAccess.enabled, "1");
    assert.ok(openedAccess.token);
    assert.equal(panelService.getPanelServerStatus().running, true);
    assert.equal(
      (
        await fetch(
          standaloneUrl(
            panelService.getPanelServerStatus().port,
            openedAccess.token,
          ),
        )
      ).status,
      200,
    );
    const tokenBeforeClose = openedAccess.token;
    await command.current({ IsMaster: true, MessageText: "#关闭网页" });
    const afterClose = JSON.parse(await client.redis.get(PANEL_ACCESS_KEY));
    assert.equal(afterClose.enabled, "0");
    assert.equal(afterClose.token, tokenBeforeClose);
  } finally {
    await panelService.stopPanelServer();
    globalNames.forEach((name, index) => {
      if (previousGlobals[index] === undefined) delete globalThis[name];
      else globalThis[name] = previousGlobals[index];
    });
  }
});
