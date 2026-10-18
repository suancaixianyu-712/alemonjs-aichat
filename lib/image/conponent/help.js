import React from 'react';
import fileUrl from '../../assets/main.css.js';
import help from '../../data/help.json.js';
import { LinkStyleSheet } from 'jsxp';
import fileUrl$1 from '../../assets/bg-bottom.jpg.js';
import fileUrl$2 from '../../assets/bg-top.png.js';
import fileUrl$3 from '../../assets/biaotou.png.js';
import { helpGroups, helpCategoryCommand, commonHelpItems, HELP_PAGE_SIZE } from '../../utils/help-menu.js';

const pageLink = (category, page = 1) => `?category=${encodeURIComponent(category)}&page=${page}`;
function Help({ view = { kind: "home" } }) {
    const isHome = view.kind === "home";
    return (React.createElement("html", { lang: "zh-CN", style: { width: 900 } },
        React.createElement("head", null,
            React.createElement("meta", { charSet: "utf-8" }),
            React.createElement("title", null, isHome ? "帮助首页" : view.group.title),
            React.createElement(LinkStyleSheet, { src: fileUrl })),
        React.createElement("body", { style: {
                color: "#f5f0e2",
                fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
                backgroundColor: "#172441",
                backgroundImage: `linear-gradient(#172441aa, #172441ee), url(${fileUrl$1})`,
                backgroundSize: "100% auto",
                backgroundRepeat: "repeat-y",
            } },
            React.createElement("main", { className: "p-6" },
                React.createElement("header", { className: "rounded-2xl border border-white/20 p-8 mb-5", style: {
                        backgroundImage: `linear-gradient(90deg, #172441f2, #17244188), url(${fileUrl$2})`,
                        backgroundSize: "100% auto",
                        backgroundPosition: "left top",
                    } },
                    React.createElement("div", { className: "flex items-center gap-3 text-sm text-[#bac5f0]" },
                        React.createElement("img", { src: fileUrl$3, className: "h-8 w-auto" }),
                        React.createElement("span", null, help.name),
                        React.createElement("span", null, help.version)),
                    React.createElement("h1", { className: "mt-3 text-4xl font-bold" }, isHome ? "AI 聊天 · 帮助首页" : view.group.title),
                    React.createElement("p", { className: "mt-3 text-lg text-[#d4dcf7]" }, isHome ? "先选分类，再看指令。" : view.group.desc),
                    React.createElement("div", { className: "mt-4 text-base text-[#90cdfd]" }, isHome
                        ? "发送 /帮助 分类，也可以输入分类编号，例如 /帮助 1"
                        : `第 ${view.page} / ${view.pageCount} 页 · 共 ${view.group.items.length} 条指令`)),
                isHome ? (React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "grid grid-cols-2 gap-3" }, helpGroups.map((group, index) => (React.createElement("a", { key: group.id, href: pageLink(group.key), className: "rounded-xl border border-white/15 p-4 block", style: { backgroundColor: "#243655e8", color: "inherit", textDecoration: "none" } },
                        React.createElement("div", { className: "flex items-center justify-between gap-2" },
                            React.createElement("h2", { className: "text-xl font-bold" },
                                React.createElement("span", { className: "text-[#90cdfd] mr-2" }, String(index + 1).padStart(2, "0")),
                                group.title),
                            React.createElement("span", { className: "text-sm text-[#bac5f0]" },
                                group.items.length,
                                " \u6761")),
                        React.createElement("p", { className: "mt-2 text-base text-[#d4dcf7]" }, group.desc),
                        React.createElement("div", { className: "mt-3 text-lg text-[#90cdfd] font-bold" }, helpCategoryCommand(group)))))),
                    React.createElement("section", { className: "mt-5 rounded-xl border border-white/15 p-4", style: { backgroundColor: "#243655e8" } },
                        React.createElement("h2", { className: "text-xl font-bold mb-3" }, "\u5E38\u7528\u6307\u4EE4"),
                        React.createElement("div", { className: "grid grid-cols-2 gap-3" }, commonHelpItems.map((item) => (React.createElement("div", { key: item.cmd },
                            React.createElement("div", { className: "text-lg text-[#90cdfd] font-bold" }, item.cmd),
                            React.createElement("div", { className: "mt-1 text-sm text-[#d4dcf7]" }, item.desc)))))))) : (React.createElement(React.Fragment, null,
                    React.createElement("section", { className: "flex flex-col gap-3" }, view.items.map((item, index) => (React.createElement("div", { key: item.cmd, className: "rounded-xl border border-white/15 p-4", style: { backgroundColor: "#243655e8" } },
                        React.createElement("div", { className: "flex gap-3 items-start" },
                            React.createElement("span", { className: "text-sm text-[#bac5f0] pt-1" }, String((view.page - 1) * HELP_PAGE_SIZE + index + 1).padStart(2, "0")),
                            React.createElement("div", { className: "min-w-0" },
                                React.createElement("div", { className: "text-[22px] leading-8 font-bold text-[#90cdfd] break-words" }, item.cmd),
                                React.createElement("p", { className: "mt-2 text-lg leading-7 text-[#d4dcf7] break-words" }, item.desc))))))),
                    React.createElement("nav", { className: "mt-5 flex flex-wrap gap-3" },
                        view.page > 1 && (React.createElement("a", { href: pageLink(view.group.key, view.page - 1), className: "rounded-xl bg-white/10 px-4 py-3 text-lg text-[#90cdfd]" },
                            "\u4E0A\u4E00\u9875\uFF1A",
                            helpCategoryCommand(view.group, view.page - 1))),
                        view.page < view.pageCount && (React.createElement("a", { href: pageLink(view.group.key, view.page + 1), className: "rounded-xl bg-white/10 px-4 py-3 text-lg text-[#90cdfd]" },
                            "\u4E0B\u4E00\u9875\uFF1A",
                            helpCategoryCommand(view.group, view.page + 1))),
                        React.createElement("a", { href: "?", className: "rounded-xl bg-white/10 px-4 py-3 text-lg text-[#90cdfd]" }, "\u8FD4\u56DE\u9996\u9875\uFF1A/\u5E2E\u52A9")))),
                React.createElement("footer", { className: "mt-5 text-center text-sm text-[#bac5f0]" }, "/ \u548C # \u5747\u53EF\u4F7F\u7528 \u00B7 \u5F00\u542F|\u5173\u95ED \u8868\u793A\u4E8C\u9009\u4E00 \u00B7 \u6743\u9650\u8981\u6C42\u89C1\u5404\u6307\u4EE4\u8BF4\u660E")))));
}

export { Help as default };
