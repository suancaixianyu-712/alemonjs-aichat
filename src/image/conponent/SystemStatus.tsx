import React from "react";
import { LinkStyleSheet } from "jsxp";
import css_output from "@src/assets/main.css";
import bg from "@src/assets/bg-bottom.jpg";
import topbg from "@src/assets/bg-top.png";
import fallbackAvatar from "@src/assets/biaotou.png";
import type { SystemStatusData } from "@src/utils/system-status";

interface SystemStatusProps {
  bot: {
    nickname: string;
    avatar?: string;
  };
  status: SystemStatusData;
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
};

const formatDuration = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const parts = [] as string[];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0 || days > 0) parts.push(`${hours}小时`);
  parts.push(`${minutes}分钟`);
  return parts.join(" ");
};

const clampPercent = (value: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

function ProgressBar({ value }: { value: number }) {
  const percent = clampPercent(value);
  return (
    <div className="h-2.5 overflow-hidden rounded-full bg-[#3d477c99]">
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#90CDFD] to-[#E7C8BF]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-[#7081d469] p-4 backdrop-blur-[2px]">
      <h2 className="mb-3 text-xl font-bold text-white">{title}</h2>
      {children}
    </section>
  );
}

export default function SystemStatus({ bot, status }: SystemStatusProps) {
  return (
    <html>
      <head>
        <LinkStyleSheet src={css_output} />
      </head>
      <body
        className="m-0 min-h-screen text-[#e2e6f7]"
        style={{
          width: "900px",
          backgroundImage: `url(${bg})`,
          backgroundSize: "100% auto",
          backgroundRepeat: "repeat-y",
        }}
      >
        <img
          src={topbg}
          className="h-auto w-full"
          style={{
            maskImage:
              "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, black 0%, black 70%, transparent 100%)",
          }}
        />

        <main className="relative -mt-[63%] px-7 pb-8">
          <header className="mb-7 flex min-h-[250px] items-center justify-end gap-5 pr-5 pt-5">
            <img
              src={bot.avatar || fallbackAvatar}
              className="h-24 w-24 rounded-full border-4 border-[#bac5f0] bg-[#7081d4] object-cover shadow-xl"
            />
            <div className="w-[390px]">
              <div className="text-sm tracking-[0.35em] text-[#bac5f0]">
                SYSTEM STATUS
              </div>
              <h1 className="mt-1 text-4xl font-bold text-[#F5F0E2]">
                {bot.nickname}
              </h1>
              <div className="mt-3 inline-flex rounded-md border border-[#bac5f0] bg-[#b8c3f886] px-3 py-1 text-white">
                当前设备运行状态
              </div>
            </div>
          </header>

          <div className="grid grid-cols-2 gap-4">
            <Section title="运行时间">
              <div className="space-y-3">
                <div className="rounded-xl bg-[#b8c3f869] p-3">
                  <div className="text-sm text-[#d5dcf4]">机器人运行时间</div>
                  <div className="mt-1 text-2xl font-bold text-white">
                    {formatDuration(status.botUptime)}
                  </div>
                </div>
                <div className="rounded-xl bg-[#b8c3f869] p-3">
                  <div className="text-sm text-[#d5dcf4]">系统运行时间</div>
                  <div className="mt-1 text-2xl font-bold text-white">
                    {formatDuration(status.systemUptime)}
                  </div>
                </div>
              </div>
            </Section>

            <Section title="内存使用情况">
              <div className="rounded-xl bg-[#b8c3f869] p-3">
                <div className="flex items-end justify-between">
                  <span className="text-3xl font-bold text-white">
                    {clampPercent(status.memory.use).toFixed(1)}%
                  </span>
                  <span className="text-sm text-[#d5dcf4]">
                    {formatBytes(status.memory.used)} /{" "}
                    {formatBytes(status.memory.total)}
                  </span>
                </div>
                <div className="mt-4">
                  <ProgressBar value={status.memory.use} />
                </div>
              </div>
            </Section>

            <Section title="挂载盘符容量">
              <div className="space-y-3">
                {status.disks.length > 0 ? (
                  status.disks.map((disk) => (
                    <div
                      key={`${disk.mount}-${disk.size}`}
                      className="rounded-xl bg-[#b8c3f869] p-3"
                    >
                      <div className="mb-2 flex justify-between gap-4">
                        <span className="font-bold text-white">
                          {disk.mount}
                        </span>
                        <span className="text-sm text-[#d5dcf4]">
                          {formatBytes(disk.used)} / {formatBytes(disk.size)} ·{" "}
                          {clampPercent(disk.use).toFixed(1)}%
                        </span>
                      </div>
                      <ProgressBar value={disk.use} />
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl bg-[#b8c3f869] p-3">
                    暂无可用数据
                  </div>
                )}
              </div>
            </Section>

            <div className="space-y-4">
              <Section title="累计流量">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-[#b8c3f869] p-3">
                    <div className="text-sm text-[#d5dcf4]">接收</div>
                    <div className="mt-1 text-2xl font-bold text-white">
                      {formatBytes(status.network.received)}
                    </div>
                  </div>
                  <div className="rounded-xl bg-[#b8c3f869] p-3">
                    <div className="text-sm text-[#d5dcf4]">发送</div>
                    <div className="mt-1 text-2xl font-bold text-white">
                      {formatBytes(status.network.sent)}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-xs text-[#cbd3ef]">
                  当前活动网卡自系统启动以来的累计值
                </div>
              </Section>

              {status.gpus.length > 0 && (
                <Section title="GPU 使用情况">
                  <div className="space-y-3">
                    {status.gpus.map((gpu, index) => (
                      <div
                        key={`${gpu.name}-${index}`}
                        className="rounded-xl bg-[#b8c3f869] p-3"
                      >
                        <div className="font-bold text-white">{gpu.name}</div>
                        <div className="mt-2 flex justify-between text-sm">
                          <span>
                            使用率{" "}
                            {gpu.utilization === null
                              ? "暂不可读"
                              : `${gpu.utilization.toFixed(1)}%`}
                          </span>
                          {gpu.memoryTotal !== null && gpu.memoryTotal > 0 && (
                            <span>
                              显存{" "}
                              {formatBytes((gpu.memoryUsed ?? 0) * 1024 * 1024)}{" "}
                              / {formatBytes(gpu.memoryTotal * 1024 * 1024)}
                            </span>
                          )}
                        </div>
                        {gpu.utilization !== null && (
                          <div className="mt-2">
                            <ProgressBar value={gpu.utilization} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </div>

            <div className="col-span-2">
              <Section title="系统信息">
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl bg-[#b8c3f869] p-4">
                  <div>
                    <span className="text-[#cbd3ef]">操作系统：</span>
                    <span className="text-white">{status.system.os}</span>
                  </div>
                  <div>
                    <span className="text-[#cbd3ef]">主机名：</span>
                    <span className="text-white">{status.system.host}</span>
                  </div>
                  <div>
                    <span className="text-[#cbd3ef]">设备：</span>
                    <span className="text-white">{status.system.device}</span>
                  </div>
                  <div>
                    <span className="text-[#cbd3ef]">架构：</span>
                    <span className="text-white">{status.system.arch}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-[#cbd3ef]">处理器：</span>
                    <span className="text-white">{status.system.cpu}</span>
                  </div>
                </div>
              </Section>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
