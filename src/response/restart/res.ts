import { spawn } from "node:child_process";
import { Text } from "alemonjs";
import { useMessage } from "@src/utils/command-message";

export const selects = onSelects(["message.create", "private.message.create"]);

export default onResponse(selects, async (e) => {
  const [message] = useMessage(e);

  if (!e.IsMaster) {
    await message.send(format(Text("该指令仅主人可用")));
    return;
  }

  await message.send(format(Text("正在执行 pm2 restart all，服务即将重启...")));

  try {
    const child = spawn("pm2 restart all", {
      detached: true,
      shell: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    console.error("执行 pm2 restart all 失败：", error);
    await message.send(format(Text("重启失败，请查看控制台日志")));
  }
});
