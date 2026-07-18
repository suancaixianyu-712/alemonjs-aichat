import React from "react";
import css_output from "@src/assets/main.css";
import help from "@src/data/help.json";
import { LinkStyleSheet } from "jsxp";
import bg from "@src/assets/bg-bottom.jpg";
import topbg from "@src/assets/bg-top.png";
import icon from "@src/assets/biaotou.png";

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
      <body
        style={{
          backgroundImage: `url(${bg})`,
          backgroundSize: "100% auto",
          backgroundRepeat: "repeat-y",
        }}
      >
        <img
          src={topbg}
          className="w-full h-auto"
          style={{
            maskImage:
              "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
          }}
        />

        <div className="relative w-full -mt-[65%]">
          {/* 标题 */}
          <div className="flex pt-6 items-center gap-2">
            <div className="w-[50%]"></div>

            <div>
              <div className="flex items-center gap-4 text-[2.5rem] font-bold">
                <span className=" text-[#F5F0E2]">
                  <span className="text-[#E7C8BF]">A</span>
                  <span className="text-[#90CDFD]">I</span> 聊天插件
                </span>
                <img src={icon} className="h-14 pt-2" />
              </div>

              <div className="flex border border-[#bac5f0] rounded-md py-0.5 px-2 mr-6 bg-[#b8c3f886] text-white text-sm">
                <span>{help.name}</span>
                <span className="pl-2 text-[#E7C8BF]">{help.version}</span>
                <span className="pl-2 text-gray-200">• by</span>
                <span className="pl-2 text-[#E7C8BF]">{help.by}</span>
              </div>
            </div>
          </div>

          {/* 卡片 */}
          <div className="columns-2 gap-4 p-2">
            <div className="h-[26rem] break-inside-avoid"></div>

            {help.list.map((g) => {
              return (
                <div className="flex flex-col gap-2 border border-white/10 rounded-xl py-2 px-2 mr-6 mb-4 bg-[#7081d469] backdrop-blur-[2px] break-inside-avoid">
                  <div className="text-white text-lg">{g.group.title}</div>
                  {g.group.items.map((item) => (
                    <div className="bg-[#b8c3f869] p-1.5 rounded-xl">
                      <div className="text-white text-lg">{item.cmd}</div>
                      <div className="text-[#e2e6f7]">{item.desc}</div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </body>
    </html>
  );
}
