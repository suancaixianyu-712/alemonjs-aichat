import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";

const moduleUrl = (path) => new URL(`../lib/${path}.js`, import.meta.url).href;
const upstream = await import(moduleUrl("api/ds-tts/ds/tts"));
const events = [];
const requests = [];
const uploads = [];
let accountVoice;
let returnedVoice;
let voiceError;
let generation;
let deliveredText;
let fetchMock;
let workDir;
const originalCwd = process.cwd();

mock.module(moduleUrl("api/ds-tts/ds/tts"), { namedExports: {
  fetchVoices: upstream.fetchVoices,
  setVoice: upstream.setVoice,
  synthFromMessage: async () => {
    const voice = accountVoice;
    events.push(`synth:${voice}`);
    // 留出并发切换账号音色的机会，验证切换和合成处于同一个串行任务内。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(accountVoice, voice);
    generation++;
    return { ok: true, data: {
      bytes: new Uint8Array([generation, 0]), serverFormat: "pcm",
      voiceId: returnedVoice ?? voice, audioId: `audio-${generation}`,
      traceId: "test-trace", frames: 1,
    } };
  },
} });

mock.module(moduleUrl("api/ds-tts/browser/page"), { namedExports: {
  ensureBrowser: async () => {
    events.push("browser");
    return { ok: true, base: "http://127.0.0.1:9222", launched: false };
  },
  pickWorkPage: async () => ({ ok: true, target: {} }),
  attach: async () => ({ close: () => events.push("close") }),
  waitForDsOrigin: async () => ({ ok: true }),
  readToken: async () => "test-ds-token",
  readPageUrl: async () => "https://chat.deepseek.com/a/chat/s/test-session",
  readHistory: async () => ({ ok: true, messages: [] }),
  deliverText: async (_, text) => {
    events.push("deliver");
    deliveredText = text.slice(text.indexOf("\n\n") + 2);
    return { ok: true, method: "test", selector: "test" };
  },
  waitForNewMessage: async () => ({ ok: true, message: {
    id: `message-${generation}`, content: deliveredText, status: "FINISHED",
  } }),
  listDsPages: async () => [],
  sessionIdFromUrl: () => "test-session",
} });

mock.module(moduleUrl("s3"), { namedExports: {
  uploadMediaToR2: async (file, key) => {
    uploads.push({ file, key, bytes: await readFile(file) });
    return `https://cdn.example.invalid/${key ?? basename(file)}`;
  },
} });

const { dsTtsSpeak, resetDsTtsEngineForTests } = await import(moduleUrl("api/ds-tts/index"));
const { resetDsTtsConfigStoreForTests } = await import(moduleUrl("api/ds-tts/config"));
const { cacheDirPath, configFilePath } = await import(moduleUrl("api/ds-tts/paths"));
const { cacheId, cacheStats, writeCache } = await import(moduleUrl("api/ds-tts/audio/cache"));

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "aichat-ds-tts-test-"));
  process.chdir(workDir);
  resetDsTtsEngineForTests();
  resetDsTtsConfigStoreForTests();
  events.length = requests.length = uploads.length = 0;
  accountVoice = "echo";
  returnedVoice = undefined;
  voiceError = false;
  generation = 0;
  fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://chat.deepseek.com/api/v0/chat/tts/voice");
    const body = JSON.parse(options.body);
    requests.push({ method: options.method, body, signal: options.signal });
    events.push(`set:${body.voice_id}`);
    if (voiceError) return Response.json({ code: 0, data: { biz_code: 11 } });
    accountVoice = body.voice_id;
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: {} } });
  });
});

afterEach(async () => {
  fetchMock.mock.restore();
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

test("传入的音色通过真实 HTTP 请求体切换后才投递和合成", async () => {
  const result = await dsTtsSpeak({ text: "你好", voice: " STELLA " });
  assert.equal(result.ok, true);
  assert.equal(result.voice, "stella");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, { voice_id: "stella" });
  assert.ok(requests[0].signal instanceof AbortSignal);
  assert.deepEqual(events, ["browser", "set:stella", "deliver", "synth:stella", "close"]);
  assert.equal(uploads[0].bytes.subarray(-2).toString("hex"), "0100");
  await assert.rejects(access(dirname(uploads[0].file)), { code: "ENOENT" });
});

test("省略音色时也将账号音色切换到配置值", async () => {
  await mkdir(dirname(configFilePath()), { recursive: true });
  await writeFile(configFilePath(), JSON.stringify({ config: { voice: "tide" } }));
  const result = await dsTtsSpeak({ text: "使用配置的声音" });
  assert.equal(result.ok, true);
  assert.equal(result.voice, "tide");
  assert.deepEqual(requests[0].body, { voice_id: "tide" });
});

test("并发请求不同音色时，账号切换与合成按同一队列执行", async () => {
  const results = await Promise.all([
    dsTtsSpeak({ text: "同一句话", voice: "mira" }),
    dsTtsSpeak({ text: "同一句话", voice: "tide" }),
  ]);
  assert.deepEqual(results.map(({ ok, voice }) => ({ ok, voice })), [
    { ok: true, voice: "mira" }, { ok: true, voice: "tide" },
  ]);
  assert.deepEqual(events.filter((event) => /^(set|synth):/.test(event)), [
    "set:mira", "synth:mira", "set:tide", "synth:tide",
  ]);
});

test("音色切换失败直接返回错误，不投递、合成或缓存错误声音", async () => {
  voiceError = true;
  const result = await dsTtsSpeak({ text: "你好", voice: "mira" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DS_FORBIDDEN");
  assert.deepEqual(events, ["browser", "set:mira", "close"]);
  assert.equal(uploads.length, 0);
  assert.equal((await cacheStats(cacheDirPath())).files, 0);
});

test("服务端返回错误音色时拒绝缓存，下一次请求仍会重新合成", async () => {
  returnedVoice = "echo";
  const failed = await dsTtsSpeak({ text: "你好", voice: "mira" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /音色与请求不一致/);
  assert.equal(uploads.length, 0);
  assert.equal((await cacheStats(cacheDirPath())).files, 0);
  returnedVoice = undefined;
  const retried = await dsTtsSpeak({ text: "你好", voice: "mira" });
  assert.equal(retried.ok, true);
  assert.equal(retried.voice, "mira");
  assert.equal(generation, 2);
});

test("不再命中修复前未切换音色的旧缓存，新缓存可直接重播", async () => {
  const oldId = cacheId(["mira", "pcm", "你好"]);
  await writeCache(cacheDirPath(), oldId, "wav", Buffer.from("wrong-voice"), {
    voice: "mira", mode: "echo", format: "pcm", seconds: 0,
    text: "你好", truncated: false,
  });
  const first = await dsTtsSpeak({ text: "你好", voice: "mira" });
  assert.equal(first.ok, true);
  assert.equal(generation, 1);
  assert.notEqual(uploads[0].bytes.toString(), "wrong-voice");
  const eventsBefore = [...events];
  accountVoice = "echo";
  const replay = await dsTtsSpeak({ text: "你好", voice: "mira" });
  assert.equal(replay.ok, true);
  assert.equal(replay.voice, "mira");
  assert.deepEqual(events, eventsBefore);
  assert.deepEqual(uploads[1].bytes, uploads[0].bytes);
});

test("同一句话强制重新生成后使用新的 CDN 路径并上传新字节，缓存保存最新版本", async () => {
  const options = { text: "同一句话", voice: "mira" };
  const first = await dsTtsSpeak(options);
  const second = await dsTtsSpeak({ ...options, regenerate: true });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(new URL(first.url).pathname, new URL(second.url).pathname);
  assert.equal(new URL(second.url).search, "");
  assert.equal(generation, 2);
  assert.notDeepEqual(uploads[0].bytes, uploads[1].bytes);
  assert.equal(uploads[1].bytes.subarray(-2).toString("hex"), "0200");
  assert.match(uploads[1].key, /^ds-tts-[0-9a-f]{16}-[0-9a-f-]{36}\.wav$/);
  const replay = await dsTtsSpeak(options);
  assert.equal(replay.ok, true);
  assert.equal(generation, 2);
  assert.deepEqual(uploads[2].bytes, uploads[1].bytes);
  for (const { file, key } of uploads) {
    assert.equal(basename(file), key);
    await assert.rejects(access(dirname(file)), { code: "ENOENT" });
  }
});
