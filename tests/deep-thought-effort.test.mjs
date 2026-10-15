import assert from "node:assert/strict";
import { after, before, test, mock } from "node:test";

const redisStore = new Map();
const sent = [];

mock.module("alemonjs", {
  namedExports: {
    Text: (value) => ({ type: "Text", value }),
  },
});

const redisClient = {
  redis: {
    get: async (key) => redisStore.get(key) ?? null,
    set: async (key, value) => {
      redisStore.set(key, value);
    },
  },
  getDeepThoughtEffort: async () => {
    throw new Error("replaced after import");
  },
  setDeepThoughtEffort: async () => {
    throw new Error("replaced after import");
  },
  getDeepThoughtSwitch: async () => {
    throw new Error("replaced after import");
  },
  setDeepThoughtSwitch: async () => {
    throw new Error("replaced after import");
  },
};

mock.module(new URL("../lib/config.js", import.meta.url).href, {
  defaultExport: redisClient,
});
mock.module(new URL("../lib/config/app.js", import.meta.url).href, {
  namedExports: {
    getAiChatConfigValue: () => ({}),
  },
});
mock.module(new URL("../lib/api/ai-lock.js", import.meta.url).href, {
  namedExports: {
    getLockedAIMessage: () => "locked",
  },
});
mock.module(new URL("../lib/utils/command-message.js", import.meta.url).href, {
  namedExports: {
    useMessage: () => [
      {
        send: async (payload) => {
          sent.push(payload);
        },
      },
    ],
  },
});

globalThis.onSelects = (values) => values;
globalThis.onResponse = (_selects, handler) => handler;
globalThis.format = (...items) => items;

const deepThought = await import("../lib/api/deep-thought.js");
const {
  resolveDeepThoughtEffort,
  migrateEffortFromSwitch,
  formatDeepThoughtDisplay,
  getDeepThoughtReasoning,
  normalizeDeepThoughtEffort,
  effortToSwitch,
  DEEP_THOUGHT_EFFORTS,
} = deepThought;

// Wire redis-backed methods the same way config.ts does.
redisClient.getDeepThoughtEffort = async (guid) => {
  const effort = await redisClient.redis.get(`ai:deep_thought:effort:${guid}`);
  const switchValue = await redisClient.redis.get(
    `ai:deep_thought:switch:${guid}`,
  );
  return resolveDeepThoughtEffort({ effort, switchValue });
};
redisClient.setDeepThoughtEffort = async (guid, effort) => {
  const next = normalizeDeepThoughtEffort(effort);
  await redisClient.redis.set(`ai:deep_thought:effort:${guid}`, next);
  await redisClient.redis.set(
    `ai:deep_thought:switch:${guid}`,
    effortToSwitch(next),
  );
};
redisClient.getDeepThoughtSwitch = async (guid) =>
  effortToSwitch(await redisClient.getDeepThoughtEffort(guid));
redisClient.setDeepThoughtSwitch = async (guid, enable) => {
  await redisClient.setDeepThoughtEffort(guid, enable ? "medium" : "none");
};

const settingHandler = await import("../lib/response/setting/res.js");
const handleSetting = settingHandler.default;

const latestText = () =>
  sent
    .at(-1)
    .map((item) => item.value)
    .join("");

const baseEvent = {
  guid: "g1",
  UserId: "u1",
  IsMaster: true,
  name: "message.create",
};

before(() => {
  redisStore.clear();
  sent.length = 0;
});

test("migrate from switch-only: 1→medium, 0→none", () => {
  assert.equal(migrateEffortFromSwitch("1"), "medium");
  assert.equal(migrateEffortFromSwitch("0"), "none");
  assert.equal(migrateEffortFromSwitch(null), "none");
  assert.equal(
    resolveDeepThoughtEffort({ effort: null, switchValue: "1" }),
    "medium",
  );
  assert.equal(
    resolveDeepThoughtEffort({ effort: "high", switchValue: "0" }),
    "high",
  );
});

test("getDeepThoughtEffort migrates switch-only redis data", async () => {
  redisStore.clear();
  redisStore.set("ai:deep_thought:switch:g-mig", "1");
  assert.equal(await redisClient.getDeepThoughtEffort("g-mig"), "medium");
  assert.equal(await redisClient.getDeepThoughtSwitch("g-mig"), "1");

  redisStore.clear();
  redisStore.set("ai:deep_thought:switch:g-mig", "0");
  assert.equal(await redisClient.getDeepThoughtEffort("g-mig"), "none");
});

test("open/close sync effort and switch", async () => {
  redisStore.clear();
  sent.length = 0;
  await handleSetting({ ...baseEvent, msg: "#开启深度思考" }, () => {});
  assert.equal(redisStore.get("ai:deep_thought:effort:g1"), "medium");
  assert.equal(redisStore.get("ai:deep_thought:switch:g1"), "1");
  assert.match(latestText(), /开启.*medium/);

  await handleSetting({ ...baseEvent, msg: "#关闭深度思考" }, () => {});
  assert.equal(redisStore.get("ai:deep_thought:effort:g1"), "none");
  assert.equal(redisStore.get("ai:deep_thought:switch:g1"), "0");
  assert.match(latestText(), /关闭/);
});

test("#思考深度 query anyone; set owner-only; invalid rejected", async () => {
  redisStore.clear();
  sent.length = 0;
  await redisClient.setDeepThoughtEffort("g1", "low");

  await handleSetting(
    { ...baseEvent, IsMaster: false, msg: "#思考深度" },
    () => {},
  );
  assert.equal(
    latestText(),
    "当前思考深度：low\n合法值：none | minimal | low | medium | high | xhigh | max",
  );

  await handleSetting(
    { ...baseEvent, IsMaster: false, msg: "#思考深度 high" },
    () => {},
  );
  assert.match(latestText(), /仅主人可用/);
  assert.equal(await redisClient.getDeepThoughtEffort("g1"), "low");

  await handleSetting({ ...baseEvent, msg: "#思考深度 weird" }, () => {});
  assert.match(latestText(), /无效档位/);
  assert.match(latestText(), /none/);
  assert.match(latestText(), /xhigh/);

  await handleSetting({ ...baseEvent, msg: "#思考深度 xhigh" }, () => {});
  assert.equal(await redisClient.getDeepThoughtEffort("g1"), "xhigh");
  assert.equal(redisStore.get("ai:deep_thought:switch:g1"), "1");
  assert.match(latestText(), /xhigh/);

  await handleSetting({ ...baseEvent, msg: "#思考深度 none" }, () => {});
  assert.equal(await redisClient.getDeepThoughtEffort("g1"), "none");
  assert.equal(redisStore.get("ai:deep_thought:switch:g1"), "0");
});

test("#思考深度 works in private chat", async () => {
  redisStore.clear();
  sent.length = 0;
  await handleSetting(
    {
      ...baseEvent,
      name: "private.message.create",
      msg: "#思考深度 minimal",
    },
    () => {},
  );
  assert.equal(await redisClient.getDeepThoughtEffort("g1"), "minimal");
  assert.match(latestText(), /minimal/);
});

test("rapi gets effort string; doubao/capi only on/off", () => {
  const rapiHigh = getDeepThoughtReasoning({
    deepThoughtEffort: "high",
    config: { model: "gpt-5.1", apiMode: "rapi" },
  });
  assert.deepEqual(rapiHigh, { reasoning: { effort: "high" } });

  const rapiXhigh = getDeepThoughtReasoning({
    deepThoughtEffort: "xhigh",
    config: { model: "deepseek-reasoner", apiMode: "rapi" },
  });
  assert.deepEqual(rapiXhigh, { reasoning: { effort: "xhigh" } });

  const rapiNone = getDeepThoughtReasoning({
    deepThoughtEffort: "none",
    config: { model: "qwen-plus", apiMode: "rapi" },
  });
  assert.deepEqual(rapiNone, { reasoning: { effort: "none" } });

  const rapiUnknown = getDeepThoughtReasoning({
    deepThoughtEffort: "high",
    config: { model: "claude-sonnet", apiMode: "rapi" },
  });
  assert.deepEqual(rapiUnknown, {});

  const doubaoOn = getDeepThoughtReasoning({
    deepThoughtEffort: "max",
    config: { model: "doubao-seed", apiMode: "rapi" },
  });
  assert.deepEqual(doubaoOn, { thinking: { type: "enabled" } });
  assert.equal(doubaoOn.reasoning, undefined);

  const doubaoOff = getDeepThoughtReasoning({
    deepThoughtEffort: "none",
    config: { model: "doubao-seed", apiMode: "rapi" },
  });
  assert.deepEqual(doubaoOff, { thinking: { type: "disabled" } });

  const capiMax = getDeepThoughtReasoning({
    deepThoughtEffort: "max",
    config: { model: "gpt-5", apiMode: "capi" },
  });
  assert.deepEqual(capiMax, { reasoning_effort: "medium" });

  const capiDeepseek = getDeepThoughtReasoning({
    deepThoughtEffort: "xhigh",
    config: { model: "deepseek-chat", apiMode: "capi" },
  });
  assert.deepEqual(capiDeepseek, {
    thinking: { type: "enabled" },
    reasoning_effort: "medium",
  });

  const capiOff = getDeepThoughtReasoning({
    deepThoughtEffort: "none",
    config: { model: "gpt-5", apiMode: "capi" },
  });
  assert.deepEqual(capiOff, { reasoning_effort: "none" });
});

test("AI config display: 关闭 or level name", () => {
  assert.equal(formatDeepThoughtDisplay("none"), "关闭");
  assert.equal(formatDeepThoughtDisplay("medium"), "medium");
  assert.equal(formatDeepThoughtDisplay("xhigh"), "xhigh");
  assert.ok(DEEP_THOUGHT_EFFORTS.includes("max"));
});

test("legacy switch-only cfg still drives getDeepThoughtReasoning", () => {
  const on = getDeepThoughtReasoning({
    deepThoughtSwitch: "1",
    config: { model: "gpt-5", apiMode: "rapi" },
  });
  assert.deepEqual(on, { reasoning: { effort: "medium" } });

  const off = getDeepThoughtReasoning({
    deepThoughtSwitch: "0",
    config: { model: "gpt-5", apiMode: "rapi" },
  });
  assert.deepEqual(off, { reasoning: { effort: "none" } });
});
