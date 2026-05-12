import { Text, useMessage, getConfigValue } from "alemonjs";
import { onResponse, onSelects } from "alemonjs";
import { getExecCommandEnv, getUserEnv, setUserEnv, initUserEnv, switchToSystem, switchToGroup, switchToUser, switchToRemote, switchToSingularity, getEnvDescription, listAvailableEnvs } from "@src/userEnv";
import { remoteNodeManager } from "@src/remoteNodes";

const selects = onSelects(["message.create", "private.message.create"]);

export default onResponse(selects, async (e, next) => {
  const [message] = useMessage(e);
  const value = getConfigValue().aiChat || {};

  // ====================
  // 查看当前环境
  // ====================
  if (/^(\/|#)查看环境$/i.test(e.msg)) {
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    
    // 初始化环境（如果未设置）
    await initUserEnv(groupId, e.UserId);
    
    // 获取当前环境描述
    const envDesc = await getEnvDescription(groupId, e.UserId);
    
    // 获取可用环境列表
    const envList = await listAvailableEnvs();
    
    message.send(Text(`当前环境: ${envDesc}\n\n${envList}`));
    return;
  }

  // ====================
  // 切换环境 - 系统
  // ====================
  if (/^(\/|#)切换环境\s+system$/i.test(e.msg)) {
    // 仅私聊可用
    if (e.name !== "private.message.create") {
      message.send(Text("切换系统环境仅在私聊中可用！"));
      return;
    }
    // 仅超级管理员可用
    const configValue = getConfigValue();
    const superAdmins = configValue.aiChat?.superAdmin || [];
    if (!superAdmins.includes(e.UserId)) {
      message.send(Text("你没有权限切换到系统环境！"));
      return;
    }
    const result = await switchToSystem("private", e.UserId);
    message.send(Text(result));
    return;
  }

  // ====================
  // 切换环境 - 群容器
  // ====================
  if (/^(\/|#)切换环境\s+group$/i.test(e.msg)) {
    if (e.name === "private.message.create") {
      message.send(Text("私聊无法切换到群容器，请在群聊中使用！"));
      return;
    }
    const result = await switchToGroup(e.guid, e.UserId);
    message.send(Text(result));
    return;
  }

  // ====================
  // 切换环境 - 用户容器
  // ====================
  if (/^(\/|#)切换环境\s+user$/i.test(e.msg)) {
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const result = await switchToUser(groupId, e.UserId);
    message.send(Text(result));
    return;
  }

  // ====================
  // 切换环境 - 远程节点
  // ====================
  if (/^(\/|#)切换环境\s+remote\s+(\S+)$/i.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)切换环境\s+remote\s+(\S+)$/i);
    if (!match) {
      message.send(Text("格式错误，请使用: /切换环境 remote <节点名称>"));
      return;
    }
    const nodeName = match[2];
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const result = await switchToRemote(groupId, e.UserId, nodeName);
    message.send(Text(result));
    return;
  }

  // ====================
  // 切换环境 - Singularity
  // ====================
  if (/^(\/|#)切换环境\s+singularity\s+(\S+)\s*(.*)$/i.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)切换环境\s+singularity\s+(\S+)\s*(.*)$/i);
    if (!match) {
      message.send(Text("格式错误，请使用: /切换环境 singularity <节点名称> [镜像路径]"));
      return;
    }
    const nodeName = match[2];
    const image = match[3] || undefined;
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const result = await switchToSingularity(groupId, e.UserId, nodeName, image);
    message.send(Text(result));
    return;
  }

  // ====================
  // Slurm 作业管理
  // ====================

  // 提交 Slurm 作业
  if (/^(\/|#)slurm\s+提交\s+(.+)$/is.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)slurm\s+提交\s+(.+)$/is);
    if (!match) {
      message.send(Text("格式错误，请使用: /slurm 提交 <脚本或命令>"));
      return;
    }
    const script = match[2].trim();
    
    // 获取当前环境
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const env = await getUserEnv(groupId, e.UserId);
    
    if (!env || (env.type !== "remote" && env.type !== "singularity")) {
      message.send(Text("Slurm 作业提交需要在远程节点或 Singularity 环境中，请先切换环境"));
      return;
    }
    
    if (!env.nodeName) {
      message.send(Text("未指定远程节点，请先切换环境"));
      return;
    }
    
    const node = remoteNodeManager.getNode(env.nodeName);
    if (!node) {
      message.send(Text(`未找到远程节点: ${env.nodeName}`));
      return;
    }
    
    if (!node.slurm) {
      message.send(Text(`节点 ${env.nodeName} 未启用 Slurm 支持`));
      return;
    }
    
    try {
      const { jobId, output } = await remoteNodeManager.submitSlurmJob(
        env.nodeName,
        script,
        {
          image: env.type === "singularity" ? env.singularityImage : undefined,
        }
      );
      message.send(Text(`Slurm 作业已提交\nJob ID: ${jobId}\n输出: ${output}`));
    } catch (err: any) {
      message.send(Text(`提交失败: ${err.message}`));
    }
    return;
  }

  // 查询 Slurm 作业状态
  if (/^(\/|#)slurm\s+状态\s*(\d*)$/i.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)slurm\s+状态\s*(\d*)$/i);
    const jobId = match?.[2] || undefined;
    
    // 获取当前环境
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const env = await getUserEnv(groupId, e.UserId);
    
    if (!env || (env.type !== "remote" && env.type !== "singularity")) {
      message.send(Text("查询 Slurm 作业需要在远程节点环境中，请先切换环境"));
      return;
    }
    
    if (!env.nodeName) {
      message.send(Text("未指定远程节点，请先切换环境"));
      return;
    }
    
    try {
      const result = await remoteNodeManager.querySlurmJob(env.nodeName, jobId);
      message.send(Text(`Slurm 作业状态:\n${result}`));
    } catch (err: any) {
      message.send(Text(`查询失败: ${err.message}`));
    }
    return;
  }

  // 查看 Slurm 作业日志
  if (/^(\/|#)slurm\s+日志\s+(\d+)$/i.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)slurm\s+日志\s+(\d+)$/i);
    if (!match) {
      message.send(Text("格式错误，请使用: /slurm 日志 <JobID>"));
      return;
    }
    const jobId = match[2];
    
    // 获取当前环境
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const env = await getUserEnv(groupId, e.UserId);
    
    if (!env || (env.type !== "remote" && env.type !== "singularity")) {
      message.send(Text("查看日志需要在远程节点环境中，请先切换环境"));
      return;
    }
    
    if (!env.nodeName) {
      message.send(Text("未指定远程节点，请先切换环境"));
      return;
    }
    
    try {
      const result = await remoteNodeManager.getSlurmJobOutput(env.nodeName, jobId);
      // 如果日志太长，只显示最后 2000 字符
      const displayResult = result.length > 2000 ? result.slice(-2000) + "\n...(日志过长，仅显示最后 2000 字符)" : result;
      message.send(Text(`Slurm 作业 ${jobId} 日志:\n${displayResult}`));
    } catch (err: any) {
      message.send(Text(`查看日志失败: ${err.message}`));
    }
    return;
  }

  // 取消 Slurm 作业
  if (/^(\/|#)slurm\s+取消\s+(\d+)$/i.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)slurm\s+取消\s+(\d+)$/i);
    if (!match) {
      message.send(Text("格式错误，请使用: /slurm 取消 <JobID>"));
      return;
    }
    const jobId = match[2];
    
    // 获取当前环境
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const env = await getUserEnv(groupId, e.UserId);
    
    if (!env || (env.type !== "remote" && env.type !== "singularity")) {
      message.send(Text("取消作业需要在远程节点环境中，请先切换环境"));
      return;
    }
    
    if (!env.nodeName) {
      message.send(Text("未指定远程节点，请先切换环境"));
      return;
    }
    
    try {
      const result = await remoteNodeManager.cancelSlurmJob(env.nodeName, jobId);
      message.send(Text(`已取消作业 ${jobId}\n${result}`));
    } catch (err: any) {
      message.send(Text(`取消失败: ${err.message}`));
    }
    return;
  }

  // 列出 Slurm 作业
  if (/^(\/|#)slurm\s+列表$/i.test(e.msg)) {
    // 获取当前环境
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const env = await getUserEnv(groupId, e.UserId);
    
    if (!env || (env.type !== "remote" && env.type !== "singularity")) {
      message.send(Text("列出作业需要在远程节点环境中，请先切换环境"));
      return;
    }
    
    if (!env.nodeName) {
      message.send(Text("未指定远程节点，请先切换环境"));
      return;
    }
    
    try {
      const result = await remoteNodeManager.querySlurmJob(env.nodeName);
      message.send(Text(`Slurm 作业列表:\n${result}`));
    } catch (err: any) {
      message.send(Text(`查询失败: ${err.message}`));
    }
    return;
  }

  // 测试远程节点连接
  if (/^(\/|#)测试节点\s+(\S+)$/i.test(e.msg)) {
    const match = e.msg.match(/^(\/|#)测试节点\s+(\S+)$/i);
    if (!match) {
      message.send(Text("格式错误，请使用: /测试节点 <节点名称>"));
      return;
    }
    const nodeName = match[2];
    const node = remoteNodeManager.getNode(nodeName);
    
    if (!node) {
      const availableNodes = remoteNodeManager.listNodes().map(n => n.name).join(", ");
      message.send(Text(`未找到节点 "${nodeName}"，可用节点: ${availableNodes || "无"}`));
      return;
    }
    
    message.send(Text(`正在测试连接节点 ${nodeName} (${node.host}:${node.port})...`));
    
    try {
      const success = await remoteNodeManager.testConnection(nodeName);
      if (success) {
        message.send(Text(`节点 ${nodeName} 连接测试成功！`));
      } else {
        message.send(Text(`节点 ${nodeName} 连接测试失败！`));
      }
    } catch (err: any) {
      message.send(Text(`连接测试失败: ${err.message}`));
    }
    return;
  }

  // 列出远程节点上的 Singularity 镜像
  if (/^(\/|#)列出镜像\s*(\S*)$/i.test(e.msg)) {
    // 获取当前环境
    const groupId = e.name === "private.message.create" ? "private" : e.guid;
    const env = await getUserEnv(groupId, e.UserId);
    
    let nodeName = "";
    if (e.msg.trim() !== "/列出镜像" && e.msg.trim() !== "#列出镜像") {
      const match = e.msg.match(/^(\/|#)列出镜像\s+(\S+)$/i);
      nodeName = match?.[2] || "";
    } else {
      nodeName = env?.nodeName || "";
    }
    
    if (!nodeName) {
      message.send(Text("请指定节点名称: /列出镜像 <节点名称>"));
      return;
    }
    
    const node = remoteNodeManager.getNode(nodeName);
    if (!node) {
      message.send(Text(`未找到节点: ${nodeName}`));
      return;
    }
    
    if (!node.singularity) {
      message.send(Text(`节点 ${nodeName} 未启用 Singularity 支持`));
      return;
    }
    
    try {
      const images = await remoteNodeManager.listSingularityImages(nodeName);
      if (images.length === 0) {
        message.send(Text(`节点 ${nodeName} 上未找到 Singularity 镜像`));
      } else {
        message.send(Text(`节点 ${nodeName} 上的 Singularity 镜像:\n${images.join("\n")}`));
      }
    } catch (err: any) {
      message.send(Text(`列出镜像失败: ${err.message}`));
    }
    return;
  }

  next();
});
