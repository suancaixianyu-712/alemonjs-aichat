import React from "react";
import css_output from "@src/assets/main.css";
import help from "@src/data/help.json";
import { LinkStyleSheet } from "jsxp";
import bg from "@src/assets/bg-bottom.jpg";
import topbg from "@src/assets/bg-top.png";
import icon from "@src/assets/biaotou.png";
import {
  commonHelpItems,
  helpCategoryCommand,
  helpGroups,
  HELP_PAGE_SIZE,
  type HelpView,
} from "@src/utils/help-menu";

type MenuView = Exclude<HelpView, { kind: "error" }>;
const pageLink = (category: string, page = 1) =>
  `?category=${encodeURIComponent(category)}&page=${page}`;

export default function Help({ view = { kind: "home" } }: { view?: MenuView }) {
  const isHome = view.kind === "home";
  return (
    <html lang="zh-CN" style={{ width: 900 }}>
      <head>
        <meta charSet="utf-8" />
        <title>{isHome ? "帮助首页" : view.group.title}</title>
        <LinkStyleSheet src={css_output} />
      </head>
      <body
        style={{
          color: "#f5f0e2",
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          backgroundColor: "#172441",
          backgroundImage: `linear-gradient(#172441aa, #172441ee), url(${bg})`,
          backgroundSize: "100% auto",
          backgroundRepeat: "repeat-y",
        }}
      >
        <main className="p-6">
          <header
            className="rounded-2xl border border-white/20 p-8 mb-5"
            style={{
              backgroundImage: `linear-gradient(90deg, #172441f2, #17244188), url(${topbg})`,
              backgroundSize: "100% auto",
              backgroundPosition: "left top",
            }}
          >
            <div className="flex items-center gap-3 text-sm text-[#bac5f0]">
              <img src={icon} className="h-8 w-auto" />
              <span>{help.name}</span>
              <span>{help.version}</span>
            </div>
            <h1 className="mt-3 text-4xl font-bold">
              {isHome ? "AI 聊天 · 帮助首页" : view.group.title}
            </h1>
            <p className="mt-3 text-lg text-[#d4dcf7]">
              {isHome ? "先选分类，再看指令。" : view.group.desc}
            </p>
            <div className="mt-4 text-base text-[#90cdfd]">
              {isHome
                ? "发送 /帮助 分类，也可以输入分类编号，例如 /帮助 1"
                : `第 ${view.page} / ${view.pageCount} 页 · 共 ${view.group.items.length} 条指令`}
            </div>
          </header>

          {isHome ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                {helpGroups.map((group, index) => (
                  <a
                    key={group.id}
                    href={pageLink(group.key)}
                    className="rounded-xl border border-white/15 p-4 block"
                    style={{ backgroundColor: "#243655e8", color: "inherit", textDecoration: "none" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-xl font-bold">
                        <span className="text-[#90cdfd] mr-2">{String(index + 1).padStart(2, "0")}</span>
                        {group.title}
                      </h2>
                      <span className="text-sm text-[#bac5f0]">{group.items.length} 条</span>
                    </div>
                    <p className="mt-2 text-base text-[#d4dcf7]">{group.desc}</p>
                    <div className="mt-3 text-lg text-[#90cdfd] font-bold">{helpCategoryCommand(group)}</div>
                  </a>
                ))}
              </div>
              <section className="mt-5 rounded-xl border border-white/15 p-4" style={{ backgroundColor: "#243655e8" }}>
                <h2 className="text-xl font-bold mb-3">常用指令</h2>
                <div className="grid grid-cols-2 gap-3">
                  {commonHelpItems.map((item) => (
                    <div key={item.cmd}>
                      <div className="text-lg text-[#90cdfd] font-bold">{item.cmd}</div>
                      <div className="mt-1 text-sm text-[#d4dcf7]">{item.desc}</div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="flex flex-col gap-3">
                {view.items.map((item, index) => (
                  <div key={item.cmd} className="rounded-xl border border-white/15 p-4" style={{ backgroundColor: "#243655e8" }}>
                    <div className="flex gap-3 items-start">
                      <span className="text-sm text-[#bac5f0] pt-1">{String((view.page - 1) * HELP_PAGE_SIZE + index + 1).padStart(2, "0")}</span>
                      <div className="min-w-0">
                        <div className="text-[22px] leading-8 font-bold text-[#90cdfd] break-words">{item.cmd}</div>
                        <p className="mt-2 text-lg leading-7 text-[#d4dcf7] break-words">{item.desc}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </section>
              <nav className="mt-5 flex flex-wrap gap-3">
                {view.page > 1 && (
                  <a href={pageLink(view.group.key, view.page - 1)} className="rounded-xl bg-white/10 px-4 py-3 text-lg text-[#90cdfd]">
                    上一页：{helpCategoryCommand(view.group, view.page - 1)}
                  </a>
                )}
                {view.page < view.pageCount && (
                  <a href={pageLink(view.group.key, view.page + 1)} className="rounded-xl bg-white/10 px-4 py-3 text-lg text-[#90cdfd]">
                    下一页：{helpCategoryCommand(view.group, view.page + 1)}
                  </a>
                )}
                <a href="?" className="rounded-xl bg-white/10 px-4 py-3 text-lg text-[#90cdfd]">返回首页：/帮助</a>
              </nav>
            </>
          )}
          <footer className="mt-5 text-center text-sm text-[#bac5f0]">
            / 和 # 均可使用 · 开启|关闭 表示二选一 · 权限要求见各指令说明
          </footer>
        </main>
      </body>
    </html>
  );
}
