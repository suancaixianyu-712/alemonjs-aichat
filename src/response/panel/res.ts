import { Text } from "alemonjs";
import { useMessage } from "@src/utils/command-message";
import {
  createPanelServer,
  stopPanelServer,
  getPanelServerStatus,
} from "@src/panel/server";
import {
  buildPanelAccessUrls,
  disablePanelAccess,
  enablePanelAccess,
  listPrivateIpv4,
  probePublicIpv4,
} from "@src/panel/access";

export const selects = onSelects(["message.create", "private.message.create"]);

export default onResponse(selects, async (event) => {
  const [message] = useMessage(event);
  const reply = (text: string) => message.send(format(Text(text)));
  if (!event.IsMaster) {
    await reply("仅主人可管理独立网页");
    return;
  }
  const command = String(event.MessageText || event.msg || "").trim();
  const eventName = String(
    event.name || (event as { Name?: string }).Name || "",
  );
  try {
    if (/^[#/]登录面板$/.test(command)) {
      if (eventName !== "private.message.create") {
        await reply("仅限私聊使用 #登录面板");
        return;
      }
      const state = await createPanelServer();
      const access = await enablePanelAccess();
      const [publicIp, privateIps] = await Promise.all([
        probePublicIpv4(),
        Promise.resolve(listPrivateIpv4()),
      ]);
      const lines = buildPanelAccessUrls(
        state.port,
        access.token,
        publicIp,
        privateIps,
      );
      await reply(`面板已开启访问\n${lines.join("\n")}`);
      return;
    }

    const match = command.match(/^[#/]开启网页(?:\s+([\s\S]*))?$/);
    if (match) {
      const state = await createPanelServer(match[1]);
      await reply(
        `独立网页已开启，端口 ${state.port}\n访问地址请私聊发 #登录面板`,
      );
    } else if (/^[#/]关闭网页$/.test(command)) {
      await stopPanelServer();
      await disablePanelAccess();
      await reply("独立网页已关闭，AlemonX 页面可继续使用");
    } else {
      const state = getPanelServerStatus();
      await reply(
        state.running
          ? `独立网页运行中，端口 ${state.port}`
          : `独立网页未开启，预选端口 ${state.port}\n使用 #开启网页 [端口] 开启`,
      );
    }
  } catch (error) {
    await reply(
      `网页操作失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
});
