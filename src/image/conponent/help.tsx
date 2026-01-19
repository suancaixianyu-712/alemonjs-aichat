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
        <h2 className="text-2xl text-white font-bold italic drop-shadow-md">
          {help.title}
        </h2>
        <div className="flex gap-2 mb-4 text-white italic drop-shadow-md">
          <span className="text-[#e8deba] ">
            {help.name} {help.version}
          </span>{" "}
          <span className="text-gray-400">by</span>{" "}
          <span className="text-[#e8deba] ">{help.by}</span>
        </div>
        {help.list.map((item, index) => (
          <div
            key={index}
            className=" border-b last:border-0 bg-black/60 rounded-lg overflow-hidden mb-4 text-white backdrop-blur-xs"
          >
            <h2 className="p-4 text-lg font-semibold bg-black/30 border-b border-white/20">
              {item.group.title}
            </h2>
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
