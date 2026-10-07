import assert from "node:assert/strict";
import test from "node:test";
import { shouldSuppressFollowupReply } from "../lib/response/zreply/followup-reply.js";

test("一分钟跟进忽略静默标记及其后的括号旁白", () => {
  assert.equal(
    shouldSuppressFollowupReply("小咸鱼:[]\n\n（主人在和别人讨论硬件，安静待着喵。）", "小咸鱼"),
    true,
  );
  assert.equal(
    shouldSuppressFollowupReply("小咸鱼:[]\n(还是在跟别人聊硬件)", "小咸鱼"),
    true,
  );
});

test("一分钟跟进忽略只有括号旁白的回复", () => {
  assert.equal(
    shouldSuppressFollowupReply("小咸鱼:（主人在回绿化带，不接话喵。）", "小咸鱼"),
    true,
  );
  assert.equal(shouldSuppressFollowupReply("(先不说话)\n（继续等待）", "小咸鱼"), true);
});

test("一分钟跟进保留正常回复中的括号", () => {
  assert.equal(
    shouldSuppressFollowupReply("小咸鱼:你说的是 NAS 吗？（可以详细说说配置。）", "小咸鱼"),
    false,
  );
  assert.equal(shouldSuppressFollowupReply("小咸鱼:好的", "小咸鱼"), false);
});
