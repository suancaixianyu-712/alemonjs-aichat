var mw = onMiddleware(onSelects(["message.create", "private.message.create"]), async (event, next) => {
    if (event.Xianyu) {
        return next(); // 普通聊天交给后续路由/文件处理，跳过命令子路由
    }
    else {
        return true; // 命令消息继续执行当前命令子路由
    }
});

export { mw as default };
