import { Text } from "alemonjs";
import { toolSessionController } from "@src/api/tool-session-controller";
import { useMessage } from "@src/utils/command-message";

const selects = onSelects(["message.create", "private.message.create"]);

const requireMaster = async (
  event: any,
  send: (text: string) => Promise<unknown>,
) => {
  if (event.IsMaster === true) return true;
  await send("该指令仅主人可用");
  return false;
};

export default onResponse(selects, async (event, next) => {
  const input = String(event.msg || "").trim();
  const [message] = useMessage(event);
  const send = (text: string) => message.send(format(Text(text)));

  try {
    const toolMatch = input.match(/^(#|\/)切换工具(?:\s*(opencode|默认))?$/i);
    if (toolMatch) {
      if (!(await requireMaster(event, send))) return;
      const requested = toolMatch[2];
      if (!requested) {
        const current = await toolSessionController.getCurrentTool(event.guid);
        await toolSessionController.beginSelection(event.guid, "tool");
        await send(
          `当前工具：${current === "opencode" ? "opencode" : "默认"}\n请选择工具：\n1. 默认\n2. opencode`,
        );
        return;
      }
      const tool = toolSessionController.parseTool(requested);
      if (!tool) {
        await send("仅支持默认或 opencode");
        return;
      }
      const session = await toolSessionController.setCurrentTool(
        event.guid,
        tool,
      );
      await send(
        tool === "default"
          ? "已切换到默认工具"
          : `${session?.created ? "已切换到 opencode 并创建子会话" : "当前已是 opencode"}：${session?.title || "新会话"}\n${session?.id || ""}`,
      );
      return;
    }

    const permissionMatch = input.match(
      /^(#|\/)(?:修改|设置)权限(?:\s*(只读|手动确认|自动审核|完全访问))?$/i,
    );
    if (permissionMatch) {
      if (!(await requireMaster(event, send))) return;
      const requested = permissionMatch[2];
      if (!requested) {
        const status = await toolSessionController.getStatus(event.guid);
        await toolSessionController.beginSelection(event.guid, "permission");
        await send(
          `当前权限：${status.permissionLabel}\n请选择权限：\n1. 只读\n2. 手动确认\n3. 自动审核\n4. 完全访问`,
        );
        return;
      }
      const permission = toolSessionController.parsePermission(requested);
      if (!permission) {
        await send("不支持该权限模式");
        return;
      }
      await toolSessionController.setPermission(event.guid, permission);
      const status = await toolSessionController.getStatus(event.guid);
      await send(`当前会话权限已设置为：${status.permissionLabel}`);
      return;
    }

    if (/^(#|\/)new$/i.test(input)) {
      if (!(await requireMaster(event, send))) return;
      const session = await toolSessionController.createSession(event.guid);
      await send(
        `已创建并切换到子会话：${session.title || "新会话"}\n${session.id}`,
      );
      return;
    }

    if (/^(#|\/)会话列表$/i.test(input)) {
      await send(await toolSessionController.formatSessionList(event.guid));
      return;
    }

    if (/^(#|\/)models$/i.test(input)) {
      await send(await toolSessionController.formatModelList(event.guid));
      return;
    }

    const modelMatch = input.match(/^(#|\/)model(?:\s+(.+))?$/i);
    if (modelMatch) {
      if (!(await requireMaster(event, send))) return;
      const model = await toolSessionController.setModel(
        event.guid,
        String(modelMatch[2] || ""),
      );
      await send(`OpenCode 模型已切换为：${model.id}`);
      return;
    }

    const sessionMatch = input.match(/^(#|\/)切换会话(?:\s+(.+))?$/i);
    if (sessionMatch) {
      if (!(await requireMaster(event, send))) return;
      const selector = String(sessionMatch[2] || "").trim();
      if (!selector) {
        await toolSessionController.beginSelection(event.guid, "session");
        await send(
          `${await toolSessionController.formatSessionList(event.guid)}\n请回复要切换的序号。`,
        );
        return;
      }
      const session = await toolSessionController.switchSession(
        event.guid,
        selector,
      );
      await send(`已切换到子会话：${session.title || "新会话"}\n${session.id}`);
      return;
    }
  } catch (error) {
    await send(error instanceof Error ? error.message : String(error));
    return;
  }

  return next();
});
