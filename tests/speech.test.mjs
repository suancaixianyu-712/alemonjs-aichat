import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, test, mock } from "node:test";

mock.module("alemonjs", { namedExports: {
  Audio: (value) => ({ type: "Audio", value }),
  Text: (value) => ({ type: "Text", value }),
} });
const { createSpeechAudio, getSpeechVoices, sendSpeechToolResult, validateSpeechModel, OPENAI_SPEECH_MODELS, listOpenAISpeechModelsText, speechModelSupportsInstructions } = await import("../lib/api/speech.js");

globalThis.format = (...items) => items;
const requests = [];
let emptyResponse = false;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(raw) });
  res.writeHead(200, { "Content-Type": "audio/mpeg" });
  res.end(emptyResponse ? Buffer.alloc(0) : Buffer.from("ID3test-audio"));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
const base = {
  host: `http://127.0.0.1:${server.address().port}/v1`,
  key: "test-speech-key", model: "gpt-4o-mini-tts", voice: "alloy", text: "你好",
};

test("真实 OpenAI SDK 使用语音端点、指定模型及音色，读取 MP3 二进制", async () => {
  const audio = await createSpeechAudio({ ...base, voice: "nova", instructions: "温柔地朗读", useProxy: false, httpProxy: "http://127.0.0.1:1" });
  assert.equal(audio.toString(), "ID3test-audio");
  assert.deepEqual(requests.at(-1), {
    path: "/v1/audio/speech", method: "POST", auth: "Bearer test-speech-key",
    body: { input: "你好", model: "gpt-4o-mini-tts", voice: "nova", instructions: "温柔地朗读", response_format: "mp3" },
  });
});

test("旧版 tts-1 不发送 instructions，日期版本 mini-tts 保留 instructions", async () => {
  await createSpeechAudio({ ...base, model: "tts-1-hd", instructions: "欢快" });
  assert.equal("instructions" in requests.at(-1).body, false);
  await createSpeechAudio({ ...base, model: "gpt-4o-mini-tts-2025-12-15", instructions: "欢快" });
  assert.equal(requests.at(-1).body.instructions, "欢快");
});

test("空文本、超长文本和当前模型不支持的音色在请求前拒绝", async () => {
  const count = requests.length;
  await assert.rejects(createSpeechAudio({ ...base, text: "  " }), /不能为空/);
  await assert.rejects(createSpeechAudio({ ...base, text: "中".repeat(4097) }), /4096/);
  await assert.rejects(createSpeechAudio({ ...base, model: "tts-1", voice: "marin" }), /不支持音色/);
  assert.equal(requests.length, count);
  assert.ok(getSpeechVoices("gpt-4o-mini-tts").includes("marin"));
  assert.ok(getSpeechVoices("tts-1").includes("nova"));
});

test("成功工具结果发送带 AI 标识的音频，失败结果不发送", async () => {
  const sent = [];
  const message = { send: async (payload) => sent.push(payload) };
  await sendSpeechToolResult(message, { ok: true, type: "audio", url: "https://example.invalid/voice.mp3", model: base.model, voice: "alloy" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].find((item) => item.type === "Audio").value, "https://example.invalid/voice.mp3");
  assert.match(sent[0].find((item) => item.type === "Text").value, /AI 合成语音/);
  await sendSpeechToolResult(message, { ok: false, error: "失败" });
  assert.equal(sent.length, 1);
});

test("空音频不会进入上传和发送流程", async () => {
  emptyResponse = true;
  try { await assert.rejects(createSpeechAudio(base), /空音频/); }
  finally { emptyResponse = false; }
});

test("可选 speed 写入请求；越界在请求前拒绝", async () => {
  await createSpeechAudio({ ...base, speed: 1.5 });
  assert.equal(requests.at(-1).body.speed, 1.5);
  const count = requests.length;
  await assert.rejects(createSpeechAudio({ ...base, speed: 0.1 }), /0\.25/);
  await assert.rejects(createSpeechAudio({ ...base, speed: 4.1 }), /4\.0/);
  assert.equal(requests.length, count);
});

test("一键 TTS 模型白名单与 SDK SpeechModel 对齐，拒绝 realtime", async () => {
  assert.deepEqual([...OPENAI_SPEECH_MODELS], [
    "tts-1",
    "tts-1-hd",
    "gpt-4o-mini-tts",
    "gpt-4o-mini-tts-2025-12-15",
  ]);
  assert.equal(validateSpeechModel("gpt-4o-mini-tts"), "gpt-4o-mini-tts");
  assert.equal(speechModelSupportsInstructions("gpt-4o-mini-tts"), true);
  assert.equal(speechModelSupportsInstructions("tts-1"), false);
  await assert.rejects(createSpeechAudio({ ...base, model: "gpt-4o-realtime-preview" }), /不支持的语音模型/);
  assert.throws(() => validateSpeechModel("gpt-4o-mini-realtime-preview"), /可用/);
  assert.match(listOpenAISpeechModelsText(), /gpt-4o-mini-tts/);
});
