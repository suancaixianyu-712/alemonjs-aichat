import React from 'react';
import fileUrl from '../../assets/main.css.js';
import help from '../../data/help.json.js';
import { LinkStyleSheet } from 'jsxp';
import fileUrl$1 from '../../assets/113574575_p0_master1200.jpg.js';

/**
 * @param param0
 * @returns
 */
function App() {
    return (React.createElement("html", null,
        React.createElement("head", null,
            React.createElement(LinkStyleSheet, { src: fileUrl })),
        React.createElement("body", { className: "bg-cover p-4", style: { backgroundImage: `url(${fileUrl$1})` } },
            React.createElement("div", { className: "relative mb-6" },
                React.createElement("div", { className: "absolute -left-4 -top-4 w-24 h-24 bg-purple-400/20 rounded-full blur-2xl -z-0" }),
                React.createElement("h2", { className: "relative text-3xl font-bold bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 bg-clip-text text-transparent drop-shadow-lg tracking-wide" }, help.title),
                React.createElement("div", { className: "mt-2 flex items-center gap-2" },
                    React.createElement("div", { className: "h-0.5 w-12 bg-gradient-to-r from-amber-400 to-purple-400 rounded-full" }),
                    React.createElement("div", { className: "h-0.5 w-20 bg-white/30 rounded-full" })),
                React.createElement("div", { className: "flex items-center gap-2 mt-3 text-sm" },
                    React.createElement("span", { className: "px-2 py-0.5 bg-amber-500/20 rounded-md text-amber-200 font-mono text-xs border border-amber-400/30" }, help.name),
                    React.createElement("span", { className: "text-amber-300 text-xs font-mono font-medium" }, help.version),
                    React.createElement("span", { className: "text-white/50 text-xs" }, "\u2022"),
                    React.createElement("span", { className: "text-white/60 text-xs" }, "by"),
                    React.createElement("span", { className: "text-amber-200 text-xs font-medium tracking-wide" }, help.by))),
            help.list.map((item, index) => (React.createElement("div", { key: index, className: " border-b last:border-0 bg-black/60 rounded-lg overflow-hidden mb-4 text-white backdrop-blur-xs" },
                React.createElement("div", { className: "p-4 bg-black/30 border-b border-white/20" },
                    React.createElement("p", { className: "text-lg font-semibold" }, item.group.title),
                    React.createElement("p", { className: "text-md mt-1" }, item.group.desc)),
                React.createElement("div", null, Array.from({
                    length: Math.ceil(item.group.items.length / 3),
                }).map((_, rowIndex) => {
                    const rowItems = item.group.items.slice(rowIndex * 3, rowIndex * 3 + 3);
                    return (React.createElement("div", { key: rowIndex, className: `flex flex-wrap ${rowIndex % 2 === 1 ? "bg-black/30" : ""}` }, Array.from({ length: 3 }).map((_, subIndex) => {
                        const subItem = rowItems[subIndex];
                        // 判断是否为最后一列
                        const isLastCol = subIndex === 2;
                        // 判断是否为最后一行
                        const isLastRow = rowIndex === Math.ceil(item.group.items.length / 3) - 1;
                        if (subItem) {
                            return (React.createElement("div", { key: subIndex, className: `w-1/3 p-4 box-border${isLastCol ? "" : " border-r border-white/20"}${isLastRow ? "" : " border-b border-white/20"}` },
                                React.createElement("div", { className: "text-[#B8AE8E]  font-bold text-lg" }, subItem.cmd),
                                React.createElement("div", null, subItem.desc)));
                        }
                        else {
                            // 空白格子
                            return (React.createElement("div", { key: subIndex, className: `w-1/3 p-2 box-border${isLastCol ? "" : " border-r border-white/20"}${isLastRow ? "" : " border-b border-white/20"}` }));
                        }
                    })));
                }))))))));
}

export { App as default };
