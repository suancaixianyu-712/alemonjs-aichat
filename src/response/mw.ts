export default onMiddleware(
  onSelects(["message.create", "private.message.create"]),
  async (event, next) => {
    if (event.Xianyu) {
      return true; // 继续执行后续的处理函数
    } else {
      return next(); // 跳过所有指令,继续执行后续的处理函数
    }
  },
);
