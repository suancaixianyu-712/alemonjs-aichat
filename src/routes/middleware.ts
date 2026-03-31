import { defineRouter, lazy } from "alemonjs";

// 全局中间件路由，负责事件预处理
export default defineRouter([
  {
    selects: ["message.create", "private.message.create"],
    handler: lazy(() => import("../middleware/mw")),
  },
]);
