import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolMarkupStreamFilter,
  extractTextToolCalls,
  recoverCompletionTextToolCalls,
  stripTextToolCallMarkup,
} from "../lib/response/zreply/text-tool-calls.js";

// 用户现网复现：双竖线 DSML 变体，兼容层没解析成 tool_calls
const userRepro = `我查一下
<｜｜DSML｜｜calls>
<｜｜DSML｜｜invoke name="RunServerCommand">
<｜｜DSML｜｜parameter name="command" string="true">set -a; . /root/dsh/dsh-web.env; set +a
getcode=$(curl -s -o /tmp/w-get.out -w '%{http_code}' "$url"); echo "GET code=$getcode bytes=$(wc -c </tmp/w-get.out)"</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="reviewGuid" string="true">2</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="workingDirectory" string="true">/root</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜calls>`;

test("双竖线 DSML 调用解析为 tool_calls 并从正文剥离", () => {
  const { content, toolCalls, hadMarkup } = extractTextToolCalls(userRepro);
  assert.equal(hadMarkup, true);
  assert.equal(content, "我查一下");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "RunServerCommand");
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.reviewGuid, "2");
  assert.equal(args.workingDirectory, "/root");
  assert.match(args.command, /^set -a;/);
  assert.match(args.command, /wc -c <\/tmp\/w-get\.out\)"$/);
});

test("标准 DeepSeek DSML（单竖线 function_calls）+ string=false 走 JSON", () => {
  const text = `<｜DSML｜function_calls>
<｜DSML｜invoke name="Search">
<｜DSML｜parameter name="q" string="true">nodejs</｜DSML｜parameter>
<｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="Echo">
<｜DSML｜parameter name="opts" string="false">{"a":1}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜function_calls>`;
  const { content, toolCalls } = extractTextToolCalls(text);
  assert.equal(content, "");
  assert.deepEqual(toolCalls.map((c) => c.function.name), ["Search", "Echo"]);
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { q: "nodejs", limit: 5 });
  assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), { opts: { a: 1 } });
  assert.notEqual(toolCalls[0].id, toolCalls[1].id);
});

test("XML function_calls 与 <tool_call> JSON 也能解析", () => {
  const xml = extractTextToolCalls(
    `好的<function_calls><invoke name="A"><parameter name="x">1</parameter></invoke></function_calls>`,
  );
  assert.equal(xml.content, "好的");
  assert.deepEqual(JSON.parse(xml.toolCalls[0].function.arguments), { x: 1 });

  const json = extractTextToolCalls(`<tool_call>{"name":"B","arguments":{"y":"z"}}</tool_call>`);
  assert.equal(json.toolCalls[0].function.name, "B");
  assert.deepEqual(JSON.parse(json.toolCalls[0].function.arguments), { y: "z" });
});

test("截断的半截调用标记不会出现在可见文本", () => {
  assert.equal(
    stripTextToolCallMarkup("稍等\n<｜｜DSML｜｜calls>\n<｜｜DSML｜｜invoke name=\"X\">\n<｜｜DSML"),
    "稍等",
  );
  assert.equal(stripTextToolCallMarkup("普通回复 <好感+1>"), "普通回复 <好感+1>");
});

test("completion 无结构化 tool_calls 时补全；已有或禁用工具时只剥离", () => {
  const c1 = { choices: [{ message: { role: "assistant", content: userRepro } }] };
  assert.deepEqual(recoverCompletionTextToolCalls(c1, { allowToolCalls: true }), {
    recovered: 1,
    hadMarkup: true,
  });
  assert.equal(c1.choices[0].message.tool_calls[0].function.name, "RunServerCommand");
  assert.equal(c1.choices[0].message.content, "我查一下");

  const native = [{ id: "n1", type: "function", function: { name: "N", arguments: "{}" } }];
  const c2 = { choices: [{ message: { content: userRepro, tool_calls: native } }] };
  assert.equal(recoverCompletionTextToolCalls(c2, { allowToolCalls: true }).recovered, 0);
  assert.equal(c2.choices[0].message.tool_calls, native);
  assert.equal(c2.choices[0].message.content, "我查一下");

  const c3 = { choices: [{ message: { content: userRepro } }] };
  assert.equal(recoverCompletionTextToolCalls(c3, { allowToolCalls: false }).recovered, 0);
  assert.equal(c3.choices[0].message.tool_calls, undefined);
  assert.equal(c3.choices[0].message.content, "我查一下");
});

test("流式过滤：标记跨 delta 拆分也不会推给前端", async () => {
  const out = [];
  const filter = createToolMarkupStreamFilter((t) => out.push(t));
  const chunks = ["我查一下\n<", "｜｜DS", "ML｜｜calls>\n<｜｜DSML｜｜invoke name=\"X\">", "abc", "</｜｜DSML｜｜calls>"];
  for (const c of chunks) await filter.push(c);
  await filter.flush();
  assert.equal(out.join(""), "我查一下\n");
  assert.equal(filter.suppressed, true);

  const out2 = [];
  const f2 = createToolMarkupStreamFilter((t) => out2.push(t));
  for (const c of ["你好 <", "好感+1", "> 喵", " a<b"]) await f2.push(c);
  await f2.flush();
  assert.equal(out2.join(""), "你好 <好感+1> 喵 a<b");
});
