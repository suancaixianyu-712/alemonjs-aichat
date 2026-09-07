var mw = onMiddleware(onSelects(["message.create", "private.message.create"]), async () => true);

export { mw as default };
