import { Text, Image } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';
import { renderComponentIsHtmlToBuffer } from 'jsxp';
import Help from '../../image/conponent/help.js';
import redisClient from '../../config.js';
import { getHelpView, HELP_COMMAND_PATTERN, getHelpText } from '../../utils/help-menu.js';

const selects = onSelects(["message.create", "private.message.create"]);
var res = onResponse(selects, async (e) => {
    const [message] = useMessage(e);
    const send = async (item) => {
        const results = await message.send(format(item));
        for (const result of results ?? []) {
            if (result.code !== 2000) {
                logger.warn({ message: "帮助菜单发送失败", result });
            }
        }
    };
    const command = String(e.MessageText || e.msg || "").trim();
    const view = getHelpView(command.match(HELP_COMMAND_PATTERN)?.[1]);
    if (view.kind === "error") {
        await send(Text(view.message));
        return;
    }
    const scale = await redisClient.getRenderPrecision(e.guid);
    let img = null;
    try {
        img = await renderComponentIsHtmlToBuffer(Help, { view }, {
            screenshot: {
                type: "jpeg",
                quality: 80,
                encoding: "base64",
            },
            playwright: {
                context: { deviceScaleFactor: scale },
            },
        });
    }
    catch (error) {
        logger.error({ message: "帮助菜单渲染失败", error });
    }
    await send(img ? Image(img) : Text(getHelpText(view)));
    if (view.kind !== "home")
        return;
    const config = await redisClient.getAIConfig(e.guid);
    if (config.host.trim() === "" ||
        config.key.trim() === "" ||
        config.model.trim() === "") {
        await send(Text("当前配置不完整，请使用 #切换AI 指令切换到可用的配置"));
    }
    return;
});

export { res as default, selects };
