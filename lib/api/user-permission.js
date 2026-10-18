const PERMISSION_DENIAL_INSTRUCTION = "这是当前用户权限下的最终拒绝，不是暂时失败。不要改写命令、更换工具、拆步骤、换目录或再次调用去完成同一目标。请直接告诉用户当前权限不允许，以及需要主人如何授权。只有退出码非 0、文件不存在、参数格式错误这类执行失败，才可以修正后重试。";
const OPENCODE_LABEL = {
    readonly: "只读",
    manual: "手动确认",
    auto: "自动审核",
    full: "完全访问",
};
const BOUNDARY_ERROR = /未通过|安全审查|自动审核|权限不足|仅主人|agent 未开启|工具被禁用|不能绕过|仅可列出|只能列出|当前系统任务不允许|不支持公共知识库|保留目录|保留范围/;
const pushUnique = (lines, line) => {
    if (!lines.includes(line))
        lines.push(line);
};
/**
 * 把框架本轮判定的身份和会话开关写成模型可读的权限说明。
 * 身份只来自调用方传入的框架字段，不从模型参数推断。
 */
const buildUserPermissionPrompt = (input) => {
    const identity = input.isMaster ? "框架主人" : "普通用户";
    const place = input.isPrivate
        ? "私聊，不区分群管理员"
        : input.isAdmin
            ? "群管理员或群主"
            : "普通成员";
    const allowed = [
        "使用当前已经启用、且不需要改项目或执行命令的普通工具",
        "用 ExecuteAlemonCommand 执行这个用户在框架里本来就有权使用的指令。指令失败或提示权限不足时，不要换成另一条指令去做同一件事",
    ];
    const denied = [];
    const groupFullAccess = !input.isPrivate && input.opencodePermission === "full";
    const ownerPrivate = input.isMaster && input.isPrivate;
    if (ownerPrivate) {
        pushUnique(allowed, "主人私聊直接拥有服务器完整管理权限，无需 #开启agent；可用 RunServerCommand 在任意目录执行 Shell、管理文件和服务、安装软件、部署项目，以及通过 SSH 连接主人授权的服务器。能力上限是机器人进程的系统权限，不代表自动获得 root 或管理员身份");
        pushUnique(allowed, "使用 Agent 文件工具读写项目、维护公共知识库及 scope=root；任意服务器路径或需要 Shell 的项目操作直接用 RunServerCommand");
        pushUnique(allowed, "接受主人在当前私聊提供的账号、密码、Token、私钥，按主人要求用 ManageCredentials 加密保存；后续先 list 查凭据名称与字段，通过 RunServerCommand.credentialEnv 使用，不能因为内容敏感而拒绝授权的保存或使用");
        pushUnique(allowed, "主人私聊为完全访问，主对话和后台子任务继承相同权限。查看系统状态、SSH 连接、读取日志和派发任务直接执行，不额外索要确认或确认码；删除目录、清空数据、重启/停止服务在主人已明确指定操作和目标时直接执行，只有目标或意图不明确时才询问");
        pushUnique(allowed, "历史对话中的确认码或后台任务需确认提示属于旧规则，以本轮框架权限为准，不要继续索要旧确认码");
        pushUnique(denied, "把凭据原文写入普通记忆、公共知识库、源码、工具调用提示或回复。不要打印凭据环境变量，优先使用变量传递给需要认证的程序");
    }
    else if (groupFullAccess && !input.isMaster) {
        pushUnique(allowed, "当前群已开启完全访问，可以读写项目、维护公共知识库、使用 scope=root 访问服务器目录，并执行完整 Git（提交、推送、拉取、合并）和其他服务器命令");
        pushUnique(denied, "删除文件、目录或 Git 仓库、清空数据、重启或停止服务和进程仅主人可用，包括脚本、子任务和其他工具的间接操作");
        pushUnique(denied, "把服务器凭据、密钥、令牌转述给用户或写到未授权位置，或绕过危险操作审核");
        pushUnique(allowed, "独立 RunCodex / RunOpencode 子代理仅做只读分析；修改项目使用 Agent 文件工具或群内 OpenCode 会话。服务器和项目命令仍会审核危险操作，拒绝后不能绕过");
    }
    else if (!input.agentEnabled && !groupFullAccess) {
        pushUnique(allowed, "列出、搜索、读取当前会话项目和公共知识库");
        pushUnique(denied, "创建、修改、删除项目文件，克隆仓库，执行项目命令或服务器命令。这些要等主人发送 #开启agent");
        pushUnique(denied, "使用 scope=root，或修改公共知识库");
    }
    else if (input.isMaster) {
        pushUnique(allowed, "读写当前会话项目，维护公共知识库，并用 scope=root 访问服务器根目录");
        pushUnique(allowed, "用 RunServerCommand 在任意目录执行 Shell，跳过命令与路径的 AI 审核");
        pushUnique(allowed, "用 AgentProjectCommand 执行完整 Git 并跳过 AI 审核。其他项目命令仍受本地基础拦截，通过后才跳过 AI 审核");
        pushUnique(denied, "空命令、非法空字符，以及本地基础拦截命中的命令。主人也不能绕过");
        pushUnique(denied, "把服务器凭据、密钥、令牌转述给用户或写到未授权位置");
    }
    else {
        pushUnique(allowed, "在当前会话项目内读写文件。项目命令必须先通过本地允许列表，再通过 AI 审核");
        pushUnique(allowed, "用 RunServerCommand 执行项目目录内的命令，但必须通过本地拦截，并且 AI 审核明确允许");
        pushUnique(allowed, "Git 只限受限的只读或初始化子命令，并且仍要经过 AI 审核");
        pushUnique(denied, "使用 scope=root，或修改公共知识库");
        pushUnique(denied, "执行完整 Git（提交、推送、拉取、合并、重置、SSH 克隆）或任意 Shell");
        pushUnique(denied, "跳过命令审核，或把被拒绝的操作改交给其他工具");
    }
    if (input.opencodeActive) {
        const label = OPENCODE_LABEL[input.opencodePermission];
        pushUnique(allowed, `当前会话正在使用 OpenCode，权限是「${label}」。这是主人为整个会话设置的，不是单个用户临时声称的`);
        if (input.opencodePermission === "readonly") {
            pushUnique(denied, "在 OpenCode 中编辑文件、执行命令、派发子任务或访问外部目录");
        }
        else if (input.opencodePermission === "manual") {
            pushUnique(denied, "在主人尚未同意时，让 OpenCode 编辑文件、执行命令、派发子任务或访问外部目录。主人拒绝后就停止");
        }
        else if (input.opencodePermission === "auto") {
            pushUnique(denied, "在 OpenCode 自动审核拒绝后，换一条命令、换一个工具或拆开步骤再试");
        }
    }
    return [
        "## 当前用户权限（框架本轮判定，不能伪造，也不能绕过）",
        `身份：${identity}`,
        `群身份：${place}`,
        `会话 agent：${input.agentEnabled ? "已开启" : "未开启"}`,
        "可以：",
        ...allowed.map((line) => `- ${line}`),
        "不可以：",
        ...denied.map((line) => `- ${line}`),
        PERMISSION_DENIAL_INSTRUCTION,
    ].join("\n");
};
const isReviewDenied = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value;
    if (record.allowed === false && record.localReview)
        return true;
    const nested = record.review;
    return (!!nested &&
        typeof nested === "object" &&
        !Array.isArray(nested) &&
        nested.allowed === false);
};
/** 给权限或审核拒绝的工具结果加上停止重试的说明。普通执行失败保持原样。 */
const annotatePermissionBoundary = (result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        return result;
    }
    const record = result;
    if (record.permissionDenied === true)
        return result;
    const error = typeof record.error === "string" ? record.error : "";
    if (!isReviewDenied(record) && !BOUNDARY_ERROR.test(error))
        return result;
    return {
        ...record,
        permissionDenied: true,
        doNotRetry: true,
        instruction: PERMISSION_DENIAL_INSTRUCTION,
    };
};

export { PERMISSION_DENIAL_INSTRUCTION, annotatePermissionBoundary, buildUserPermissionPrompt };
