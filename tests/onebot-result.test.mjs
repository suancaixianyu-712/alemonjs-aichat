import assert from "node:assert/strict";
import { test } from "node:test";

const { unwrapOneBotData, normalizeLoginInfo } = await import(
  "../lib/api/onebot-result.js"
);

test("unwrapOneBotData: 当前 SDK 直接返回 data 对象", () => {
  const raw = { user_id: 12345, nickname: "小喵酱" };
  assert.deepEqual(unwrapOneBotData(raw), raw);
});

test("unwrapOneBotData: 兼容旧版 [{ code, data }] 包装", () => {
  const payload = { user_id: 1, nickname: "bot" };
  assert.deepEqual(unwrapOneBotData([{ code: 0, data: payload }]), payload);
});

test("unwrapOneBotData: Fail(4000) / null / undefined / 空数组 → null", () => {
  assert.equal(unwrapOneBotData(null), null);
  assert.equal(unwrapOneBotData(undefined), null);
  assert.equal(unwrapOneBotData([]), null);
  assert.equal(unwrapOneBotData([{ code: 4000, data: null }]), null);
  assert.equal(unwrapOneBotData({ code: 4000, data: { nickname: "x" } }), null);
});

test("unwrapOneBotData: 单对象 Result 包装 { code, data }", () => {
  const payload = { user_id: 9, nickname: "n" };
  assert.deepEqual(unwrapOneBotData({ code: 0, data: payload }), payload);
});

test("unwrapOneBotData: get_msg / stranger_info 直出 payload", () => {
  const msg = {
    message_id: 42,
    sender: { user_id: 7, nickname: "u" },
    message: [{ type: "text", data: { text: "hi" } }],
  };
  assert.deepEqual(unwrapOneBotData(msg), msg);

  const stranger = { user_id: 8, nickname: "路人" };
  assert.equal(unwrapOneBotData(stranger)?.nickname, "路人");
  assert.equal(
    unwrapOneBotData([{ code: 0, data: stranger }])?.nickname,
    "路人",
  );
});

test("normalizeLoginInfo: 正常 { user_id, nickname } → ok 且非空昵称", () => {
  const r = normalizeLoginInfo({ user_id: 794161769, nickname: "小咸鱼" });
  assert.equal(r.ok, true);
  assert.equal(r.emptyNickname, false);
  assert.equal(r.loginInfo.nickname, "小咸鱼");
  assert.equal(r.loginInfo.user_id, 794161769);
});

test("normalizeLoginInfo: 空昵称 → ok + emptyNickname（软故障）", () => {
  const r = normalizeLoginInfo({ user_id: 1, nickname: "  " });
  assert.equal(r.ok, true);
  assert.equal(r.emptyNickname, true);
});

test("normalizeLoginInfo: null / 超时 → !ok（不应写无法发送语音类 ClientError）", () => {
  assert.equal(normalizeLoginInfo(null).ok, false);
  assert.equal(normalizeLoginInfo(undefined).ok, false);
  assert.equal(normalizeLoginInfo([{ code: 4000 }]).ok, false);
});

test("middleware 源码：onebot 登录路径不再用 botInfo[0] / 无法发送语音", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../src/middleware/mw.ts", import.meta.url),
    "utf8",
  );
  const onebotBlock = src.slice(
    src.indexOf('if (event.Platform == "onebot")'),
    src.indexOf('if (event.Platform == "scbbs")'),
  );
  assert.match(onebotBlock, /normalizeLoginInfo/);
  assert.match(onebotBlock, /unwrapOneBotData/);
  assert.doesNotMatch(onebotBlock, /botInfo\[0\]/);
  assert.doesNotMatch(onebotBlock, /无法发送语音/);
  assert.doesNotMatch(onebotBlock, /ClientError/);
});
