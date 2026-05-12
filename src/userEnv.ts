import { getConfigValue } from "alemonjs";
import { redis as redisClient } from "./redis";
import { remoteNodeManager } from "./remoteNodes";

/**
 * 环境类型
 */
export type EnvType = "system" | "group" | "user" | "remote" | "singularity";

/**
 * 用户环境配置
 */
export interface UserEnvConfig {
  type: EnvType;
  // 远程节点相关
  nodeName?: string;
  // Singularity 相关
  singularityImage?: string;
  // 容器相关（群/用户容器）
  containerName?: string;
}

/**
 * 获取用户当前环境配置
 * @param groupId 群 ID，私聊为 "private"
 * @param userId 用户 ID
 * @returns 环境配置，如果未设置则返回 null
 */
export async function getUserEnv(groupId: string, userId: string): Promise<UserEnvConfig | null> {
  const key = groupId === "private"
    ? `ai:user:env:private:${userId}`
    : `ai:user:env:${groupId}:${userId}`;
  
  const str = await redisClient.get(key);
  if (!str) return null;
  
  try {
    return JSON.parse(str) as UserEnvConfig;
  } catch {
    return null;
  }
}

/**
 * 设置用户环境配置
 * @param groupId 群 ID，私聊为 "private"
 * @param userId 用户 ID
 * @param config 环境配置
 */
export async function setUserEnv(
  groupId: string, 
  userId: string, 
  config: UserEnvConfig
): Promise<void> {
  const key = groupId === "private"
    ? `ai:user:env:private:${userId}`
    : `ai:user:env:${groupId}:${userId}`;
  
  await redisClient.set(key, JSON.stringify(config));
}

/**
 * 初始化用户环境（如果未设置，则根据上下文设置默认值）
 */
export async function initUserEnv(groupId: string, userId: string): Promise<UserEnvConfig> {
  const existing = await getUserEnv(groupId, userId);
  if (existing) return existing;

  // 默认值：群聊用群容器，私聊用用户容器
  if (groupId === "private") {
    const config: UserEnvConfig = { type: "user" };
    await setUserEnv(groupId, userId, config);
    return config;
  } else {
    const config: UserEnvConfig = { type: "group" };
    await setUserEnv(groupId, userId, config);
    return config;
  }
}

/**
 * 切换到系统环境
 */
export async function switchToSystem(groupId: string, userId: string): Promise<string> {
  const config: UserEnvConfig = { type: "system" };
  await setUserEnv(groupId, userId, config);
  return "已切换到系统环境";
}

/**
 * 切换到群容器
 */
export async function switchToGroup(groupId: string, userId: string): Promise<string> {
  if (groupId === "private") {
    return "私聊无法切换到群容器";
  }
  const config: UserEnvConfig = { type: "group" };
  await setUserEnv(groupId, userId, config);
  return "已切换到群容器";
}

/**
 * 切换到用户容器
 */
export async function switchToUser(groupId: string, userId: string): Promise<string> {
  const config: UserEnvConfig = { type: "user" };
  await setUserEnv(groupId, userId, config);
  return "已切换到用户容器";
}

/**
 * 切换到远程节点
 */
export async function switchToRemote(
  groupId: string, 
  userId: string, 
  nodeName: string
): Promise<string> {
  const node = remoteNodeManager.getNode(nodeName);
  if (!node) {
    const availableNodes = remoteNodeManager.listNodes().map(n => n.name).join(", ");
    return `未找到远程节点 "${nodeName}"，可用节点: ${availableNodes || "无"}`;
  }

  const config: UserEnvConfig = { 
    type: "remote", 
    nodeName 
  };
  await setUserEnv(groupId, userId, config);
  return `已切换到远程节点 "${nodeName}" (${node.host}:${node.port})`;
}

/**
 * 切换到 Singularity 容器
 */
export async function switchToSingularity(
  groupId: string,
  userId: string,
  nodeName: string,
  image?: string
): Promise<string> {
  const node = remoteNodeManager.getNode(nodeName);
  if (!node) {
    const availableNodes = remoteNodeManager.listNodes().map(n => n.name).join(", ");
    return `未找到远程节点 "${nodeName}"，可用节点: ${availableNodes || "无"}`;
  }

  if (!node.singularity) {
    return `节点 "${nodeName}" 未启用 Singularity 支持`;
  }

  const config: UserEnvConfig = { 
    type: "singularity", 
    nodeName,
    singularityImage: image || node.defaultImage
  };
  await setUserEnv(groupId, userId, config);

  const imageInfo = image || node.defaultImage ? ` (镜像: ${image || node.defaultImage})` : "";
  return `已切换到 Singularity 容器，节点: "${nodeName}"${imageInfo}`;
}

/**
 * 获取当前环境描述
 */
export async function getEnvDescription(groupId: string, userId: string): Promise<string> {
  const env = await getUserEnv(groupId, userId);
  if (!env) {
    await initUserEnv(groupId, userId);
    return await getEnvDescription(groupId, userId);
  }

  switch (env.type) {
    case "system":
      return "系统环境";
    case "group":
      return "群容器";
    case "user":
      return "用户容器";
    case "remote": {
      const node = remoteNodeManager.getNode(env.nodeName || "");
      return `远程节点: ${env.nodeName} (${node ? node.host : "未知"})`;
    }
    case "singularity": {
      const node = remoteNodeManager.getNode(env.nodeName || "");
      const image = env.singularityImage ? `, 镜像: ${env.singularityImage}` : "";
      return `Singularity 容器 (节点: ${env.nodeName}${image})`;
    }
    default:
      return "未知环境";
  }
}

/**
 * 列出所有可用环境
 */
export async function listAvailableEnvs(): Promise<string> {
  const configValue = getConfigValue();
  const aiChatConfig = configValue.aiChat || {};
  
  let result = "可用环境:\n";
  result += "1. system - 系统环境\n";
  result += "2. group - 群容器\n";
  result += "3. user - 用户容器\n";
  
  const remoteNodes = remoteNodeManager.listNodes();
  if (remoteNodes.length > 0) {
    result += "\n远程节点:\n";
    remoteNodes.forEach((node, index) => {
      result += `${index + 4}. remote ${node.name} - ${node.host}:${node.port}`;
      if (node.slurm) result += " [Slurm]";
      if (node.singularity) result += " [Singularity]";
      result += "\n";
    });
  }
  
  return result.trim();
}

/**
 * 根据环境配置获取执行命令的方式
 */
export async function getExecCommandEnv(groupId: string, userId: string): Promise<{
  type: EnvType;
  nodeName?: string;
  nodeConfig?: ReturnType<typeof remoteNodeManager.getNode>;
  singularityImage?: string;
}> {
  const env = await getUserEnv(groupId, userId);
  if (!env) {
    await initUserEnv(groupId, userId);
    return await getExecCommandEnv(groupId, userId);
  }

  if (env.type === "remote" || env.type === "singularity") {
    const nodeConfig = remoteNodeManager.getNode(env.nodeName || "");
    return {
      type: env.type,
      nodeName: env.nodeName,
      nodeConfig,
      singularityImage: env.singularityImage,
    };
  }

  return { type: env.type };
}
