import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const MAX_OUTPUT_CHARS = 24000;
const MAX_ACTIVITY_CHARS = 12000;
const MAX_STDERR_CHARS = 12000;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;
const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    args.push("--", input.prompt);
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
const resolveCodexCommand = async () => {
    let configured = String(process.env.CODEX_TOOL_BINARY || "").trim();
    if (!configured) {
        const { getAiChatConfigValue } = await import('../config/app.js');
        configured = String(getAiChatConfigValue()?.codexTool?.binary || "").trim();
    }
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
        stdio: ["ignore", "pipe", "pipe"],
    });
    const unregister = registerActiveRun({
        guid: input.guid,
        userID: input.userID,
        sessionId: input.sessionId,
        directory: input.directory,
        child,
    });
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines)
            consumeJsonlLine(result, line);
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
        });
        if (stdoutBuffer.trim())
            consumeJsonlLine(result, stdoutBuffer);
        return {
            ...exit,
            timedOut,
            stderr: truncateText(stripAnsi(stderr).trim(), MAX_STDERR_CHARS),
            parsed: finalizeJsonlResult(result),
        };
    }
    finally {
        clearTimeout(timeout);
        unregister();
    }
};
const runCodex = async (input = {}) => {
    const projectPath = String(input.projectPath || "").trim();
    if (!projectPath) {
        return { ok: false, error: "projectPath(项目目录绝对路径) 不能为空" };
    }
    const resolvedDir = path.resolve(projectPath);
    if (!fs.existsSync(resolvedDir)) {
        return { ok: false, error: `项目目录不存在: ${projectPath}` };
    }
    if (!fs.statSync(resolvedDir).isDirectory()) {
        return { ok: false, error: `项目路径不是目录: ${projectPath}` };
    }
    const prompt = String(input.prompt || "").trim();
    if (!prompt)
        return { ok: false, error: "prompt(要交给 Codex 的提示词) 不能为空" };
    const sessionId = String(input.sessionId || "").trim();
    if (sessionId && !CODEX_SESSION_ID_RE.test(sessionId)) {
        return { ok: false, error: "sessionId 不是有效的 Codex 会话 UUID" };
    }
    const timeoutSeconds = Math.max(1, Math.min(Number(input.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS));
    const command = await resolveCodexCommand();
    const run = await runCodexProcess({
        command,
        args: buildCodexExecArgs({
            prompt,
            sessionId: sessionId || undefined,
            projectPath: resolvedDir,
            model: input.model,
            autoApprove: input.autoApprove,
        }),
        directory: resolvedDir,
        timeoutMs: timeoutSeconds * 1000,
        guid: input.guid,
        userID: input.userID,
        sessionId: sessionId || undefined,
    });
    const error = run.timedOut
        ? `Codex 运行超时(${timeoutSeconds}秒)，已终止任务`
        : run.parsed.error ||
            (run.code === 0
                ? null
                : run.stderr || `Codex 进程退出，退出码 ${run.code ?? "未知"}`);
    return {
        ok: !error,
        action: "run",
        sessionId: run.parsed.sessionId || sessionId || null,
        directory: resolvedDir,
        model: input.model?.trim() || null,
        sandbox: input.autoApprove === false ? "read-only" : "workspace-write",
        usage: run.parsed.usage,
        output: run.parsed.output,
        activity: run.parsed.activity,
        error,
        message: error
            ? `Codex 执行失败：${error}`
            : `Codex 会话 ${run.parsed.sessionId || sessionId || "未知"} 已运行完成`,
    };
};

export { abortCodexRuns, buildCodexExecArgs, parseCodexJsonl, runCodex };
