import React from 'react';
import fileUrl from '../../assets/main.css.js';
import help from '../../data/help.json.js';
import { LinkStyleSheet } from 'jsxp';
import fileUrl$1 from '../../assets/bg-bottom.jpg.js';
import fileUrl$2 from '../../assets/bg-top.png.js';
import fileUrl$3 from '../../assets/biaotou.png.js';

/**
 * @param param0
 * @returns
 */
function App() {
    return (React.createElement("html", null,
        React.createElement("head", null,
            React.createElement(LinkStyleSheet, { src: fileUrl })),
        React.createElement("body", { style: {
                backgroundImage: `url(${fileUrl$1})`,
                backgroundSize: "100% auto",
                backgroundRepeat: "repeat-y",
            } },
            React.createElement("img", { src: fileUrl$2, className: "w-full h-auto", style: {
                    maskImage: "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
                    WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
                } }),
            React.createElement("div", { className: "relative w-full -mt-[65%]" },
                React.createElement("div", { className: "flex pt-6 items-center gap-2" },
                    React.createElement("div", { className: "w-[50%]" }),
                    React.createElement("div", null,
                        React.createElement("div", { className: "flex items-center gap-4 text-[2.5rem] font-bold" },
                            React.createElement("span", { className: " text-[#F5F0E2]" },
                                React.createElement("span", { className: "text-[#E7C8BF]" }, "A"),
                                React.createElement("span", { className: "text-[#90CDFD]" }, "I"),
                                " \u804A\u5929\u63D2\u4EF6"),
                            React.createElement("img", { src: fileUrl$3, className: "h-14 pt-2" })),
                        React.createElement("div", { className: "flex border border-[#bac5f0] rounded-md py-0.5 px-2 mr-6 bg-[#b8c3f886] text-white text-sm" },
                            React.createElement("span", null, help.name),
                            React.createElement("span", { className: "pl-2 text-[#E7C8BF]" }, help.version),
                            React.createElement("span", { className: "pl-2 text-gray-200" }, "\u2022 by"),
                            React.createElement("span", { className: "pl-2 text-[#E7C8BF]" }, help.by)))),
                React.createElement("div", { className: "columns-2 gap-4 p-2" },
                    React.createElement("div", { className: "h-[26rem] break-inside-avoid" }),
                    help.list.map((g) => {
                        return (React.createElement("div", { className: "flex flex-col gap-2 border border-white/10 rounded-xl py-2 px-2 mr-6 mb-4 bg-[#7081d469] backdrop-blur-[2px] break-inside-avoid" },
                            React.createElement("div", { className: "text-white text-lg" }, g.group.title),
                            g.group.items.map((item) => (React.createElement("div", { className: "bg-[#b8c3f869] p-1.5 rounded-xl" },
                                React.createElement("div", { className: "text-white text-lg" }, item.cmd),
                                React.createElement("div", { className: "text-[#e2e6f7]" }, item.desc))))));
                    }))))));
}

export { App as default };
