import help from '../data/help.json.js';

const helpGroups = help.list.map(({ group }) => group);
const commonHelpItems = helpGroups
    .flatMap((group) => group.items)
    .filter((item) => item.common);
const HELP_PAGE_SIZE = 8;
const HELP_COMMAND_PATTERN = /^(?:\/|#)(?:ai)?(?:指令|帮助|菜单|功能)(?:\s+(.+?))?\s*$/i;
const helpCategoryCommand = (group, page = 1) => `/帮助 ${group.key}${page > 1 ? ` ${page}` : ""}`;
const normalizeCategory = (value) => value.replace(/\s+/g, "").toLowerCase();
const getHelpView = (query = "") => {
    const value = query.trim();
    if (!value || /^(首页|总览)$/.test(value))
        return { kind: "home" };
    const pageMatch = value.match(/^(.+?)\s+(\d+)$/);
    const category = pageMatch ? pageMatch[1] : value;
    const page = pageMatch ? Number(pageMatch[2]) : 1;
    const normalized = normalizeCategory(category);
    const group = /^\d+$/.test(category)
        ? helpGroups[Number(category) - 1]
        : helpGroups.find((group) => [group.key, group.title, ...group.aliases].some((alias) => normalizeCategory(alias) === normalized));
    if (!group) {
        return {
            kind: "error",
            message: `未找到分类「${category}」。\n可用分类：${helpGroups.map((group) => group.key).join("、")}\n格式：/帮助 分类 [页码]，例如 /帮助 聊天 或 /帮助 聊天 2。`,
        };
    }
    const pageCount = Math.ceil(group.items.length / HELP_PAGE_SIZE);
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
        return {
            kind: "error",
            message: `「${group.title}」共 ${pageCount} 页，请输入 1～${pageCount} 的页码。\n查看第一页：${helpCategoryCommand(group)}`,
        };
    }
    return {
        kind: "category",
        group,
        page,
        pageCount,
        items: group.items.slice((page - 1) * HELP_PAGE_SIZE, page * HELP_PAGE_SIZE),
    };
};
const getHelpText = (view) => {
    if (view.kind === "error")
        return view.message;
    if (view.kind === "home") {
        return [
            `${help.title} · 帮助首页`,
            "发送 /帮助 分类 查看指令，也可以使用分类编号。",
            ...helpGroups.map((group, index) => `${index + 1}. ${group.title}：${helpCategoryCommand(group)}\n   ${group.desc}`),
            "常用指令：",
            ...commonHelpItems.map((item) => `${item.cmd} — ${item.desc}`),
        ].join("\n");
    }
    return [
        `${view.group.title} · 第 ${view.page}/${view.pageCount} 页`,
        view.group.desc,
        ...view.items.map((item) => `${item.cmd}\n${item.desc}`),
        ...(view.page > 1
            ? [`上一页：${helpCategoryCommand(view.group, view.page - 1)}`]
            : []),
        ...(view.page < view.pageCount
            ? [`下一页：${helpCategoryCommand(view.group, view.page + 1)}`]
            : []),
        "返回首页：/帮助",
    ].join("\n\n");
};

export { HELP_COMMAND_PATTERN, HELP_PAGE_SIZE, commonHelpItems, getHelpText, getHelpView, helpCategoryCommand, helpGroups };
