/**
 * 文本内嵌工具调用兜底。
 *
 * 部分模型（典型是 DeepSeek 的 DSML 格式，以及 Claude/Qwen 风格的 XML/JSON 标记）
 * 偶尔不会走 OpenAI 的结构化 tool_calls，而是把调用原文写进 content：
 *   <｜DSML｜function_calls><｜DSML｜invoke name="X"><｜DSML｜parameter name="k" string="true">v</｜DSML｜parameter>...
 * 中转/兼容层识别不了这种（尤其是变体如 `<｜｜DSML｜｜calls>`）时，tool_calls 为空，
 * 工具循环会认为模型已经给出最终回复，于是把原始标记当普通消息发出去，并就此结束本轮。
 *
 * 这里负责：
 * 1. 从文本中解析出工具调用，转成标准 tool_calls，让工具循环继续；
 * 2. 把工具调用标记从用户可见文本中剥离；
 * 3. 流式输出时拦住标记，不让它推到前端。
 */

// 竖线：ASCII | 、全角 ｜ (U+FF5C)，DeepSeek 实际用的是 ｜（有时重复两次）
const BAR = "[|｜\\u2223]";
// DSML 前缀：`｜DSML｜`、`｜｜DSML｜｜`、带空格等变体
const DSML_PREFIX = `(?:${BAR}+\\s*DSML\\s*${BAR}+\\s*)`;
// 标签名前缀：DSML 前缀或 antml/xml 命名空间前缀，均可选
const TAG_PREFIX = `(?:${DSML_PREFIX}|[a-z_]+:)?`;

/** 检测工具调用块起始（完整开标签） */
const BLOCK_START_RE = new RegExp(
  `<\\s*(?:${DSML_PREFIX}(?:function_?)?(?:calls|invoke)\\b|(?:[a-z_]+:)?function_calls\\b|tool_calls?\\b)`,
  "i",
);

const INVOKE_RE = new RegExp(
  `<\\s*${TAG_PREFIX}invoke\\s+name\\s*=\\s*["']([^"']+)["'][^>]*>([\\s\\S]*?)(?:<\\/\\s*${TAG_PREFIX}invoke\\s*>|(?=<\\s*${TAG_PREFIX}invoke\\b)|(?=<\\/\\s*${TAG_PREFIX}(?:function_?)?calls\\s*>)|$)`,
  "gi",
);

const PARAMETER_RE = new RegExp(
  `<\\s*${TAG_PREFIX}parameter\\s+name\\s*=\\s*["']([^"']+)["']([^>]*)>([\\s\\S]*?)<\\/\\s*${TAG_PREFIX}parameter\\s*>`,
  "gi",
);

const TOOL_CALL_JSON_RE = /<\s*tool_call\s*>([\s\S]*?)(?:<\/\s*tool_call\s*>|$)/gi;

export type TextToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const stripOneNewline = (value: string) =>
  value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");

const decodeEntities = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const parseParameterValue = (raw: string, attrs: string) => {
  const value = stripOneNewline(raw);
  const stringAttr = /string\s*=\s*["'](true|false)["']/i.exec(attrs)?.[1];
  if (stringAttr?.toLowerCase() === "true") return value;
  const trimmed = value.trim();
  if (stringAttr?.toLowerCase() === "false" || /^(?:[[{]|-?\d|true$|false$|null$)/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
};

/** 文本里是否含工具调用标记 */
export const hasTextToolCallMarkup = (text: unknown): boolean =>
  typeof text === "string" && BLOCK_START_RE.test(text);

/** 找到第一个工具调用块的起点；没有返回 -1 */
const findMarkupStart = (text: string): number => {
  const match = BLOCK_START_RE.exec(text);
  return match ? match.index : -1;
};

/**
 * 解析文本中的工具调用，返回剥离标记后的可见文本和标准 tool_calls。
 * 从第一个调用块起点到文本末尾全部视为工具调用区（模型在调用后不应再输出可见文本；
 * 截断/未闭合时也能一并清掉）。
 */
export const extractTextToolCalls = (
  text: unknown,
): { content: string; toolCalls: TextToolCall[]; hadMarkup: boolean } => {
  if (typeof text !== "string" || !text) {
    return { content: typeof text === "string" ? text : "", toolCalls: [], hadMarkup: false };
  }
  const start = findMarkupStart(text);
  if (start < 0) return { content: text, toolCalls: [], hadMarkup: false };

  const visible = text.slice(0, start).trimEnd();
  const markup = text.slice(start);
  const toolCalls: TextToolCall[] = [];
  const stamp = Date.now();
  const push = (name: string, args: unknown) => {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    toolCalls.push({
      id: `call_text_${stamp}_${toolCalls.length}`,
      type: "function",
      function: {
        name: cleanName,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    });
  };

  for (const invoke of markup.matchAll(INVOKE_RE)) {
    const args: Record<string, unknown> = {};
    for (const param of (invoke[2] || "").matchAll(PARAMETER_RE)) {
      args[param[1]] = parseParameterValue(decodeEntities(param[3]), param[2] || "");
    }
    push(invoke[1], args);
  }

  if (toolCalls.length === 0) {
    for (const block of markup.matchAll(TOOL_CALL_JSON_RE)) {
      try {
        const parsed = JSON.parse(block[1].trim());
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const name = item?.name ?? item?.function?.name;
          let args = item?.arguments ?? item?.parameters ?? item?.function?.arguments ?? {};
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              /* 保留原字符串 */
            }
          }
          push(name, args);
        }
      } catch {
        /* 无法解析的 tool_call 块直接丢弃 */
      }
    }
  }

  return { content: visible, toolCalls, hadMarkup: true };
};

/** 仅剥离工具调用标记（不解析） */
export const stripTextToolCallMarkup = (text: string): string =>
  extractTextToolCalls(text).content;

/**
 * 归一化一次模型回复：content 中有工具调用标记时剥离；
 * 若模型没给结构化 tool_calls 且允许调用工具，则把解析出的调用补成 tool_calls。
 * 原地修改并返回 message；hadMarkup 表示本次是否命中了文本工具标记。
 */
export const recoverTextToolCalls = (
  message: any,
  options: { allowToolCalls: boolean },
): { recovered: number; hadMarkup: boolean } => {
  if (!message || typeof message !== "object") return { recovered: 0, hadMarkup: false };
  const content = message.content;
  if (typeof content !== "string" || !hasTextToolCallMarkup(content)) {
    return { recovered: 0, hadMarkup: false };
  }
  const parsed = extractTextToolCalls(content);
  message.content = parsed.content;
  const hasNative = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (hasNative || !options.allowToolCalls || parsed.toolCalls.length === 0) {
    return { recovered: 0, hadMarkup: true };
  }
  message.tool_calls = parsed.toolCalls;
  return { recovered: parsed.toolCalls.length, hadMarkup: true };
};

/** 归一化 completion（choices[0].message） */
export const recoverCompletionTextToolCalls = (
  completion: any,
  options: { allowToolCalls: boolean },
) => recoverTextToolCalls(completion?.choices?.[0]?.message, options);

// 可能是标记起点的尾巴最长保留多少字符等待后续 delta
const MAX_HELD_TAIL = 48;

/**
 * 流式文本过滤器：一旦出现工具调用标记，后续 delta 全部吞掉；
 * 末尾可能是标记前缀（如 `<｜`）时先暂存，等确认不是再放出。
 */
export const createToolMarkupStreamFilter = (
  emit: (text: string) => void | Promise<void>,
) => {
  let pending = "";
  let suppressed = false;
  return {
    async push(text: string) {
      if (suppressed || !text) return;
      pending += text;
      const start = findMarkupStart(pending);
      if (start >= 0) {
        suppressed = true;
        const before = pending.slice(0, start);
        pending = "";
        if (before) await emit(before);
        return;
      }
      const lastLt = pending.lastIndexOf("<");
      let hold = 0;
      if (lastLt >= 0) {
        const tail = pending.slice(lastLt);
        if (!tail.includes(">") && tail.length <= MAX_HELD_TAIL) hold = tail.length;
      }
      const out = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
      if (out) await emit(out);
    },
    async flush() {
      if (suppressed) {
        pending = "";
        return;
      }
      const rest = pending;
      pending = "";
      if (rest && !hasTextToolCallMarkup(rest)) await emit(rest);
    },
    get suppressed() {
      return suppressed;
    },
  };
};

/** 文本工具标记解析失败时，提示模型改用标准函数调用重试 */
export const TEXT_TOOL_CALL_RETRY_PROMPT =
  "系统提示：你上一条回复把工具调用写成了文本标记（DSML/XML），系统无法执行，也不会发给用户。" +
  "如需调用工具，请直接使用标准函数调用（tool_calls）；如不需要工具，请直接给出最终回复，不要输出任何工具调用标记。";
