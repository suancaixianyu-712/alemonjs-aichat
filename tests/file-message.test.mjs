import assert from "node:assert/strict";
import { mock, test } from "node:test";

const moduleUrl = (name) => new URL(`../lib/${name}.js`, import.meta.url).href;
const state = { switch: "1", history: [], requests: [], actions: [], api: {}, uploadFails: false };
const overrides = {
  getAIConfig: async () => ({ host: "http://model", key: "test", model: "gpt-4o", systemPrompt: "" }),
  getFileMessageSwitch: async () => state.switch,
  getAIChatHistory: async () => [...state.history],
  addAIChatHistory: async (_g, message) => state.history.push(message),
  addAIChatHistoryBatch: async (_g, messages) => state.history.push(...messages),
  getAffectionLevelAll: async () => ({}),
  getAvailableTools: async () => [], getAllToolStatus: async () => ({}),
  getLoadedToolNames: async () => [], getAutoToolNames: async () => [], getToolUsage: async () => ({}),
  getToolSwitch: async () => "0", getToolSearchMode: async () => "dynamic",
  getCAPIContextLimit: async () => 100000,
  acquireAIToolLoop: async () => true, drainAIGuidanceMessages: async () => [],
  sanitizeChatMessages: (messages) => messages, isAIProxyEnabled: () => false,
};
mock.module(moduleUrl("config"), { defaultExport: new Proxy(overrides, {
  get: (target, key) => key in target ? target[key] : async () => null,
}), namedExports: { DEFAULT_CAPI_CONTEXT_LIMIT: 0 } });
mock.module(moduleUrl("redis"), { namedExports: { redis: {} } });
mock.module(moduleUrl("s3"), { namedExports: {
  uploadImageToR2: async () => {
    if (state.uploadFails) throw new Error("storage unavailable");
    return "https://files.example/image.webp";
  },
  uploadMediaToR2: async () => "https://files.example/document",
} });
mock.module(moduleUrl("api/tool-session-controller"), { namedExports: {
  toolSessionController: { handleMessage: async () => false, getCurrentTool: async () => null, getPermission: async () => null },
} });
mock.module("@alemonjs/onebot", { namedExports: { API: class {} } });
const realAlemon = await import("alemonjs");
mock.module("alemonjs", { namedExports: { ...realAlemon,
  useMessage: () => [{ send: async () => [] }],
  useClient: () => [{ send: async (request) => {
    state.actions.push(request);
    return state.api[request.action] ?? null;
  } }],
} });
const { default: ignored, ...realOpenAI } = await import("openai");
mock.module("openai", { namedExports: realOpenAI, defaultExport: class {
  constructor() { this.chat = { completions: { create: async (request) => {
    state.requests.push(request);
    return { choices: [{ message: { role: "assistant", content: "小咸鱼:已收到附件" } }] };
  } } }; }
} });
globalThis.onResponse = (_selects, handler) => handler;
globalThis.onSelects = (selects) => selects;
globalThis.format = (...items) => items;

const { collectFileMedia, resolveFileContent, formatFileBlock } = await import(moduleUrl("api/fileMessage"));
const { buildUserMessage } = await import(moduleUrl("response/zreply/getChatConfig"));
const { convertCapiMessagesToRapiInput } = await import(moduleUrl("response/zreply/rapi"));
const { default: handleMessage } = await import(moduleUrl("response/ai-chat/res"));
const { buildToolMessageContent } = await import(moduleUrl("api/tool-message-content"));

const url = "https://attachment.example";
mock.method(globalThis, "fetch", async (source) => {
  assert.ok(String(source).startsWith(url), "测试不能访问真实网络");
  if (source.endsWith("/missing")) return new Response(null, { status: 404 });
  return new Response(source.endsWith("/image") ? Buffer.from("image bytes") : "文件正文：测试内容");
});
const event = (media, extra = {}) => ({
  name: "private.message.create", guid: "file-test", Platform: "onebot", UserId: "123", IsMaster: true,
  nickname: "用户", bot: { user_id: "456", nickname: "小咸鱼" },
  msg: "", MessageText: "", value: {}, MessageMedia: media, ...extra,
});
const cfg = { config: { model: "gpt-4o" }, fileMessageSwitch: "1", complexOutputIsOpen: "0" };
const document = { Type: "file", FileName: "测试.txt", Url: `${url}/text` };

test("私聊离线文件无文字也进入 AI，内容保存在历史中，下一轮可见", async () => {
  state.history = []; state.requests = [];
  await handleMessage(event([document], { tag: "NOTICE_OFFLINE_FILE" }), () => {});
  assert.equal(state.requests.length, 1);
  assert.match(JSON.stringify(state.requests[0].messages), /测试.txt/);
  assert.match(JSON.stringify(state.history), /文件正文：测试内容/);
  await handleMessage(event([], { msg: "刚发的文件里有什么？" }), () => {});
  assert.equal(state.requests.length, 2);
  assert.match(JSON.stringify(state.requests[1].messages), /文件正文：测试内容/);
});

test("文件开关关闭时，纯文件不触发 AI，带文字不注入文件", async () => {
  state.switch = "0";
  const count = state.requests.length;
  try {
    await handleMessage(event([document]), () => {});
    assert.equal(state.requests.length, count);
    const result = await buildUserMessage(event([document], { msg: "你好" }), { ...cfg, fileMessageSwitch: "0" });
    assert.doesNotMatch(JSON.stringify(result), /文件正文|测试.txt/);
  } finally { state.switch = "1"; }
});

test("图片以文件发送时解析 FileId 及旧版 API 包装，CAPI 和 RAPI 都收到图片", async () => {
  state.api = { get_file: [{ code: 2000, data: { base64: Buffer.from("image bytes").toString("base64") } }] };
  const result = await buildUserMessage(event([{ Type: "file", FileName: "截图.jpg", FileId: "image-id" }]), cfg);
  assert.deepEqual(result.validImageUrls, ["https://files.example/image.webp"]);
  assert.equal(result.content[0].type, "image_url");
  const converted = convertCapiMessagesToRapiInput([result]);
  assert.ok(JSON.stringify(converted.input).includes("input_image"));
});

test("群上传文件：get_file 不支持时使用群文件链接接口", async () => {
  state.actions = []; state.api = { get_group_file_url: { url: `${url}/text` } };
  const result = await resolveFileContent({ Type: "file", FileName: "群文件.txt", FileId: "group-file" },
    event([], { name: "message.create", ChannelId: "789", value: { file: { busid: 102 } } }));
  assert.equal(result.kind, "text");
  assert.equal(state.actions.at(-1).action, "get_group_file_url");
  assert.equal(state.actions.at(-1).params.busid, 102);
});

test("图片 MimeType、对象存储失败回退，以及纯文本模型均保留可用附件", async () => {
  state.uploadFails = true;
  try {
    const input = event([{ Type: "file", FileName: "无扩展名截图", MimeType: "image/png", Url: `${url}/image` }]);
    const result = await buildUserMessage(input, cfg);
    assert.match(result.content[0].image_url.url, /^data:image\/png;base64,/);
    assert.doesNotMatch(result.rawMessage, /base64/);
    const textOnly = await buildUserMessage(input, { ...cfg, config: { model: "gpt-3.5-turbo" } });
    assert.equal(typeof textOnly.content, "string");
    assert.match(textOnly.content, /无扩展名截图/);
  } finally { state.uploadFails = false; }
});

test("下载失败仍标明已收到文件，超过上限明确报告，不伪称已提供图片", async () => {
  const result = await resolveFileContent({ FileName: "截图.jpg", Url: `${url}/missing` }, event([]));
  assert.match(formatFileBlock(result), /截图.jpg.*\n\(文件内容不可用/s);
  assert.doesNotMatch(formatFileBlock(result), /内容以图片形式提供/);
  const large = await resolveFileContent({ FileName: "big.zip", FileSize: 51 * 1024 * 1024 }, event([]));
  assert.match(large.error, /50 MB/);
});

test("框架媒体与原始消息段去重，引用附件和第三方工具复用解析", async () => {
  const input = event([document], {
    value: { message: [{ type: "file", data: { file_name: document.FileName, url: document.Url } }] },
    reply: { message: [{ type: "file", data: { file_name: "引用.txt", url: `${url}/reply` } }] },
  });
  assert.equal(collectFileMedia(input).length, 2);
  const result = await buildToolMessageContent(input);
  assert.equal(result.files.length, 2);
  assert.match(result.text, /引用.txt/);
});
