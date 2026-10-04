import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CODEX_SESSION_ID_RE, CodexSessionStore } from './codex-sessions.js';

const MAX_OUTPUT_CHARS = 24000;
const MAX_ACTIVITY_CHARS = 12000;
const MAX_STDERR_CHARS = 12000;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;
const activeRuns = [];
const truncateText = (text, max = MAX_OUTPUT_CHARS) => {
    const normalized = String(text || "");
    return normalized.length > max
        ? `${normalized.slice(0, max)}\n[输出过长已截断]`
        : normalized;
};
const stripAnsi = (text) => String(text || "").replace(
// eslint-disable-next-line no-control-regex
/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
const toErrorText = (value) => {
    if (typeof value === "string")
        return value;
    if (!value || typeof value !== "object")
        return "";
    const record = value;
    if (typeof record.message === "string")
        return record.message;
    if (typeof record.error === "string")
        return record.error;
    if (record.error && record.error !== value)
        return toErrorText(record.error);
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
};
const formatActivity = (item) => {
    const type = String(item.type || "");
    const status = item.status ? `（${String(item.status)}）` : "";
    if (type === "command_execution") {
        const command = Array.isArray(item.command)
            ? item.command.join(" ")
            : String(item.command || "");
        const exitCode = item.exit_code === undefined || item.exit_code === null
            ? ""
            : `，退出码 ${item.exit_code}`;
        return `执行命令${status}${exitCode}：${command}`;
    }
    if (type === "file_change") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const files = changes
            .map((change) => change?.path || change?.file || change?.filename)
            .filter(Boolean)
            .slice(0, 20);
        return `文件变更${status}${files.length ? `：${files.join("、")}` : ""}`;
    }
    if (type === "mcp_tool_call") {
        const server = item.server || item.server_name || "MCP";
        const tool = item.tool || item.tool_name || item.name || "工具";
        return `调用 ${server}/${tool}${status}`;
    }
    if (type === "web_search") {
        return `网页搜索${status}：${String(item.query || item.text || "")}`;
    }
    if (type === "plan") {
        return `更新计划${status}`;
    }
    return type && type !== "agent_message" && type !== "reasoning"
        ? `${type}${status}`
        : "";
};
const createJsonlResult = () => ({
    sessionId: null,
    output: "",
    activity: [],
    usage: null,
    error: null,
    invalidLines: 0,
    activityChars: 0,
    completed: false,
});
const appendActivity = (result, text) => {
    const normalized = truncateText(stripAnsi(text).trim(), 2000);
    if (!normalized || result.activityChars >= MAX_ACTIVITY_CHARS)
        return;
    const remaining = MAX_ACTIVITY_CHARS - result.activityChars;
    const value = normalized.slice(0, remaining);
    result.activity.push(value);
    result.activityChars += value.length;
};
const consumeJsonlLine = (result, line) => {
    const normalized = line.trim();
    if (!normalized)
        return;
    let event;
    try {
        event = JSON.parse(normalized);
        if (!event || typeof event !== "object" || Array.isArray(event)) {
            result.invalidLines += 1;
            return;
        }
    }
    catch {
        result.invalidLines += 1;
        return;
    }
    if (event.type === "thread.started" && event.thread_id) {
        result.sessionId = String(event.thread_id);
        return;
    }
    if (event.type === "turn.completed") {
        result.completed = true;
        result.usage =
            event.usage && typeof event.usage === "object" ? event.usage : null;
        return;
    }
    if (event.type === "turn.failed" || event.type === "error") {
        result.error =
            toErrorText(event.error || event.message || event) || "Codex 执行失败";
        return;
    }
    if (event.type !== "item.completed" || !event.item)
        return;
    const item = event.item;
    if (item.type === "agent_message" && typeof item.text === "string") {
        result.output = truncateText(stripAnsi(item.text).trim());
        return;
    }
    appendActivity(result, formatActivity(item));
};
const finalizeJsonlResult = (result) => ({
    sessionId: result.sessionId,
    output: result.output,
    activity: result.activity,
    usage: result.usage,
    error: result.error,
    invalidLines: result.invalidLines,
});
const parseCodexJsonl = (text) => {
    const result = createJsonlResult();
    for (const line of String(text || "").split(/\r?\n/)) {
        consumeJsonlLine(result, line);
    }
    return finalizeJsonlResult(result);
};
const buildCodexExecArgs = (input) => {
    const args = [
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "-C",
        input.projectPath,
    ];
    // --approve-for-me already selects workspace-write and conflicts with --sandbox.
    if (input.autoApprove === false)
        args.push("--sandbox", "read-only");
    else
        args.push("--approve-for-me");
    if (input.model?.trim())
        args.push("--model", input.model.trim());
    if (input.sessionId)
        args.push("resume", input.sessionId);
    args.push("--", input.useStdin ? "-" : input.prompt);
    return args;
};
const resolveNpmCommandShim = (file) => {
    try {
        const content = fs.readFileSync(file, "utf8");
        const match = content.match(/"([^"\r\n]*node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js)"/i);
        if (!match)
            return null;
        const script = match[1].replace(/%~?dp0%/gi, path.dirname(file));
        if (!fs.existsSync(script))
            return null;
        return { file: process.execPath, argsPrefix: [script] };
    }
    catch {
        return null;
    }
};
const commandFromPath = (file) => {
    const normalized = file.trim();
    if (!normalized)
        return null;
    if (/\.cmd$/i.test(normalized))
        return resolveNpmCommandShim(normalized);
    if (/\.js$/i.test(normalized)) {
        return { file: process.execPath, argsPrefix: [normalized] };
    }
    return { file: normalized, argsPrefix: [] };
};
const findWindowsCodexCommand = () => new Promise((resolve) => {
    execFile("where.exe", ["codex"], { windowsHide: true }, (error, stdout) => {
        if (error)
            return resolve(null);
        const files = String(stdout)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        for (const file of files.filter((item) => /\.exe$/i.test(item))) {
            const command = commandFromPath(file);
            if (command)
                return resolve(command);
        }
        for (const file of files.filter((item) => /\.cmd$/i.test(item))) {
            const command = commandFromPath(file);
            if (command)
                return resolve(command);
        }
        return resolve(null);
    });
});
const resolveCodexCommand = async (binary) => {
    const configured = String(process.env.CODEX_TOOL_BINARY || binary || "").trim();
    if (configured) {
        const command = commandFromPath(configured);
        if (!command) {
            throw new Error(`无法执行配置的 Codex 路径: ${configured}`);
        }
        return command;
    }
    if (process.platform === "win32") {
        const command = await findWindowsCodexCommand();
        if (command)
            return command;
    }
    return { file: "codex", argsPrefix: [] };
};
const registerActiveRun = (record) => {
    activeRuns.push(record);
    return () => {
        const index = activeRuns.indexOf(record);
        if (index !== -1)
            activeRuns.splice(index, 1);
    };
};
const terminateProcessTree = async (child) => {
    if (!child.pid || child.exitCode !== null)
        return false;
    if (process.platform === "win32") {
        await new Promise((resolve) => {
            execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
                if (error && child.exitCode === null)
                    child.kill();
                resolve();
            });
        });
        return true;
    }
    try {
        process.kill(-child.pid, "SIGTERM");
    }
    catch {
        child.kill("SIGTERM");
    }
    return true;
};
const abortCodexRuns = async (options) => {
    const targets = activeRuns.filter((run) => {
        if (options?.guid && run.guid !== options.guid)
            return false;
        if (options?.userID && run.userID !== options.userID)
            return false;
        if (options?.sessionId && run.sessionId !== options.sessionId)
            return false;
        return true;
    });
    let aborted = 0;
    for (const run of targets) {
        run.aborted = true;
        if (await terminateProcessTree(run.child))
            aborted += 1;
    }
    return { aborted };
};
const runCodexProcess = async (input) => {
    const result = createJsonlResult();
    const child = spawn(input.command.file, [...input.command.argsPrefix, ...input.args], {
        cwd: input.directory,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
    });
    const record = {
        guid: input.guid,
        userID: input.userID,
        sessionId: input.sessionId,
        directory: input.directory,
        child,
    };
    const unregister = registerActiveRun(record);
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;
    let sessionSave = Promise.resolve();
    let sessionSaveError = null;
    let startedSessionId = "";
    const consumeLine = (line) => {
        consumeJsonlLine(result, line);
        if (result.sessionId && result.sessionId !== startedSessionId) {
            startedSessionId = result.sessionId;
            record.sessionId = result.sessionId;
            const id = result.sessionId;
            sessionSave = sessionSave
                .then(() => input.onSessionStarted?.(id))
                .catch((error) => { sessionSaveError = toErrorText(error); });
        }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines)
            consumeLine(line);
        if (stdoutBuffer.length > 1024 * 1024) {
            result.invalidLines += 1;
            stdoutBuffer = "";
        }
    });
    child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_STDERR_CHARS) {
            stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
        }
    });
    const timeout = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(child);
    }, input.timeoutMs);
    try {
        const exit = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
            // CLI 提前退出时 stdin 可能产生 EPIPE，执行错误由进程事件回传。
            child.stdin.on("error", () => undefined);
            child.stdin.end(input.prompt, "utf8");
        });
        if (stdoutBuffer.trim())
            consumeLine(stdoutBuffer);
        await sessionSave;
        return {
            ...exit,
            timedOut,
            aborted: record.aborted === true,
            sessionSaveError,
            completed: result.completed,
            stderr: truncateText(stripAnsi(stderr).trim(), MAX_STDERR_CHARS),
            parsed: finalizeJsonlResult(result),
        };
    }
    finally {
        clearTimeout(timeout);
        unregister();
    }
};
const assertInsideDirectory = (root, directory) => {
    const relative = path.relative(root, directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Codex 工作目录超出允许范围，请在 codexTool.projectPath 内执行");
    }
};
const resolveWorkingDirectory = (input, configuredPath) => {
    let root = String(configuredPath || "").trim();
    if (!root && input.guid) {
        const guid = input.guid.trim();
        if (!guid || guid === "." || guid === ".." || /[\\/\0:]/.test(guid)) {
            throw new Error("当前聊天标识不能作为工作目录名");
        }
        const publicRoot = path.resolve(process.cwd(), "public");
        root = path.join(publicRoot, guid);
        fs.mkdirSync(root, { recursive: true });
        assertInsideDirectory(fs.realpathSync.native(publicRoot), fs.realpathSync.native(root));
    }
    const projectPath = String(input.projectPath || root || "").trim();
    if (!projectPath)
        throw new Error("projectPath(项目目录绝对路径) 不能为空");
    if (!path.isAbsolute(projectPath) || (root && !path.isAbsolute(root))) {
        throw new Error("Codex 工作目录必须是绝对路径");
    }
    if (root && (!fs.existsSync(root) || !fs.statSync(root).isDirectory())) {
        throw new Error(`配置的 Codex 工作目录不存在或不是目录: ${root}`);
    }
    if (!fs.existsSync(projectPath))
        throw new Error(`项目目录不存在: ${projectPath}`);
    if (!fs.statSync(projectPath).isDirectory())
        throw new Error(`项目路径不是目录: ${projectPath}`);
    const directory = fs.realpathSync.native(projectPath);
    if (root)
        assertInsideDirectory(fs.realpathSync.native(root), directory);
    return directory;
};
const runCodex = async (input = {}) => {
    let release;
    try {
        const action = input.action || "run";
        if (!["run", "listSessions", "switchSession"].includes(action)) {
            throw new Error("action 仅支持 run、listSessions 或 switchSession");
        }
        const prompt = String(input.prompt || "").trim();
        if (action === "run" && !prompt)
            throw new Error("prompt(要交给 Codex 的提示词) 不能为空");
        const requestedSessionId = String(input.sessionId || "").trim();
        if (requestedSessionId && !CODEX_SESSION_ID_RE.test(requestedSessionId)) {
            throw new Error("sessionId 不是有效的 Codex 会话 UUID");
        }
        if (input.newSession && requestedSessionId)
            throw new Error("newSession 和 sessionId 不能同时使用");
        const { getAiChatConfigValue } = await import('../config/app.js');
        const config = getAiChatConfigValue()?.codexTool || {};
        const directory = resolveWorkingDirectory(input, config.projectPath);
        const timeoutSeconds = Math.max(1, Math.min(Math.floor(Number(input.timeoutSeconds ?? config.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS));
        let store;
        if (input.guid) {
            const { redis } = await import('../redis.js');
            store = new CodexSessionStore(redis, input.guid, input.userID || "", directory);
        }
        if (action === "listSessions") {
            if (!store)
                throw new Error("查询会话需要当前聊天标识 guid");
            return {
                ok: true,
                action,
                directory,
                currentSessionId: (await store.current())?.id || null,
                sessions: await store.list(),
            };
        }
        if (store)
            release = await store.acquire(timeoutSeconds);
        if (action === "switchSession") {
            if (!store)
                throw new Error("切换会话需要当前聊天标识 guid");
            if (!requestedSessionId)
                throw new Error("切换会话必须提供 sessionId");
            const session = await store.select(requestedSessionId);
            return { ok: true, action, directory, sessionId: session.id, session };
        }
        const previous = store
            ? requestedSessionId
                ? await store.get(requestedSessionId)
                : input.newSession ? null : await store.current()
            : null;
        if (store && requestedSessionId && !previous) {
            throw new Error("未找到当前聊天、用户和工作目录下的 Codex 会话");
        }
        const sessionId = previous?.id || requestedSessionId;
        const model = String(input.model || config.model || previous?.model || "").trim();
        const autoApprove = input.autoApprove ?? config.autoApprove ?? true;
        const command = await resolveCodexCommand(config.binary);
        const saveSession = (id, status) => store?.save({ id, prompt, model: model || null, status });
        const run = await runCodexProcess({
            command,
            args: buildCodexExecArgs({
                prompt,
                sessionId: sessionId || undefined,
                projectPath: directory,
                model,
                autoApprove,
                useStdin: true,
            }),
            prompt,
            directory,
            timeoutMs: timeoutSeconds * 1000,
            guid: input.guid,
            userID: input.userID,
            sessionId: sessionId || undefined,
            onSessionStarted: (id) => Promise.resolve(saveSession(id, "running")),
        });
        const error = run.timedOut
            ? `Codex 运行超时(${timeoutSeconds}秒)，已终止任务`
            : run.aborted ? "Codex 任务已中止，可继续该会话恢复任务"
                : run.parsed.error || (run.code === 0 ? null
                    : run.stderr || `Codex 进程退出，退出码 ${run.code ?? "未知"}`) ||
                    (!run.completed ? "Codex 进程未返回任务完成事件" : null);
        const returnedSessionId = run.parsed.sessionId || sessionId || null;
        let sessionWarning = run.sessionSaveError;
        if (returnedSessionId) {
            try {
                await saveSession(returnedSessionId, run.aborted ? "stopped" : error ? "failed" : "completed");
            }
            catch (saveError) {
                sessionWarning = toErrorText(saveError);
            }
        }
        return {
            ok: !error,
            action,
            sessionId: returnedSessionId,
            resumed: Boolean(sessionId),
            directory,
            model: model || null,
            sandbox: autoApprove === false ? "read-only" : "workspace-write",
            usage: run.parsed.usage,
            output: run.parsed.output,
            activity: run.parsed.activity,
            error,
            ...(sessionWarning ? { warning: `执行结果已返回，但会话记录保存失败：${sessionWarning}` } : {}),
            message: error ? `Codex 执行失败：${error}`
                : `Codex 会话 ${returnedSessionId || "未知"} 已运行完成`,
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error?.code === "ENOENT"
                ? "未找到 Codex CLI，请先安装，或配置 codexTool.binary / CODEX_TOOL_BINARY"
                : error instanceof Error ? error.message : String(error),
        };
    }
    finally {
        if (release)
            await release().catch((error) => console.error("Codex 会话锁释放失败", error));
    }
};

export { abortCodexRuns, buildCodexExecArgs, parseCodexJsonl, runCodex };
