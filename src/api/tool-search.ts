/** 动态工具加载：常驻少量工具 + search_tools 按需追加 schema */

export const SEARCH_TOOL_NAME = "search_tools";
export const SEARCH_TOOL_LIMIT_PER_TURN = 3;
export const MAX_TOOL_ROUNDS = 30;
export const ALWAYS_ON_TOOL_NAMES = ["LocalBrowser", "RunServerCommand"];
export const TOOL_DISABLED_REASON = "当前已关闭，无法使用";
export const TOOL_UNAVAILABLE_REASON = "当前会话不可用";
export const TOOL_ROUND_LIMIT_FALLBACK = "已达工具轮次上限，请缩小问题后重试";
export const SEARCH_LIMIT_MESSAGE = "搜索次数已达上限，请直接使用已加载的工具";
export const LOADED_TOOLS_TTL_SECONDS = 30 * 60;
export const AUTO_TOOLS_TTL_SECONDS = 60 * 60;
export const AUTO_TOOL_LIMIT = 3;
export const AUTO_TOOL_MIN_USES = 5;
export const TOOL_USAGE_DAYS = 7;

export type ToolSearchMode = "dynamic" | "full";

export const searchToolDefinition = {
  type: "function",
  function: {
    name: SEARCH_TOOL_NAME,
    description:
      "搜索当前可用的工具及其功能。query 为空或「全部」时列出所有工具简介；命中的可用工具会在下一次请求中加载",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "需要完成的操作",
        },
      },
      required: ["query"],
    },
  },
};

/** 每个工具的中文别名与 20 字以内简介（手写，不要截断 description） */
export const TOOL_META: Record<string, { summary: string; aliases: string[] }> = {
  MiniMaxVoice: { summary: "MiniMax 语音合成", aliases: ["语音", "配音", "说话", "音色", "朗读", "tts"] },
  GenerateSpeech: { summary: "OpenAI TTS 合成语音", aliases: ["语音", "说话", "朗读", "配音", "tts", "openai语音", "gpt语音", "自然语音", "gpt-4o-mini-tts"] },
  DsTtsSpeak: { summary: "DS官方朗读需浏览器", aliases: ["DS朗读", "深度求索语音", "ds朗读", "deepseek朗读", "贝壳", "白浪", "海星", "暗潮", "语音", "朗读", "tts"] },
  DsTtsStatus: { summary: "DS朗读浏览器状态", aliases: ["DS朗读状态", "ds朗读状态", "深度求索语音状态"] },
  ConvertToImageUrl: { summary: "图片转为可查看链接", aliases: ["图片", "看图", "链接", "直链"] },
  StableDiffusionGenerateImage: { summary: "SD 生成图片", aliases: ["图片", "生图", "画图", "绘画", "sd"] },
  StableDiffusionImageToPrompt: { summary: "SD 动漫图转提示词", aliases: ["图片", "反推", "提示词", "tag"] },
  DescribeImage: { summary: "识图/OCR 描述图片", aliases: ["识图", "看图", "图片", "ocr", "文字识别"] },
  GrokGenerateImage: { summary: "Grok 生成或编辑图片", aliases: ["图片", "生图", "画图", "绘画", "修图"] },
  GPTGenerateImage: { summary: "GPT 生成或编辑图片", aliases: ["图片", "生图", "画图", "绘画", "修图"] },
  getSKILLDetail: { summary: "获取技能详情", aliases: ["技能", "skill", "说明"] },
  AgentListWorkspaces: { summary: "列出 agent 工作目录", aliases: ["工作目录", "项目", "目录", "workspace"] },
  AgentCreateWorkspace: { summary: "创建 agent 工作目录", aliases: ["工作目录", "新建项目", "创建项目"] },
  AgentCloneRepository: { summary: "克隆公开 Git 仓库", aliases: ["克隆", "git", "仓库", "clone", "下载代码"] },
  AgentReviewProjectCommand: { summary: "审核项目命令安全性", aliases: ["审核", "命令", "安全"] },
  RunServerCommand: { summary: "在服务器执行运维指令", aliases: ["运行指令", "命令", "终端", "shell", "服务器", "运维", "docker", "pm2", "日志", "部署"] },
  AgentGitOperation: { summary: "查看/切换 Git 分支", aliases: ["git", "分支", "切换分支", "远端"] },
  AgentProjectCommand: { summary: "在工作目录执行项目命令", aliases: ["项目命令", "命令", "解压", "重命名", "构建", "npm"] },
  AgentReadFileLines: { summary: "读取文件指定行", aliases: ["读文件", "读取", "查看文件", "代码"] },
  AgentWriteFile: { summary: "写入或追加文件", aliases: ["写文件", "写入", "保存", "代码"] },
  AgentInsertFile: { summary: "在指定行前插入内容", aliases: ["插入", "改代码", "编辑文件"] },
  AgentReplaceFileRange: { summary: "替换文件中连续行", aliases: ["替换", "修改", "改代码", "编辑文件"] },
  AgentCreateFile: { summary: "创建新文件", aliases: ["新建文件", "创建文件", "写文件"] },
  AgentDeleteFile: { summary: "删除工作目录内文件", aliases: ["删除文件", "删除", "移除"] },
  AgentListFiles: { summary: "列出文件夹内文件", aliases: ["文件列表", "目录", "ls", "列出文件"] },
  AgentSearchFiles: { summary: "按名称和内容搜文件", aliases: ["搜索文件", "查找", "grep", "代码搜索"] },
  AgentUploadFileToR2: { summary: "上传文件到 R2 拿链接", aliases: ["上传", "r2", "外链", "分享文件", "发布文件"] },
  ReadRemoteFile: { summary: "按 URL 读取远程文件", aliases: ["读取文件", "下载", "附件", "远程文件", "url"] },
  GetCommand: { summary: "获取框架指令列表", aliases: ["指令列表", "帮助", "命令列表", "菜单"] },
  LocalBrowser: { summary: "本机浏览器搜索/访问网页", aliases: ["搜索", "联网", "上网", "网页", "浏览器", "百度", "谷歌", "新闻"] },
  ExecuteAlemonCommand: { summary: "执行 AlemonJS 指令", aliases: ["执行指令", "指令", "配置", "切换"] },
  SubscribeNextUserMessage: { summary: "订阅用户下一条发言", aliases: ["等待", "下一条", "稍后", "订阅"] },
  ScheduleAITask: { summary: "设置/查看定时 AI 任务", aliases: ["定时", "提醒", "闹钟", "计划任务", "稍后提醒"] },
  MemoryOperation: { summary: "读写长期记忆与归档", aliases: ["记忆", "记住", "回忆", "历史", "归档"] },
  ping: { summary: "检测主机是否可达", aliases: ["ping", "连通", "网络检测", "延迟"] },
  http_request: { summary: "发送 HTTP 请求", aliases: ["http", "接口", "api", "请求", "网页"] },
  getAlemonjsConfig: { summary: "获取框架配置", aliases: ["框架配置", "配置", "alemonjs"] },
  RunOpencode: { summary: "启动 opencode 服务", aliases: ["opencode", "编程", "写代码", "代码助手"] },
  RunCodex: { summary: "调用 Codex CLI 执行任务", aliases: ["codex", "编程", "写代码", "代码助手"] },
  XianyuGame: { summary: "咸鱼游戏：扫雷/五子棋", aliases: ["游戏", "扫雷", "五子棋", "玩"] },
  SubAgent: { summary: "派遣后台子 agent", aliases: ["子代理", "后台", "并行", "派遣", "agent"] },
};

const getName = (tool: any) => String(tool?.function?.name ?? "");

const tokenize = (text: string): string[] => {
  const lower = String(text || "").toLowerCase();
  const tokens = new Set<string>();
  for (const word of lower.match(/[a-z0-9_]+/g) ?? []) {
    if (word.length >= 2) tokens.add(word);
  }
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
};

export const isListAllQuery = (query: unknown) => {
  const q = String(query ?? "").trim().toLowerCase();
  return q === "" || q === "全部" || q === "所有" || q === "all";
};

export const scoreTool = (tool: any, query: string): number => {
  const name = getName(tool).toLowerCase();
  const q = String(query || "").toLowerCase().trim();
  if (!q) return 0;
  let score = 0;
  if (name === q) score += 100;
  const tokens = tokenize(q);
  for (const token of tokens) {
    if (/^[a-z0-9_]+$/.test(token) && name.includes(token)) score += 10;
  }
  const meta = TOOL_META[getName(tool)];
  for (const alias of meta?.aliases ?? []) {
    const a = alias.toLowerCase();
    if (q.includes(a)) score += 6;
    else if (tokenize(a).some((t) => t.length >= 2 && tokens.includes(t))) score += 3;
  }
  const descText = `${tool?.function?.description ?? ""} ${meta?.summary ?? ""} ${Object.keys(
    tool?.function?.parameters?.properties ?? {},
  ).join(" ")}`;
  const descTokens = new Set(tokenize(descText));
  for (const token of tokens) if (descTokens.has(token)) score += 1;
  return score;
};

export const SEARCH_SCORE_THRESHOLD = 3;

/** 搜索工具；availableNames 为本会话真实可用（开关打开且未被会话过滤）的工具名 */
export const searchTools = (
  allTools: any[],
  availableNames: Set<string>,
  query: unknown,
  disabledNames: Set<string> = new Set(),
) => {
  const describe = (name: string) =>
    availableNames.has(name)
      ? {}
      : { reason: disabledNames.has(name) ? TOOL_DISABLED_REASON : TOOL_UNAVAILABLE_REASON };
  const named = allTools.filter((tool) => getName(tool) && getName(tool) !== SEARCH_TOOL_NAME);
  if (isListAllQuery(query)) {
    return {
      mode: "list" as const,
      tools: named.map((tool) => ({
        name: getName(tool),
        brief: TOOL_META[getName(tool)]?.summary ?? "",
        available: availableNames.has(getName(tool)),
      })),
      loadNames: [] as string[],
    };
  }
  const hits = named
    .map((tool) => ({ tool, score: scoreTool(tool, String(query)) }))
    .filter((item) => item.score >= SEARCH_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ tool }) => ({
      name: getName(tool),
      description: TOOL_META[getName(tool)]?.summary || String(tool?.function?.description ?? "").trim(),
      available: availableNames.has(getName(tool)),
      ...describe(getName(tool)),
    }));
  return {
    mode: "search" as const,
    tools: hits,
    loadNames: hits.filter((hit) => hit.available).map((hit) => hit.name),
  };
};

/** 按近 7 天使用次数挑选自动常驻工具（只返回名字，开关在每次请求时再实时过滤） */
export const pickAutoAlwaysOnTools = (
  usage: Record<string, number>,
  availableNames: Set<string>,
  limit = AUTO_TOOL_LIMIT,
  minUses = AUTO_TOOL_MIN_USES,
) =>
  Object.entries(usage)
    .filter(
      ([name, count]) =>
        count >= minUses &&
        name !== SEARCH_TOOL_NAME &&
        !ALWAYS_ON_TOOL_NAMES.includes(name) &&
        availableNames.has(name),
    )
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);

/** 是否计入使用次数：执行成功且不是 search_tools */
export const shouldCountToolUsage = (name: string, result: any) =>
  name !== SEARCH_TOOL_NAME &&
  !(result && typeof result === "object" && result.ok === false);

/**
 * 本轮发送给模型的 tools。
 * 顺序：search_tools → 常驻（固定 + 自动，按名字排序，保持 prompt 缓存稳定）→ 按需加载（按加载顺序追加）。
 * 所有名字都会与实时可用工具（availableTools）取交集，关掉的工具立即剔除。
 */
export const buildTurnTools = (options: {
  mode: ToolSearchMode | string | null | undefined;
  availableTools: any[];
  loadedToolNames?: Iterable<string>;
  autoToolNames?: Iterable<string>;
  allowedToolNames?: Set<string> | null;
}) => {
  const allowed = options.allowedToolNames ?? null;
  const pass = (tool: any) => !allowed || allowed.has(getName(tool));
  if (options.mode === "full") return options.availableTools.filter(pass);
  const byName = new Map(
    options.availableTools.filter(pass).map((tool) => [getName(tool), tool]),
  );
  const alwaysOn = [...new Set([...ALWAYS_ON_TOOL_NAMES, ...(options.autoToolNames ?? [])])]
    .filter((name) => byName.has(name))
    .sort();
  const used = new Set(alwaysOn);
  const loaded = [...(options.loadedToolNames ?? [])].filter((name) => {
    if (used.has(name) || !byName.has(name)) return false;
    used.add(name);
    return true;
  });
  return [searchToolDefinition, ...[...alwaysOn, ...loaded].map((name) => byName.get(name))];
};

/** 只调用了 search_tools 的轮次不计入工具轮数上限 */
export const countsTowardToolRound = (toolCalls: any[]) =>
  toolCalls.some((call) => String(call?.function?.name ?? "") !== SEARCH_TOOL_NAME);

/** 达到轮数上限后，强制模型给出收尾回复 */
export const buildForcedFinalParams = (params: any) => {
  const next = { ...params };
  if (next.tools?.length || next.builtinTools?.length) next.tool_choice = "none";
  else delete next.tool_choice;
  return next;
};

/**
 * 工具轮数上限（capi/res 共用）：只调用 search_tools 的轮次不计数；
 * 达到上限后下一次请求强制 tool_choice:"none"，并丢弃回复中的工具调用，以收尾回复结束。
 */
export const createToolRoundGuard = (max = MAX_TOOL_ROUNDS) => {
  let count = 0;
  return {
    get count() {
      return count;
    },
    get reached() {
      return count >= max;
    },
    /** 记录一轮工具调用，返回当前计数 */
    record(toolCalls: any[]) {
      if (countsTowardToolRound(toolCalls)) count += 1;
      return count;
    },
    /** 下一次请求的参数：达到上限时强制收尾 */
    prepareParams(params: any) {
      return count >= max ? buildForcedFinalParams(params) : params;
    },
    /** 处理请求结果：达到上限时去掉工具调用，返回 true 表示应结束工具循环 */
    finishResponse(res: any) {
      if (count < max) return false;
      const message = res?.choices?.[0]?.message;
      if (!message) return true;
      const content = message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("")
            : "";
      res.choices[0].message = {
        ...message,
        tool_calls: undefined,
        ...(text.trim() ? {} : { content: TOOL_ROUND_LIMIT_FALLBACK }),
      };
      return true;
    },
  };
};

/** 每条用户消息内 search_tools 的执行器（含次数上限） */
export const createSearchToolRunner = (options: {
  allTools: any[];
  availableNames: Set<string>;
  disabledNames?: Set<string>;
  loadedToolNames: Set<string>;
  limit?: number;
}) => {
  let calls = 0;
  return (args: any) => {
    calls += 1;
    if (calls > (options.limit ?? SEARCH_TOOL_LIMIT_PER_TURN)) {
      return { ok: false, error: SEARCH_LIMIT_MESSAGE };
    }
    const result = searchTools(options.allTools, options.availableNames, args?.query, options.disabledNames);
    for (const name of result.loadNames) options.loadedToolNames.add(name);
    return result.mode === "list"
      ? { ok: true, tools: result.tools }
      : {
          ok: true,
          tools: result.tools,
          tip: result.tools.length
            ? "可用工具已加载，下一步可直接调用"
            : "未找到匹配工具，可换个说法或用「全部」列出所有工具",
        };
  };
};

/** 会话级存储接口（由 redisClient 实现），便于 capi/res 两条请求路径共用并在测试中替换 */
export interface TurnToolStore {
  getLoadedToolNames(guid: string): Promise<string[]>;
  setLoadedToolNames(guid: string, names: string[], ttlSeconds: number): Promise<void>;
  getAutoToolNames(guid: string): Promise<string[] | null>;
  setAutoToolNames(guid: string, names: string[], ttlSeconds: number): Promise<void>;
  getToolUsage(guid: string, days?: number): Promise<Record<string, number>>;
  incrementToolUsage(guid: string, toolName: string): Promise<void>;
}

/**
 * 每条用户消息的工具状态：本轮 tools、search_tools 执行（含次数上限）、已加载集合持久化、
 * 未加载工具兜底加入和成功调用计数。availableTools 为实时开关过滤后的工具列表。
 */
export const createTurnToolState = async (options: {
  guid: string;
  store: TurnToolStore;
  mode: ToolSearchMode | string | null | undefined;
  toolSwitch: string | null | undefined;
  availableTools: any[];
  allTools: any[];
  disabledToolNames?: Iterable<string>;
  allowedToolNames?: Set<string> | null;
}) => {
  const { guid, store } = options;
  const allowed = options.allowedToolNames ?? null;
  const isDynamic = options.mode !== "full";
  const loadedToolNames = new Set<string>(isDynamic ? await store.getLoadedToolNames(guid) : []);
  const availableNames = new Set<string>(
    options.availableTools.map(getName).filter((name) => name && (!allowed || allowed.has(name))),
  );
  let autoToolNames: string[] = [];
  if (isDynamic && options.toolSwitch === "1") {
    const cached = await store.getAutoToolNames(guid);
    if (cached) {
      autoToolNames = cached;
    } else {
      autoToolNames = pickAutoAlwaysOnTools(await store.getToolUsage(guid, TOOL_USAGE_DAYS), availableNames);
      await store.setAutoToolNames(guid, autoToolNames, AUTO_TOOLS_TTL_SECONDS);
    }
  }
  const save = async () => {
    if (isDynamic && loadedToolNames.size > 0) {
      await store.setLoadedToolNames(guid, [...loadedToolNames], LOADED_TOOLS_TTL_SECONDS);
    }
  };
  const runner = createSearchToolRunner({
    allTools: options.allTools,
    availableNames,
    disabledNames: new Set(options.disabledToolNames ?? []),
    loadedToolNames,
  });
  return {
    isDynamic,
    rounds: createToolRoundGuard(),
    loadedToolNames,
    autoToolNames,
    /** 是否由本模块处理该工具调用（dynamic 模式下的 search_tools） */
    handles: (name: string) => isDynamic && name === SEARCH_TOOL_NAME,
    getTurnTools: () =>
      buildTurnTools({
        mode: options.mode,
        availableTools: options.availableTools,
        loadedToolNames,
        autoToolNames,
        allowedToolNames: allowed,
      }),
    runSearchTools: async (args: any) => {
      const result = runner(args);
      await save();
      return result;
    },
    /** 工具实际执行后调用：兜底加入已加载集合 + 成功计数 */
    afterToolExecuted: async (name: string, result: any) => {
      if (isDynamic && availableNames.has(name) && !loadedToolNames.has(name)) {
        loadedToolNames.add(name);
        await save();
      }
      if (shouldCountToolUsage(name, result)) {
        await store.incrementToolUsage(guid, name).catch(() => undefined);
      }
    },
  };
};
