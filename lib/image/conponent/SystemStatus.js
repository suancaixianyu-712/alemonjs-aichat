import React from 'react';
import { LinkStyleSheet } from 'jsxp';
import fileUrl from '../../assets/main.css.js';
import fileUrl$1 from '../../assets/bg-bottom.jpg.js';
import fileUrl$2 from '../../assets/bg-top.png.js';
import fileUrl$3 from '../../assets/biaotou.png.js';

const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
};
const formatDuration = (seconds) => {
    const value = Math.max(0, Math.floor(seconds));
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const parts = [];
    if (days > 0)
        parts.push(`${days}天`);
    if (hours > 0 || days > 0)
        parts.push(`${hours}小时`);
    parts.push(`${minutes}分钟`);
    return parts.join(" ");
};
const clampPercent = (value) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
function ProgressBar({ value }) {
    const percent = clampPercent(value);
    return (React.createElement("div", { className: "h-2.5 overflow-hidden rounded-full bg-[#3d477c99]" },
        React.createElement("div", { className: "h-full rounded-full bg-gradient-to-r from-[#90CDFD] to-[#E7C8BF]", style: { width: `${percent}%` } })));
}
function Section({ title, children, }) {
    return (React.createElement("section", { className: "rounded-xl border border-white/10 bg-[#7081d469] p-4 backdrop-blur-[2px]" },
        React.createElement("h2", { className: "mb-3 text-xl font-bold text-white" }, title),
        children));
}
function SystemStatus({ bot, status }) {
    return (React.createElement("html", null,
        React.createElement("head", null,
            React.createElement(LinkStyleSheet, { src: fileUrl })),
        React.createElement("body", { className: "m-0 min-h-screen text-[#e2e6f7]", style: {
                width: "900px",
                backgroundImage: `url(${fileUrl$1})`,
                backgroundSize: "100% auto",
                backgroundRepeat: "repeat-y",
            } },
            React.createElement("img", { src: fileUrl$2, className: "h-auto w-full", style: {
                    maskImage: "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
                    WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
                } }),
            React.createElement("main", { className: "relative -mt-[63%] px-7 pb-8" },
                React.createElement("header", { className: "mb-7 flex min-h-[250px] items-center justify-end gap-5 pr-5 pt-5" },
                    React.createElement("img", { src: bot.avatar || fileUrl$3, className: "h-24 w-24 rounded-full border-4 border-[#bac5f0] bg-[#7081d4] object-cover shadow-xl" }),
                    React.createElement("div", { className: "w-[390px]" },
                        React.createElement("div", { className: "text-sm tracking-[0.35em] text-[#bac5f0]" }, "SYSTEM STATUS"),
                        React.createElement("h1", { className: "mt-1 text-4xl font-bold text-[#F5F0E2]" }, bot.nickname),
                        React.createElement("div", { className: "mt-3 inline-flex rounded-md border border-[#bac5f0] bg-[#b8c3f886] px-3 py-1 text-white" }, "\u5F53\u524D\u8BBE\u5907\u8FD0\u884C\u72B6\u6001"))),
                React.createElement("div", { className: "grid grid-cols-2 gap-4" },
                    React.createElement(Section, { title: "\u8FD0\u884C\u65F6\u95F4" },
                        React.createElement("div", { className: "space-y-3" },
                            React.createElement("div", { className: "rounded-xl bg-[#b8c3f869] p-3" },
                                React.createElement("div", { className: "text-sm text-[#d5dcf4]" }, "\u673A\u5668\u4EBA\u8FD0\u884C\u65F6\u95F4"),
                                React.createElement("div", { className: "mt-1 text-2xl font-bold text-white" }, formatDuration(status.botUptime))),
                            React.createElement("div", { className: "rounded-xl bg-[#b8c3f869] p-3" },
                                React.createElement("div", { className: "text-sm text-[#d5dcf4]" }, "\u7CFB\u7EDF\u8FD0\u884C\u65F6\u95F4"),
                                React.createElement("div", { className: "mt-1 text-2xl font-bold text-white" }, formatDuration(status.systemUptime))))),
                    React.createElement(Section, { title: "\u5185\u5B58\u4F7F\u7528\u60C5\u51B5" },
                        React.createElement("div", { className: "rounded-xl bg-[#b8c3f869] p-3" },
                            React.createElement("div", { className: "flex items-end justify-between" },
                                React.createElement("span", { className: "text-3xl font-bold text-white" },
                                    clampPercent(status.memory.use).toFixed(1),
                                    "%"),
                                React.createElement("span", { className: "text-sm text-[#d5dcf4]" },
                                    formatBytes(status.memory.used),
                                    " /",
                                    " ",
                                    formatBytes(status.memory.total))),
                            React.createElement("div", { className: "mt-4" },
                                React.createElement(ProgressBar, { value: status.memory.use })))),
                    React.createElement(Section, { title: "\u6302\u8F7D\u76D8\u7B26\u5BB9\u91CF" },
                        React.createElement("div", { className: "space-y-3" }, status.disks.length > 0 ? (status.disks.map((disk) => (React.createElement("div", { key: `${disk.mount}-${disk.size}`, className: "rounded-xl bg-[#b8c3f869] p-3" },
                            React.createElement("div", { className: "mb-2 flex justify-between gap-4" },
                                React.createElement("span", { className: "font-bold text-white" }, disk.mount),
                                React.createElement("span", { className: "text-sm text-[#d5dcf4]" },
                                    formatBytes(disk.used),
                                    " / ",
                                    formatBytes(disk.size),
                                    " \u00B7",
                                    " ",
                                    clampPercent(disk.use).toFixed(1),
                                    "%")),
                            React.createElement(ProgressBar, { value: disk.use }))))) : (React.createElement("div", { className: "rounded-xl bg-[#b8c3f869] p-3" }, "\u6682\u65E0\u53EF\u7528\u6570\u636E")))),
                    React.createElement("div", { className: "space-y-4" },
                        React.createElement(Section, { title: "\u7D2F\u8BA1\u6D41\u91CF" },
                            React.createElement("div", { className: "grid grid-cols-2 gap-3" },
                                React.createElement("div", { className: "rounded-xl bg-[#b8c3f869] p-3" },
                                    React.createElement("div", { className: "text-sm text-[#d5dcf4]" }, "\u63A5\u6536"),
                                    React.createElement("div", { className: "mt-1 text-2xl font-bold text-white" }, formatBytes(status.network.received))),
                                React.createElement("div", { className: "rounded-xl bg-[#b8c3f869] p-3" },
                                    React.createElement("div", { className: "text-sm text-[#d5dcf4]" }, "\u53D1\u9001"),
                                    React.createElement("div", { className: "mt-1 text-2xl font-bold text-white" }, formatBytes(status.network.sent)))),
                            React.createElement("div", { className: "mt-2 text-xs text-[#cbd3ef]" }, "\u5F53\u524D\u6D3B\u52A8\u7F51\u5361\u81EA\u7CFB\u7EDF\u542F\u52A8\u4EE5\u6765\u7684\u7D2F\u8BA1\u503C")),
                        status.gpus.length > 0 && (React.createElement(Section, { title: "GPU \u4F7F\u7528\u60C5\u51B5" },
                            React.createElement("div", { className: "space-y-3" }, status.gpus.map((gpu, index) => (React.createElement("div", { key: `${gpu.name}-${index}`, className: "rounded-xl bg-[#b8c3f869] p-3" },
                                React.createElement("div", { className: "font-bold text-white" }, gpu.name),
                                React.createElement("div", { className: "mt-2 flex justify-between text-sm" },
                                    React.createElement("span", null,
                                        "\u4F7F\u7528\u7387",
                                        " ",
                                        gpu.utilization === null
                                            ? "暂不可读"
                                            : `${gpu.utilization.toFixed(1)}%`),
                                    gpu.memoryTotal !== null && gpu.memoryTotal > 0 && (React.createElement("span", null,
                                        "\u663E\u5B58",
                                        " ",
                                        formatBytes((gpu.memoryUsed ?? 0) * 1024 * 1024),
                                        " ",
                                        "/ ",
                                        formatBytes(gpu.memoryTotal * 1024 * 1024)))),
                                gpu.utilization !== null && (React.createElement("div", { className: "mt-2" },
                                    React.createElement(ProgressBar, { value: gpu.utilization })))))))))),
                    React.createElement("div", { className: "col-span-2" },
                        React.createElement(Section, { title: "\u7CFB\u7EDF\u4FE1\u606F" },
                            React.createElement("div", { className: "grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl bg-[#b8c3f869] p-4" },
                                React.createElement("div", null,
                                    React.createElement("span", { className: "text-[#cbd3ef]" }, "\u64CD\u4F5C\u7CFB\u7EDF\uFF1A"),
                                    React.createElement("span", { className: "text-white" }, status.system.os)),
                                React.createElement("div", null,
                                    React.createElement("span", { className: "text-[#cbd3ef]" }, "\u4E3B\u673A\u540D\uFF1A"),
                                    React.createElement("span", { className: "text-white" }, status.system.host)),
                                React.createElement("div", null,
                                    React.createElement("span", { className: "text-[#cbd3ef]" }, "\u8BBE\u5907\uFF1A"),
                                    React.createElement("span", { className: "text-white" }, status.system.device)),
                                React.createElement("div", null,
                                    React.createElement("span", { className: "text-[#cbd3ef]" }, "\u67B6\u6784\uFF1A"),
                                    React.createElement("span", { className: "text-white" }, status.system.arch)),
                                React.createElement("div", { className: "col-span-2" },
                                    React.createElement("span", { className: "text-[#cbd3ef]" }, "\u5904\u7406\u5668\uFF1A"),
                                    React.createElement("span", { className: "text-white" }, status.system.cpu))))))))));
}

export { SystemStatus as default };
