import assert from "node:assert/strict";
import test from "node:test";

const {
  normalizeForSpeech,
  resolveAttemptOrder,
  normalizeConfigPatch,
  isDsTtsVoiceId,
  DS_TTS_VOICES,
  DEFAULT_DS_TTS_CONFIG,
  KNOWN_DS_VOICES,
} = await import("../lib/api/ds-tts/index.js");

const { cacheId, shouldReadCache, audioVersion } = await import("../lib/api/ds-tts/audio/cache.js");
const { pcmToWav, pcmDurationSeconds } = await import("../lib/api/ds-tts/audio/wav.js");

// 指令解析纯函数：不 import response（会拉 alemonjs/redis）
const isDsTtsCommand = (text) => /^(#|\/)DS朗读(?:配置|状态)(?:\s|$)/i.test(text);
const parseDsTtsConfigArgs = (raw) => {
  const out = {};
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (!key) continue;
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
};

test("normalizeForSpeech strips code fences and truncates", () => {
  const input = "你好世界。\n```js\nconsole.log(1)\n```\n再见！";
  const result = normalizeForSpeech(input, 2000);
  assert.equal(result.stats.codeBlocks >= 1, true);
  assert.match(result.text, /你好世界/);
  assert.doesNotMatch(result.text, /console\.log/);
  const truncated = normalizeForSpeech("啊。".repeat(3000), 100);
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.text.length <= 100);
});

test("resolveAttemptOrder v1 固定只 echo", () => {
  assert.deepEqual(resolveAttemptOrder("echo", null), ["echo"]);
  assert.deepEqual(resolveAttemptOrder("user", null), ["echo"]);
  assert.deepEqual(resolveAttemptOrder("auto", false), ["echo"]);
  assert.deepEqual(resolveAttemptOrder("auto", null), ["echo"]);
  assert.deepEqual(resolveAttemptOrder("auto", true), ["echo"]);
});

test("normalizeConfigPatch and voice guard", () => {
  assert.equal(isDsTtsVoiceId("mira"), true);
  assert.equal(isDsTtsVoiceId("alloy"), false);
  assert.deepEqual(DS_TTS_VOICES, ["mira", "echo", "stella", "tide"]);
  const patch = normalizeConfigPatch({
    voice: "STELLA",
    timeoutMs: 999999,
    autoLaunch: false,
    browserPath: " /usr/bin/google-chrome ",
    junk: 1,
  });
  assert.equal(patch.voice, "stella");
  assert.equal(patch.timeoutMs, 600000);
  assert.equal(patch.autoLaunch, false);
  assert.equal(patch.browserPath, "/usr/bin/google-chrome");
  assert.equal(patch.junk, undefined);
  assert.equal(DEFAULT_DS_TTS_CONFIG.mode, "echo");
  assert.equal(DEFAULT_DS_TTS_CONFIG.voice, "mira");
  assert.equal(KNOWN_DS_VOICES.length, 4);
});

test("cache helpers", () => {
  assert.equal(shouldReadCache(true, false), true);
  assert.equal(shouldReadCache(true, true), false);
  assert.equal(shouldReadCache(false, false), false);
  assert.match(cacheId(["mira", "pcm", "hello"]), /^[0-9a-f]{16}$/);
  assert.equal(audioVersion("abc", 1), "abc");
  assert.match(audioVersion("", 1000), /^t/);
});

test("pcmToWav header", () => {
  const pcm = new Uint8Array(48000);
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
  assert.ok(Math.abs(pcmDurationSeconds(pcm.length) - 1) < 0.01);
});

test("command parse helpers", () => {
  assert.equal(isDsTtsCommand("#DS朗读状态"), true);
  assert.equal(isDsTtsCommand("#DS朗读配置 voice=mira"), true);
  assert.equal(isDsTtsCommand("#语音列表"), false);
  assert.deepEqual(parseDsTtsConfigArgs("voice=mira timeoutMs=90000 autoLaunch=false browserPath=/opt/chrome"), {
    voice: "mira",
    timeoutMs: 90000,
    autoLaunch: false,
    browserPath: "/opt/chrome",
  });
});
