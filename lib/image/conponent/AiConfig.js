import React from 'react';
import fileUrl from '../../assets/main.css.js';
import help from '../../data/help.json.js';
import { LinkStyleSheet } from 'jsxp';
import fileUrl$1 from '../../assets/113574575_p0_master1200.jpg.js';

const cmds = [
    { cmd: "/切换AI <AI名称>", desc: "切换当前使用的AI模型" },
    { cmd: "/切换模型 <模型名称>", desc: "切换当前使用的AI模型" },
    { cmd: "/<开启|关闭>仅艾特触发", desc: "开启或关闭仅艾特触发功能" },
    { cmd: "/<开启|关闭>工具", desc: "开启或关闭AI工具" },
    { cmd: "/<开启|关闭>工具调用内容", desc: "开启或关闭工具调用前内容发送" },
    { cmd: "/设置AI上下文长度 256k", desc: "设置CAPI自动压缩上下文长度" },
    { cmd: "/<开启|关闭>复杂输出", desc: "开启或关闭复杂输出" },
    { cmd: "/<开启|关闭>好感度", desc: "开启或关闭好感度系统" },
    { cmd: "/清空对话", desc: "清空当前对话历史" },
];
const SkillItem = ({ name, description, }) => {
    return (React.createElement("div", { className: "rounded-lg bg-white/5 border border-white/10 px-3 py-2" },
        React.createElement("div", { className: "font-mono text-sm font-semibold text-cyan-200" }, name),
        React.createElement("div", { className: "mt-1 text-xs leading-relaxed text-white/70" }, description || "暂无描述")));
};
const StatusItem = ({ label, value, isDeep, }) => {
    const getStatusStyle = () => {
        if (isDeep && value === "默认") {
            return "bg-yellow-500/20 text-yellow-300 border-yellow-500/30";
        }
        if (value) {
            return "bg-green-500/20 text-green-300 border-green-500/30";
        }
        return "bg-red-500/10 text-red-300 border-red-500/20";
    };
    return (React.createElement("div", { className: "flex items-center justify-between py-2 px-2 rounded-lg bg-white/5" },
        React.createElement("span", { className: " text-white/70" }, label),
        React.createElement("span", { className: `px-3 py-0.5 rounded-full text-xs font-mono font-medium border ${getStatusStyle()}` }, isDeep && value === "默认" ? "默认" : value ? "开启" : "关闭")));
};
/**
 * @param param0
 * @returns
 */
function App(data) {
    return (React.createElement("html", null,
        React.createElement("head", null,
            React.createElement(LinkStyleSheet, { src: fileUrl })),
        React.createElement("body", { className: "bg-cover p-4", style: { backgroundImage: `url(${fileUrl$1})`, width: "800px" } },
            React.createElement("div", { className: "relative mb-6" },
                React.createElement("div", { className: "absolute -left-4 -top-4 w-24 h-24 bg-purple-400/20 rounded-full blur-2xl -z-0" }),
                React.createElement("h2", { className: "relative text-3xl font-bold bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 bg-clip-text text-transparent drop-shadow-lg tracking-wide" }, "AI\u914D\u7F6E\u8BE6\u60C5"),
                React.createElement("div", { className: "mt-2 flex items-center gap-2" },
                    React.createElement("div", { className: "h-0.5 w-12 bg-gradient-to-r from-amber-400 to-purple-400 rounded-full" }),
                    React.createElement("div", { className: "h-0.5 w-20 bg-white/30 rounded-full" })),
                React.createElement("div", { className: "flex items-center gap-2 mt-3 " },
                    React.createElement("span", { className: "px-2 py-0.5 bg-amber-500/20 rounded-md text-amber-200 font-mono text-xs border border-amber-400/30" }, help.name),
                    React.createElement("span", { className: "text-amber-300 text-xs font-mono font-medium" }, help.version),
                    React.createElement("span", { className: "text-white/50 text-xs" }, "\u2022"),
                    React.createElement("span", { className: "text-white/60 text-xs" }, "by"),
                    React.createElement("span", { className: "text-amber-200 text-xs font-medium tracking-wide" }, help.by))),
            React.createElement("div", { className: "bg-gradient-to-br from-gray-900/90 to-black/80 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl overflow-hidden mb-4 text-white" },
                React.createElement("div", { className: "px-5 py-3 bg-white/5 border-b border-white/10 backdrop-blur-sm" },
                    React.createElement("p", { className: "text-base font-medium tracking-wide flex items-center gap-2" },
                        React.createElement("span", { className: "w-1.5 h-1.5 bg-cyan-400 rounded-full" }),
                        "\u6280\u80FD\u5217\u8868")),
                React.createElement("div", { className: "p-5" }, data.skillList.length ? (React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3" }, data.skillList.map((skill) => (React.createElement(SkillItem, { key: `skill-${skill.name}`, name: skill.name, description: skill.description }))))) : (React.createElement("span", { className: " text-white/40 italic" }, "\u6682\u65E0\u6280\u80FD\u914D\u7F6E")))),
            React.createElement("div", { className: "bg-gradient-to-br from-gray-900/90 to-black/80 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl overflow-hidden mb-4 text-white" },
                React.createElement("div", { className: "px-5 py-3 bg-white/5 border-b border-white/10 backdrop-blur-sm" },
                    React.createElement("p", { className: "text-base font-medium tracking-wide flex items-center gap-2" },
                        React.createElement("span", { className: "w-1.5 h-1.5 bg-blue-400 rounded-full" }),
                        "\u5F53\u524DAI\u914D\u7F6E")),
                React.createElement("div", { className: "p-5 space-y-3" },
                    React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3" },
                        React.createElement(StatusItem, { label: "\u603B\u5F00\u5173", value: data.switch }),
                        React.createElement(StatusItem, { label: "\u590D\u6742\u8F93\u51FA", value: data.complex }),
                        React.createElement(StatusItem, { label: "\u597D\u611F\u5EA6\u5F00\u5173", value: data.affection }),
                        React.createElement(StatusItem, { label: "\u8BED\u97F3\u56DE\u590D\u5F00\u5173", value: data.tts }),
                        React.createElement(StatusItem, { label: "\u6DF1\u5EA6\u601D\u8003", value: data.deep, isDeep: true }),
                        React.createElement(StatusItem, { label: "\u4EC5\u827E\u7279\u89E6\u53D1", value: data.atTrigger })),
                    React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-white/10 pt-2" },
                        React.createElement(StatusItem, { label: "\u5DE5\u5177\u603B\u5F00\u5173", value: data.tools }),
                        React.createElement(StatusItem, { label: "\u5DE5\u5177\u63D0\u793A", value: data.toolPromptSwitch }),
                        React.createElement(StatusItem, { label: "\u5DE5\u5177\u63D0\u793A\u64A4\u56DE", value: data.toolPromptRevokeSwitch }),
                        React.createElement(StatusItem, { label: "\u5DE5\u5177\u63D0\u793A\u4F20\u53C2", value: data.toolPromptArgsSwitch }),
                        React.createElement(StatusItem, { label: "\u5DE5\u5177\u8C03\u7528\u5185\u5BB9", value: data.toolCallContentSwitch }),
                        React.createElement("div", { className: "flex items-center justify-between py-2 px-2 rounded-lg bg-white/5" },
                            React.createElement("span", { className: " text-white/70" }, "CAPI\u4E0A\u4E0B\u6587\u957F\u5EA6"),
                            React.createElement("span", { className: "px-3 py-0.5 rounded-full text-xs font-mono font-medium border bg-cyan-500/20 text-cyan-300 border-cyan-500/30" }, data.capiContextLimit))),
                    React.createElement("div", { className: "pt-2 border-t border-white/10" },
                        React.createElement("div", { className: "flex items-center justify-between py-2" },
                            React.createElement("span", { className: " text-white/60" }, "\u5F53\u524D\u4F7F\u7528\u6A21\u578B"),
                            React.createElement("span", { className: "px-3 py-1 bg-blue-500/20 rounded-full  font-mono text-blue-300 border border-blue-500/30" },
                                data.currentAI || "无法获取",
                                " / ",
                                data.model || "未设置")),
                        React.createElement("div", { className: "py-2" },
                            React.createElement("div", { className: " text-white/60 mb-1" }, "\u63D0\u793A\u8BCD"),
                            React.createElement("div", { className: "px-3 py-2 bg-white/5 rounded-lg  text-white/80 border border-white/10" }, data.prompt || "未设置")),
                        React.createElement("div", { className: "py-2" },
                            React.createElement("div", { className: " text-white/60 mb-2" }, "AI\u5217\u8868"),
                            React.createElement("div", { className: "flex flex-wrap gap-2" }, data.aiList.length ? (data.aiList.map((ai, idx) => (React.createElement("span", { key: idx, className: "px-2.5 py-1 text-xs rounded-full bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-200 border border-purple-400/30 backdrop-blur-sm font-medium" }, ai)))) : (React.createElement("span", { className: " text-white/40 italic" }, "\u6682\u65E0AI\u914D\u7F6E"))))))),
            React.createElement("div", { className: "bg-gradient-to-br from-gray-900/90 to-black/80 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl overflow-hidden mb-4 text-white" },
                React.createElement("div", { className: "px-5 py-3 bg-white/5 border-b border-white/10 backdrop-blur-sm" },
                    React.createElement("p", { className: "text-base font-medium tracking-wide flex items-center gap-2" },
                        React.createElement("span", { className: "w-1.5 h-1.5 bg-green-400 rounded-full" }),
                        "\u5DE5\u5177\u5217\u8868")),
                React.createElement("div", { className: "p-5 space-y-3" },
                    React.createElement("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3" }, Object.entries(data.toolList).length ? (Object.entries(data.toolList).map(([tool, status]) => (React.createElement(StatusItem, { key: `tool-${tool}`, label: tool, value: status === "0" })))) : (React.createElement("span", { className: " text-white/40 italic" }, "\u6682\u65E0\u5DE5\u5177\u914D\u7F6E"))))),
            React.createElement("div", { className: "bg-gradient-to-br from-gray-900/90 to-black/80 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl overflow-hidden mb-4" },
                React.createElement("div", { className: "px-5 py-3 bg-white/5 border-b border-white/10 backdrop-blur-sm" },
                    React.createElement("p", { className: "text-base font-semibold tracking-wide flex items-center gap-2" },
                        React.createElement("span", { className: "w-1.5 h-1.5 bg-amber-400 rounded-full shadow-glow" }),
                        React.createElement("span", { className: "text-amber-100" }, "\u63A8\u8350\u6307\u4EE4"))),
                React.createElement("div", { className: "p-5" },
                    React.createElement("div", { className: "grid grid-cols-1 md:grid-cols-2 auto-rows-auto" },
                        cmds.map((item, idx) => {
                            const isLastInRow = (idx + 1) % 2 === 0 || idx === cmds.length - 1;
                            const isSecondCol = idx % 2 === 1;
                            return (React.createElement("div", { key: idx, className: `relative flex flex-col gap-1.5 p-4 transition-colors hover:bg-white/5
              ${isSecondCol ? "md:border-l border-white/10" : ""}
              ${idx >= 2 ? "border-t border-white/10" : ""}
              ${isLastInRow && idx < cmds.length - 1 ? "md:border-r-0" : ""}
            ` },
                                React.createElement("code", { className: "text-amber-300 font-mono  font-semibold tracking-wide bg-amber-500/10 px-2 py-0.5 rounded-md self-start border border-amber-400/20" }, item.cmd),
                                React.createElement("span", { className: "text-white/80 leading-relaxed pl-1" }, item.desc)));
                        }),
                        cmds.length % 2 !== 0 && (React.createElement("div", { className: "hidden md:block relative min-h-[120px] p-4 border-t border-white/10" }))))))));
}

export { App as default };
