import React from "react";
import css_output from "@src/assets/main.css";
import help from "@src/data/help.json";
import { LinkStyleSheet } from "jsxp";
import img from "@src/assets/113574575_p0_master1200.jpg";

const cmds = [
  { cmd: "#切换AI [厂商/模型]", desc: "按厂商选择或直接切换AI模型" },
  { cmd: "/切换模型 <模型名称>", desc: "切换当前使用的AI模型" },
  { cmd: "/<开启|关闭>代理", desc: "为当前AI配置单独开启代理或直连" },
  { cmd: "/<开启|关闭>仅艾特触发", desc: "开启或关闭仅艾特触发功能" },
  { cmd: "/<开启|关闭>工具", desc: "开启或关闭AI工具" },
  { cmd: "/<开启|关闭>图床", desc: "按管理员权限开启或关闭全局 WebUI 图片链接访问" },
  { cmd: "/<开启|关闭>工具调用内容", desc: "开启或关闭工具调用前内容发送" },
  { cmd: "/设置AI上下文长度 512k", desc: "设置CAPI自动压缩上下文长度" },
  { cmd: "/设置识图ai 名称", desc: "配置无法看图的主模型用的识图AI" },
  { cmd: "/<开启|关闭>复杂输出", desc: "开启或关闭复杂输出" },
  { cmd: "/<开启|关闭>好感度", desc: "开启或关闭好感度系统" },
  { cmd: "/清空对话", desc: "清空当前对话历史" },
  { cmd: "/删除对话", desc: "直接删除当前对话历史，不做归档" },
];

const SkillItem = ({
  name,
  description,
}: {
  name: string;
  description: string;
}) => {
  return (
    <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2">
      <div className="font-mono text-sm font-semibold text-cyan-200">
        {name}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-white/70">
        {description || "暂无描述"}
      </div>
    </div>
  );
};

{
  /* 辅助组件 - StatusItem */
}
const StatusItem = ({
  label,
  value,
  isDeep,
}: {
  label: string;
  value: boolean | string;
  isDeep?: boolean;
}) => {
  // 深度思考的特殊处理：默认不是关闭状态
  let displayValue = value;
  let isActive = value;

  if (isDeep) {
    displayValue = value === "默认" ? "默认" : value ? "开启" : "关闭";
    isActive = value === "默认" ? "default" : value;
  }

  const getStatusStyle = () => {
    if (isDeep && value === "默认") {
      return "bg-yellow-500/20 text-yellow-300 border-yellow-500/30";
    }
    if (value) {
      return "bg-green-500/20 text-green-300 border-green-500/30";
    }
    return "bg-red-500/10 text-red-300 border-red-500/20";
  };

  return (
    <div className="flex items-center justify-between py-2 px-2 rounded-lg bg-white/5">
      <span className=" text-white/70">{label}</span>
      <span
        className={`px-3 py-0.5 rounded-full text-xs font-mono font-medium border ${getStatusStyle()}`}
      >
        {isDeep && value === "默认" ? "默认" : value ? "开启" : "关闭"}
      </span>
    </div>
  );
};

/**
 * @param param0
 * @returns
 */
export default function App(data: {
  switch: boolean;
  tools: boolean;
  complex: boolean;
  affection: boolean;
  tts: boolean;
  deep: boolean;
  model: string;
  prompt: string;
  atTrigger: boolean;
  imageBedSwitch: boolean;
  currentAI: string;
  aiList: string[];
  skillList: Array<{ name: string; description: string }>;
  toolList: Record<string, string>;
  toolPromptSwitch: boolean;
  toolPromptRevokeSwitch: boolean;
  toolPromptArgsSwitch: boolean;
  toolCallContentSwitch: boolean;
  capiContextLimit: string;
}) {
  return (
    <html>
      <head>
        <LinkStyleSheet src={css_output} />
      </head>
      <body className="bg-cover p-4" style={{ backgroundImage: `url(${img})`, width: "800px" }}>
        <div className="relative mb-6">
          {/* 装饰性背景光晕 */}
          <div className="absolute -left-4 -top-4 w-24 h-24 bg-purple-400/20 rounded-full blur-2xl -z-0"></div>

          {/* 主标题 */}
          <h2 className="relative text-3xl font-bold bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 bg-clip-text text-transparent drop-shadow-lg tracking-wide">
            AI配置详情
          </h2>

          {/* 标题底部装饰线 */}
          <div className="mt-2 flex items-center gap-2">
            <div className="h-0.5 w-12 bg-gradient-to-r from-amber-400 to-purple-400 rounded-full"></div>
            <div className="h-0.5 w-20 bg-white/30 rounded-full"></div>
          </div>

          {/* 副标题信息 - 使用高亮白色 */}
          <div className="flex items-center gap-2 mt-3 ">
            <span className="px-2 py-0.5 bg-amber-500/20 rounded-md text-amber-200 font-mono text-xs border border-amber-400/30">
              {help.name}
            </span>
            <span className="text-amber-300 text-xs font-mono font-medium">
              {help.version}
            </span>
            <span className="text-white/50 text-xs">•</span>
            <span className="text-white/60 text-xs">by</span>
            <span className="text-amber-200 text-xs font-medium tracking-wide">
              {help.by}
            </span>
          </div>
        </div>

        <div className="bg-gradient-to-br from-gray-900/90 to-black/80 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl overflow-hidden mb-4 text-white">
          <div className="px-5 py-3 bg-white/5 border-b border-white/10 backdrop-blur-sm">
            <p className="text-base font-medium tracking-wide flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full"></span>
              技能列表
            </p>
          </div>
          <div className="p-5">
            {data.skillList.length ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {data.skillList.map((skill) => (
                  <SkillItem
                    key={`skill-${skill.name}`}
                    name={skill.name}
                    description={skill.description}
                  />
                ))}
              </div>
            ) : (
              <span className=" text-white/40 italic">暂无技能配置</span>
            )}
          </div>
        </div>

        <div className="bg-gradient-to-br from-gray-900/90 to-black/80 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl overflow-hidden mb-4 text-white">
          <div className="px-5 py-3 bg-white/5 border-b border-white/10 backdrop-blur-sm">
            <p className="text-base font-medium tracking-wide flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-blue-400 rounded-full"></span>
              当前AI配置
            </p>
          </div>

          <div className="p-5 space-y-3">
            {/* 开关状态组 - 使用网格布局更清晰 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <StatusItem label="总开关" value={data.switch} />
              <StatusItem label="复杂输出" value={data.complex} />
              <StatusItem label="好感度开关" value={data.affection} />
              <StatusItem label="语音回复开关" value={data.tts} />
              <StatusItem label="深度思考" value={data.deep} isDeep />
              <StatusItem label="仅艾特触发" value={data.atTrigger} />
              <StatusItem label="全局图床开关" value={data.imageBedSwitch} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-white/10 pt-2">
              <StatusItem label="工具总开关" value={data.tools} />
              <StatusItem label="工具提示" value={data.toolPromptSwitch} />
              <StatusItem
                label="工具提示撤回"
                value={data.toolPromptRevokeSwitch}
              />
              <StatusItem
                label="工具提示传参"
                value={data.toolPromptArgsSwitch}
              />
              <StatusItem
                label="工具调用内容"
                value={data.toolCallContentSwitch}
              />
              <div className="flex items-center justify-between py-2 px-2 rounded-lg bg-white/5">
                <span className=" text-white/70">CAPI上下文长度</span>
                <span className="px-3 py-0.5 rounded-full text-xs font-mono font-medium border bg-cyan-500/20 text-cyan-300 border-cyan-500/30">
                  {data.capiContextLimit}
                </span>
              </div>
            </div>

            {/* 模型信息 */}
            <div className="pt-2 border-t border-white/10">
              <div className="flex items-center justify-between py-2">
                <span className=" text-white/60">当前使用模型</span>
                <span className="px-3 py-1 bg-blue-500/20 rounded-full  font-mono text-blue-300 border border-blue-500/30">
                  {data.currentAI || "无法获取"} / {data.model || "未设置"}
                </span>
              </div>

              {/* 提示词 */}
              <div className="py-2">
                <div className=" text-white/60 mb-1">提示词</div>
                <div className="px-3 py-2 bg-white/5 rounded-lg  text-white/80 border border-white/10">
                  {data.prompt || "未设置"}
                </div>
              </div>

              {/* AI列表 - Tag装饰 */}
              <div className="py-2">
                <div className=" text-white/60 mb-2">AI列表</div>
                <div className="flex flex-wrap gap-2">
                  {data.aiList.length ? (
                    data.aiList.map((ai, idx) => (
                      <span
                        key={idx}
                        className="px-2.5 py-1 text-xs rounded-full bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-200 border border-purple-400/30 backdrop-blur-sm font-medium"
                      >
                        {ai}
                      </span>
                    ))
                  ) : (
                    <span className=" text-white/40 italic">暂无AI配置</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-br from-gray-900/90 to-black/80 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl overflow-hidden mb-4 text-white">
          <div className="px-5 py-3 bg-white/5 border-b border-white/10 backdrop-blur-sm">
            <p className="text-base font-medium tracking-wide flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-green-400 rounded-full"></span>
              工具列表
            </p>
          </div>
          <div className="p-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(data.toolList).length ? (
                Object.entries(data.toolList).map(([tool, status]) => (
                  <StatusItem
                    key={`tool-${tool}`}
                    label={tool}
                    value={status === "0"}
                  />
                ))
              ) : (
                <span className=" text-white/40 italic">暂无工具配置</span>
              )}
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-br from-gray-900/90 to-black/80 backdrop-blur-md rounded-2xl border border-white/20 shadow-xl overflow-hidden mb-4">
          {/* 标题栏 */}
          <div className="px-5 py-3 bg-white/5 border-b border-white/10 backdrop-blur-sm">
            <p className="text-base font-semibold tracking-wide flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-amber-400 rounded-full shadow-glow"></span>
              <span className="text-amber-100">推荐指令</span>
            </p>
          </div>

          {/* 指令列表 - 使用 CSS Grid 原生网格线 */}
          <div className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 auto-rows-auto">
              {cmds.map((item, idx) => {
                const isLastInRow =
                  (idx + 1) % 2 === 0 || idx === cmds.length - 1;
                const isSecondCol = idx % 2 === 1;

                return (
                  <div
                    key={idx}
                    className={`relative flex flex-col gap-1.5 p-4 transition-colors hover:bg-white/5
              ${isSecondCol ? "md:border-l border-white/10" : ""}
              ${idx >= 2 ? "border-t border-white/10" : ""}
              ${isLastInRow && idx < cmds.length - 1 ? "md:border-r-0" : ""}
            `}
                  >
                    {/* 指令 - 高亮显示 */}
                    <code className="text-amber-300 font-mono  font-semibold tracking-wide bg-amber-500/10 px-2 py-0.5 rounded-md self-start border border-amber-400/20">
                      {item.cmd}
                    </code>

                    {/* 描述 - 提高对比度 */}
                    <span className="text-white/80 leading-relaxed pl-1">
                      {item.desc}
                    </span>
                  </div>
                );
              })}

              {/* 填充空缺项并显示完整网格线 */}
              {cmds.length % 2 !== 0 && (
                <div className="hidden md:block relative min-h-[120px] p-4 border-t border-white/10"></div>
              )}
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
