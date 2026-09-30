import { Image, Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';
import { renderComponentIsHtmlToBuffer } from 'jsxp';
import App from '../../image/conponent/help.js';
import redisClient from '../../config.js';

const selects = onSelects(["message.create", "private.message.create"]);
var res = onResponse(selects, async (e) => {
    // 创建
    const [message] = useMessage(e);
    const scale = await redisClient.getRenderPrecision(e.guid);
    const img = await renderComponentIsHtmlToBuffer(App, {}, {
        screenshot: {
            type: "jpeg",
            quality: 80,
        },
        playwright: {
            context: { deviceScaleFactor: scale },
        },
    });
    if (img)
        message.send(format(Image(img)));
    const config = await redisClient.getAIConfig(e.guid);
    if (config.host.trim() === "" ||
        config.key.trim() === "" ||
        config.model.trim() === "") {
        message.send(format(Text("当前配置不完整，请使用 #切换AI 指令切换到可用的配置")));
    }
    return;
});

export { res as default, selects };
