import os from 'node:os';
import * as si from 'systeminformation';

const safeCollect = async (task, fallback) => {
    try {
        return await task();
    }
    catch (error) {
        logger.warn({
            message: "系统状态信息采集失败",
            error: error instanceof Error ? error.message : String(error),
        });
        return fallback;
    }
};
const finiteOrNull = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
};
const isHardwareGpu = (controller) => {
    const identity = [controller.vendor, controller.model, controller.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    return (identity.length > 0 &&
        !/(virtual|remote|parsec|idd|indirect|basic display|software)/i.test(identity));
};
const collectSystemStatus = async () => {
    const [memory, fileSystems, graphics, networkStats, osInfo, cpu, system] = await Promise.all([
        safeCollect(() => si.mem(), null),
        safeCollect(() => si.fsSize(), []),
        safeCollect(() => si.graphics(), null),
        safeCollect(() => si.networkStats(), []),
        safeCollect(() => si.osInfo(), null),
        safeCollect(() => si.cpu(), null),
        safeCollect(() => si.system(), null),
    ]);
    const totalMemory = Number(memory?.total) || os.totalmem();
    const usedMemory = Number(memory?.active) ||
        Number(memory?.used) ||
        totalMemory - os.freemem();
    const activeNetworkStats = networkStats.filter((item) => {
        const iface = item.iface.toLowerCase();
        return (item.operstate === "up" && iface !== "lo" && !iface.includes("loopback"));
    });
    return {
        botUptime: process.uptime(),
        systemUptime: os.uptime(),
        memory: {
            used: Math.max(0, usedMemory),
            total: Math.max(0, totalMemory),
            use: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0,
        },
        disks: fileSystems
            .filter((item) => item.size > 0 && item.mount)
            .map((item) => ({
            mount: item.mount,
            used: item.used,
            size: item.size,
            use: item.use,
        })),
        gpus: (graphics?.controllers ?? []).filter(isHardwareGpu).map((item) => ({
            name: item.model || item.name || item.vendor || "GPU",
            utilization: finiteOrNull(item.utilizationGpu),
            memoryUsed: finiteOrNull(item.memoryUsed),
            memoryTotal: finiteOrNull(item.memoryTotal ?? item.vram),
        })),
        network: activeNetworkStats.reduce((total, item) => ({
            received: total.received + (Number(item.rx_bytes) || 0),
            sent: total.sent + (Number(item.tx_bytes) || 0),
        }), { received: 0, sent: 0 }),
        system: {
            os: [osInfo?.distro, osInfo?.release].filter(Boolean).join(" ") ||
                `${os.type()} ${os.release()}`,
            host: osInfo?.hostname || os.hostname(),
            cpu: [cpu?.manufacturer, cpu?.brand].filter(Boolean).join(" ") ||
                os.cpus()[0]?.model ||
                "未知",
            device: [system?.manufacturer, system?.model]
                .filter((item) => item && item !== "System Product Name")
                .join(" ") || "未知设备",
            arch: osInfo?.arch || os.arch(),
        },
    };
};

export { collectSystemStatus };
