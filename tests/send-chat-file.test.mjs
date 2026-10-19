import assert from "node:assert/strict";
import { test, mock, after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "send-chat-file-"));
process.env.AICHAT_ATTACHMENT_DIR = directory;
after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
const sends = [];
let response = [{ code: 2000, data: { code: 200, data: { id: 123 } } }];
mock.module("alemonjs", { namedExports: {
  useClient: (event) => [{ sendFileMessage: async (options) => { sends.push({ event, options }); return response; } }],
  ResultCode: { Ok: 2000 },
} });
mock.module(new URL("../lib/api/fileMessage.js", import.meta.url).href, { namedExports: {
  fetchFileBuffer: async () => Buffer.from("remote bytes"),
} });
const { sendChatFile } = await import("../lib/api/send-chat-file.js");
const { saveAttachment } = await import("../lib/api/attachment-store.js");
const event = { name: "private.message.create", Platform: "scbbs", UserId: "12", guid: "test" };
const resolve = (name) => path.join(directory, name);

test("AI 将文字生成为文件，私聊和群聊目标来自真实会话", async () => {
  for (const input of [event, { ...event, name: "message.create", ChannelId: "8" }]) {
    const result = await sendChatFile({ content: "生成的正文", name: "结果.txt", attachmentEvent: input }, resolve);
    assert.equal(result.ok, true);
    const { options } = sends.at(-1);
    assert.equal(options.targetId, input.ChannelId || input.UserId);
    assert.equal(options.scope, input.ChannelId ? "group" : "private");
    assert.equal(Buffer.from(options.source.slice(9), "base64").toString(), "生成的正文");
  }
});

test("已有链接和本地文件走各自来源，附件只能从当前会话转发", async () => {
  await sendChatFile({ url: "https://example.invalid/a.pdf?sig=a%2Fb", attachmentEvent: event }, resolve);
  assert.equal(sends.at(-1).options.source, "https://example.invalid/a.pdf?sig=a%2Fb");
  await sendChatFile({ filePath: "out.txt", attachmentEvent: event }, resolve);
  assert.equal(sends.at(-1).options.source, resolve("out.txt"));
  const id = await saveAttachment(event, { FileName: "原附件.txt" }, Buffer.from("original"));
  await sendChatFile({ attachmentId: id, attachmentEvent: event }, resolve);
  assert.equal(sends.at(-1).options.name, "原附件.txt");
  await assert.rejects(sendChatFile({ attachmentId: id, attachmentEvent: { ...event, guid: "other" } }, resolve));
});

test("没有发送来源、多个来源、无效 URL 和平台警告都不能误报成功", async () => {
  for (const args of [{}, { url: "https://example.invalid/a", content: "abc" }, { content: "abc" }, { url: "file:///secret" }]) {
    await assert.rejects(sendChatFile({ ...args, attachmentEvent: event }, resolve));
  }
  await assert.rejects(sendChatFile({ url: "https://example.invalid/a", attachmentEvent: { ...event, Platform: "other" } }, resolve));
  for (const failed of [[], [{ code: 6000, data: null }], [{ code: 2000, data: { code: 403, data: null } }], [{ code: 2000, data: null }]]) {
    response = failed;
    await assert.rejects(sendChatFile({ content: "abc", name: "a.txt", attachmentEvent: event }, resolve));
  }
});
