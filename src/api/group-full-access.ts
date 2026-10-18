/** 群权限不能改变框架身份；危险操作始终保留给主人。 */
export const GROUP_FULL_ACCESS_BOUNDARY =
  "当前群已开启完全访问，允许其他操作、服务器目录和完整 Git；但删除文件/目录/仓库、清空数据、重启/停止服务或进程仅主人可用。必须检查脚本、间接调用和子任务的实际效果，禁止换工具绕过。";

export const hasGroupFullAccess = (event: any, mode: string) =>
  mode === "full" &&
  event.name !== "private.message.create" &&
  event.Name !== "private.message.create";

export const isOwnerOnlyOperation = (text: string) => {
  const normalized = String(text || "").replace(/["'`]/g, "");
  return [
    /(?:^|[\s;&|/(:])(?:rm|rmdir|unlink|shred|del|erase|rd|remove-item|ri|remove-itemproperty)(?:\s|\(|$)/i,
    /\b(?:unlink|rmdir|rmtree|rmSync|unlinkSync|rmdirSync|deleteFile|deleteDirectory)\s*\(/i,
    /\b(?:fs\s*\.\s*(?:promises\s*\.\s*)?(?:rm|unlink|rmdir)|os\s*\.\s*(?:remove|unlink|rmdir))\s*\(/i,
    /\b(?:git(?:\.exe)?\s+(?:[^;&|]*?\s)?(?:rm|clean)|git\s+reset\s+--hard)\b/i,
    /\bgh\s+(?:repo\s+delete|api\b[^\r\n]*\b(?:DELETE|--method\s+delete))\b/i,
    /\bgit\s+push\b[^\r\n;&|]*\s(?:--delete|-d|:[^\s]+)/i,
    /(?:^|[\s;&|/(:])(?:reboot|shutdown|halt|poweroff|kill|pkill|killall|taskkill|stop-service|restart-service|stop-process|restart-computer|stop-computer)(?:\.exe)?(?:\s|\(|$)/i,
    /\b(?:pm2|systemctl|service|supervisorctl|docker|docker-compose|kubectl)\b[^\r\n;&|]*\b(?:restart|reload|reboot|stop|delete|remove|rm|down|scale)\b/i,
    /(?:删除|移除|清空|销毁).{0,20}(?:文件|目录|仓库|git库|数据)|(?:重启|停止|关闭).{0,12}(?:服务|进程|服务器)/i,
  ].some((pattern) => pattern.test(normalized));
};
