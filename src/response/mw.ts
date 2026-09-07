export default onMiddleware(
  onSelects(["message.create", "private.message.create"]),
  async () => true,
);
