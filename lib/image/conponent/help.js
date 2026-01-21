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
            React.createElement("h2", { className: "text-2xl text-white font-bold italic drop-shadow-md" }, help.title),
            React.createElement("div", { className: "flex gap-2 mb-4 text-white italic drop-shadow-md" },
                React.createElement("span", { className: "text-[#e8deba] " },
                    help.name,
                    " ",
                    help.version),
                " ",
                React.createElement("span", { className: "text-gray-400" }, "by"),
                " ",
                React.createElement("span", { className: "text-[#e8deba] " }, help.by)),
            help.list.map((item, index) => (React.createElement("div", { key: index, className: " border-b last:border-0 bg-black/60 rounded-lg overflow-hidden mb-4 text-white backdrop-blur-xs" },
                React.createElement("h2", { className: "p-4 text-lg font-semibold bg-black/30 border-b border-white/20" }, item.group.title),
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
