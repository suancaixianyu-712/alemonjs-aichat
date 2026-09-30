import { Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';
import { createPanelServer, stopPanelServer, getPanelServerStatus } from '../../panel/server.js';

const selects = onSelects(["message.create", "private.message.create"]);
var res = onResponse(selects, async (event) => {
    const [message] = useMessage(event);
    const reply = (text) => message.send(format(Text(text)));
    if (!event.IsMaster) {
        await reply("仅主人可管理独立网页");
        return;
    }
    const command = String(event.MessageText || event.msg || "").trim();
    try {
        const match = command.match(/^[#/]开启网页(?:\s+([\s\S]*))?$/);
        if (match) {
            const state = await createPanelServer(match[1]);
            await reply(`独立网页已开启，端口 ${state.port}\n本机访问：http://127.0.0.1:${state.port}/panel/config\n远程访问时请将 127.0.0.1 替换为机器人所在服务器的地址`);
        }
        else if (/^[#/]关闭网页$/.test(command)) {
            await stopPanelServer();
            await reply("独立网页已关闭，AlemonX 页面可继续使用");
        }
        else {
            const state = getPanelServerStatus();
            await reply(state.running
                ? `独立网页运行中，端口 ${state.port}`
                : `独立网页未开启，预选端口 ${state.port}\n使用 #开启网页 [端口] 开启`);
        }
    }
    catch (error) {
        await reply(`网页操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
});

export { res as default, selects };
