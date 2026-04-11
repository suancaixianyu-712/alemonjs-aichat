import React from "react";
import css_output from "@src/assets/main.css";
import help from "@src/data/help.json";
import { LinkStyleSheet } from "jsxp";
import img from "@src/assets/113574575_p0_master1200.jpg";

/**
 * @param param0
 * @returns
 */
export default function App() {
  return (
    <html>
      <head>
        <LinkStyleSheet src={css_output} />
      </head>
      <body className="bg-cover p-4" style={{ backgroundImage: `url(${img})` }}>
        <div className="relative mb-6">
          {/* 装饰性背景光晕 */}
          <div className="absolute -left-4 -top-4 w-24 h-24 bg-purple-400/20 rounded-full blur-2xl -z-0"></div>

          {/* 主标题 */}
          <h2 className="relative text-3xl font-bold bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 bg-clip-text text-transparent drop-shadow-lg tracking-wide">
            {help.title}
          </h2>

          {/* 标题底部装饰线 */}
          <div className="mt-2 flex items-center gap-2">
            <div className="h-0.5 w-12 bg-gradient-to-r from-amber-400 to-purple-400 rounded-full"></div>
            <div className="h-0.5 w-20 bg-white/30 rounded-full"></div>
          </div>

          {/* 副标题信息 - 使用高亮白色 */}
          <div className="flex items-center gap-2 mt-3 text-sm">
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

        {help.list.map((item, index) => (
          <div
            key={index}
            className=" border-b last:border-0 bg-black/60 rounded-lg overflow-hidden mb-4 text-white backdrop-blur-xs"
          >
            <div className="p-4 bg-black/30 border-b border-white/20">
              <p className="text-lg font-semibold">{item.group.title}</p>
              <p className="text-md mt-1">{item.group.desc}</p>
            </div>
            <div>
              {Array.from({
                length: Math.ceil(item.group.items.length / 3),
              }).map((_, rowIndex) => {
                const rowItems = item.group.items.slice(
                  rowIndex * 3,
                  rowIndex * 3 + 3,
                );
                return (
                  <div
                    key={rowIndex}
                    className={`flex flex-wrap ${
                      rowIndex % 2 === 1 ? "bg-black/30" : ""
                    }`}
                  >
                    {Array.from({ length: 3 }).map((_, subIndex) => {
                      const subItem = rowItems[subIndex];
                      // 判断是否为最后一列
                      const isLastCol = subIndex === 2;
                      // 判断是否为最后一行
                      const isLastRow =
                        rowIndex === Math.ceil(item.group.items.length / 3) - 1;
                      if (subItem) {
                        return (
                          <div
                            key={subIndex}
                            className={`w-1/3 p-4 box-border${
                              isLastCol ? "" : " border-r border-white/20"
                            }${isLastRow ? "" : " border-b border-white/20"}`}
                          >
                            <div className="text-[#B8AE8E]  font-bold text-lg">
                              {subItem.cmd}
                            </div>
                            <div>{subItem.desc}</div>
                          </div>
                        );
                      } else {
                        // 空白格子
                        return (
                          <div
                            key={subIndex}
                            className={`w-1/3 p-2 box-border${
                              isLastCol ? "" : " border-r border-white/20"
                            }${isLastRow ? "" : " border-b border-white/20"}`}
                          ></div>
                        );
                      }
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </body>
    </html>
  );
}
