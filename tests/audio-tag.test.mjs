import assert from "node:assert/strict";
import { test } from "node:test";

/** 与 tools.ts extractAudios / cleanMessage 中 audio 规则保持一致 */
const extractAudios = (text) => {
  const result = [];
  const regex = /<audio=(.*?)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const url = match[1].trim();
    if (url) result.push(url);
  }
  return result;
};

const cleanMessageAudio = (text) =>
  text
    .replace(/<img=(.*?)>/g, "")
    .replace(/<audio=(.*?)>/g, "")
    .replace(/<command=(.*?)>/g, "")
    .replace(/<revoke=(.*?)>/g, "")
    .replace(/<at=(.*?)>/g, "")
    .replace(/!\[[^\]]+\]\([^\)]+\)/g, "")
    .trim();

test("extractAudios pulls trimmed urls from <audio=...> tags", () => {
  const text =
    "听这段<audio=https://r2img.ccxk.top/luohuajian.mp3> 还有 <audio= https://example.com/a.mp3 >";
  assert.deepEqual(extractAudios(text), [
    "https://r2img.ccxk.top/luohuajian.mp3",
    "https://example.com/a.mp3",
  ]);
});

test("extractAudios skips empty tags", () => {
  assert.deepEqual(extractAudios("x<audio=>y<audio=  >z"), []);
});

test("cleanMessage strips <audio=...> so it is not visible in Text", () => {
  const cleaned = cleanMessageAudio(
    "合成好了<audio=https://r2img.ccxk.top/luohuajian.mp3>",
  );
  assert.equal(cleaned, "合成好了");
  assert.equal(cleaned.includes("<audio="), false);
  assert.equal(cleaned.includes("https://"), false);
});

test("non-http audio urls are extractable but send path should skip them", () => {
  const urls = extractAudios(
    "本地<audio=./voice.mp3><audio=https://ok.example/a.mp3>",
  );
  assert.deepEqual(urls, ["./voice.mp3", "https://ok.example/a.mp3"]);
  const sendable = urls.filter((u) => /^https?:\/\//.test(u));
  assert.deepEqual(sendable, ["https://ok.example/a.mp3"]);
});

test("mixed img+audio: clean keeps prose only", () => {
  const cleaned = cleanMessageAudio(
    "看图<img=https://ex/a.png>听这段<audio=https://ex/a.mp3>完",
  );
  assert.equal(cleaned, "看图听这段完");
});
