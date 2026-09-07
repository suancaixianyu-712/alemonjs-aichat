import { defineRouter, lazy } from 'alemonjs';

// 添加/切换 AI 会话先行拦截，避免配置输入继续进入响应路由。
var middleware = defineRouter([
    {
        selects: ["message.create", "private.message.create"],
        handler: lazy(() => import('../middleware/ai-config.js')),
    },
    {
        selects: ["message.create", "private.message.create"],
        handler: lazy(() => import('../middleware/mw.js')),
    },
]);

export { middleware as default };
