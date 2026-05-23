import { redis } from './redis.js';
import commands from './routes/commands.js';
import middleware from './routes/middleware.js';

var index = defineChildren({
    register() {
        return {
            middlewareRouter: middleware,
            responseRouter: commands,
        };
    },
    onCreated() {
        logger.info({
            message: "本地测试启动",
        });
        redis.get("ai:list").catch((error) => {
            logger.error({
                message: "Redis连接失败, 大部分功能将无法使用",
                error: error.message,
            });
        });
    },
});

export { index as default };
