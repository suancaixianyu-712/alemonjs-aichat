const parsePanelPort = (value) => {
    const text = String(value ?? "").trim();
    const port = Number(text);
    if (!/^\d+$/.test(text) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535) {
        throw new Error("端口号必须是 1–65535 之间的整数");
    }
    return port;
};
const createPanelServerController = (listen, defaultPort) => {
    let server = null;
    let port = defaultPort;
    let queue = Promise.resolve();
    const status = () => ({
        running: Boolean(server?.listening),
        port,
    });
    const serialize = (operation) => {
        const result = queue.then(operation);
        queue = result.catch(() => { });
        return result;
    };
    return {
        status,
        start: (requestedPort) => serialize(async () => {
            const nextPort = parsePanelPort(String(requestedPort ?? "").trim() || port);
            if (server?.listening) {
                if (nextPort !== port)
                    throw new Error(`独立网页已在端口 ${port} 运行，请先关闭后再更换端口`);
                return status();
            }
            const candidate = listen(nextPort);
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    candidate.off("listening", onListening);
                    reject(error.code === "EADDRINUSE"
                        ? new Error(`端口 ${nextPort} 已被占用，请更换端口`)
                        : error);
                };
                const onListening = () => {
                    candidate.off("error", onError);
                    resolve();
                };
                candidate.once("error", onError);
                candidate.once("listening", onListening);
            });
            server = candidate;
            port = nextPort;
            candidate.once("close", () => {
                if (server === candidate)
                    server = null;
            });
            return status();
        }),
        stop: () => serialize(async () => {
            if (!server)
                return status();
            const closing = server;
            await new Promise((resolve, reject) => {
                // 停止独立监听，不影响 AlemonX 的宿主服务；给现有请求短暂收尾时间。
                const timer = setTimeout(() => closing.closeAllConnections(), 2000);
                timer.unref();
                closing.close((error) => {
                    clearTimeout(timer);
                    if (error &&
                        error.code !== "ERR_SERVER_NOT_RUNNING")
                        reject(error);
                    else
                        resolve();
                });
                closing.closeIdleConnections();
            });
            if (server === closing)
                server = null;
            return status();
        }),
    };
};

export { createPanelServerController, parsePanelPort };
