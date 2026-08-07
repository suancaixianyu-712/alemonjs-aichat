import { remoteNodeManager } from './remoteNodes.js';
import redisClient from './config.js';

async function getUserEnv(groupId, userId) {
    const env = await redisClient.getExecEnv(groupId, userId);
    if (!env)
        return null;
    return {
        type: env.type || "group",
        nodeName: env.nodeName,
        singularityImage: env.singularityImage,
        containerName: env.containerName,
    };
}
async function setUserEnv(groupId, userId, config) {
    await redisClient.setExecEnv(groupId, userId, config);
}
async function initUserEnv(groupId, userId) {
    const existing = await getUserEnv(groupId, userId);
    if (existing)
        return existing;
    if (groupId === "private") {
        const config = { type: "user" };
        await setUserEnv(groupId, userId, config);
        return config;
    }
    else {
        const config = { type: "group" };
        await setUserEnv(groupId, userId, config);
        return config;
    }
}
async function switchToSystem(groupId, userId) {
    await redisClient.switchToSystemEnv(groupId, userId);
    return "已切换到系统环境";
}
async function switchToGroup(groupId, userId) {
    if (groupId === "private") {
        return "私聊无法切换到群容器";
    }
    await redisClient.switchToGroupContainer(groupId, userId);
    return "已切换到群容器";
}
async function switchToGroupById(targetGroupId, userId) {
    const config = await redisClient.switchToGroupContainer(targetGroupId, userId);
    return `已切换到群容器\n容器: ${config.containerName}\n镜像: ${config.image}`;
}
async function switchToUser(groupId, userId) {
    await redisClient.switchToUserContainer(groupId, userId);
    return "已切换到用户容器";
}
async function switchToRemote(groupId, userId, nodeName) {
    const node = remoteNodeManager.getNode(nodeName);
    if (!node) {
        const availableNodes = remoteNodeManager.listNodes().map(n => n.name).join(", ");
        return `未找到远程节点 "${nodeName}"，可用节点: ${availableNodes || "无"}`;
    }
    await redisClient.switchToRemoteEnv(groupId, userId, nodeName);
    return `已切换到远程节点 "${nodeName}" (${node.host}:${node.port})`;
}
async function switchToSingularity(groupId, userId, nodeName, image) {
    const node = remoteNodeManager.getNode(nodeName);
    if (!node) {
        const availableNodes = remoteNodeManager.listNodes().map(n => n.name).join(", ");
        return `未找到远程节点 "${nodeName}"，可用节点: ${availableNodes || "无"}`;
    }
    if (!node.singularity) {
        return `节点 "${nodeName}" 未启用 Singularity 支持`;
    }
    await redisClient.switchToSingularityEnv(groupId, userId, nodeName, image);
    const imageInfo = image || node.defaultImage ? ` (镜像: ${image || node.defaultImage})` : "";
    return `已切换到 Singularity 容器，节点: "${nodeName}"${imageInfo}`;
}
async function getEnvDescription(groupId, userId) {
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
            const image = env.singularityImage ? `, 镜像: ${env.singularityImage}` : "";
            return `Singularity 容器 (节点: ${env.nodeName}${image})`;
        }
        default:
            return "未知环境";
    }
}
async function listAvailableEnvs() {
    let result = "可用环境:\n";
    result += "1. system - 系统环境\n";
    result += "2. group - 群容器\n";
    result += "3. user - 用户容器\n";
    const remoteNodes = remoteNodeManager.listNodes();
    if (remoteNodes.length > 0) {
        result += "\n远程节点:\n";
        remoteNodes.forEach((node, index) => {
            result += `${index + 4}. remote ${node.name} - ${node.host}:${node.port}`;
            if (node.slurm)
                result += " [Slurm]";
            if (node.singularity)
                result += " [Singularity]";
            result += "\n";
        });
    }
    return result.trim();
}
async function getExecCommandEnv(groupId, userId) {
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

export { getEnvDescription, getExecCommandEnv, getUserEnv, initUserEnv, listAvailableEnvs, setUserEnv, switchToGroup, switchToGroupById, switchToRemote, switchToSingularity, switchToSystem, switchToUser };
