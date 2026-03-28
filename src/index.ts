export default defineChildren({
  // register() {
  //   return {};
  // },
  onCreated() {
    logger.info({
      message: "本地测试启动",
    });
  },
});
