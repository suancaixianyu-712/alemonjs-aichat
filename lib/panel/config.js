import React from 'react';
import { defineConfig } from 'jsxp';
import { existsSync, readdirSync } from 'fs';
import App$1 from '../image/conponent/help.js';
import App from '../image/conponent/AiConfig.js';
import PanelPreview from '../image/conponent/PanelPreview.js';
import redisClient from '../config.js';
import { loadPanelGroupConfig, listPanelGroupGuids, loadPanelGroupConfigs } from './groupConfig.js';
import { resolvePanelChatIdentity, getPanelChatMessagesForDisplay, PANEL_BOT_ID } from './chat.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const panelDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(panelDir, "..", "..");
const runtimeRoot = join(panelDir, "..");
const panelPort = Number(process.env.JSXP_PORT || process.env.PORT || 8080);
const toErrorMessage = (error) => error instanceof Error ? error.message : String(error);
const withTimeout = async (promise, ms, message) => Promise.race([
    promise,
    new Promise((_, reject) => {
        setTimeout(() => reject(new Error(message)), ms);
    }),
]);
const getPanelCurrentAI = async () => {
    const currentKeys = await redisClient.redis.keys("ai:currentAI:*");
    const currentKey = currentKeys[0];
    if (!currentKey) {
        return {
            currentAI: "",
            currentGuid: "global",
        };
    }
    return {
        currentAI: (await redisClient.redis.get(currentKey)) || "",
        currentGuid: currentKey.replace("ai:currentAI:", "") || "global",
    };
};
const getPanelQueryText = (ctx, key) => {
    const value = ctx?.query?.[key];
    if (Array.isArray(value))
        return String(value[0] || "");
    return String(value || "");
};
const parsePanelOpenRows = (value) => {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((item) => typeof item === "string")
            : [];
    }
    catch {
        return [];
    }
};
const parsePanelOpenGroups = (value) => {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((item) => typeof item === "string")
            : [];
    }
    catch {
        return [];
    }
};
const parsePanelScrollY = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const loadPanelAIConfigs = async () => {
    const names = await withTimeout(redisClient.getAIList(), 1200, "读取 ai:list:* 超时");
    const aiConfigs = await withTimeout(Promise.all(names.map(async (name) => {
        const raw = await redisClient.redis.get(`ai:list:${name}`);
        if (!raw)
            return null;
        const config = JSON.parse(raw);
        return {
            name,
            host: config.host || "",
            key: config.key || "",
            model: config.model || "",
        };
    })), 1200, "读取 ai:list 详情超时");
    return aiConfigs.filter((item) => Boolean(item));
};
const loadPanelWorkspaceNames = async () => {
    const publicRoot = join(process.cwd(), "public");
    if (!existsSync(publicRoot)) {
        return [];
    }
    const ignoredNames = new Set(["sandbox", "image_out"]);
    return readdirSync(publicRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !ignoredNames.has(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, "zh-CN"));
};
const loadPanelPromptOptions = async () => {
    const names = await withTimeout(redisClient.getPromptList(), 1200, "读取 ai:prompt:* 超时");
    return withTimeout(Promise.all(names.map(async (name) => {
        const content = await redisClient.getPrompt(name);
        if (content === null)
            return null;
        return { name, content };
    })), 1200, "读取 ai:prompt 详情超时").then((items) => items.filter((item) => Boolean(item)));
};
const loadPanelProps = async (page, ctx) => {
    const panelStatus = getPanelQueryText(ctx, "panelStatus");
    const panelMessage = getPanelQueryText(ctx, "panelMessage");
    const restoreGroupListOpen = getPanelQueryText(ctx, "panelGroupListOpen") !== "0";
    const restoreAiListOpen = getPanelQueryText(ctx, "panelAiListOpen") === "1";
    const restoreOpenGroups = parsePanelOpenGroups(getPanelQueryText(ctx, "panelOpenGroups"));
    const restoreOpenRows = parsePanelOpenRows(getPanelQueryText(ctx, "panelOpenRows"));
    const restoreScrollY = parsePanelScrollY(getPanelQueryText(ctx, "panelScrollY"));
    const chatConfigOpen = getPanelQueryText(ctx, "chatConfigOpen") === "1";
    if (page === "chat") {
        const identity = await resolvePanelChatIdentity(getPanelQueryText(ctx, "guid"), getPanelQueryText(ctx, "userId"), getPanelQueryText(ctx, "nickname"));
        const chatMessages = await withTimeout(getPanelChatMessagesForDisplay(identity.guid, identity.userId), 1200, "读取网页聊天记录超时").catch(() => []);
        const aiConfig = await withTimeout(redisClient.getAIConfig(identity.guid), 800, "读取当前聊天AI配置超时").catch(() => null);
        const aiConfigs = await loadPanelAIConfigs().catch(() => []);
        const currentAI = await withTimeout(redisClient.getCurrentAI(identity.guid), 800, "读取当前AI名称超时").catch(() => "");
        const currentGroupConfig = await withTimeout(loadPanelGroupConfig(identity.guid), 1200, "读取当前群配置超时").catch(() => null);
        const groupGuidOptions = await withTimeout(listPanelGroupGuids(), 1200, "读取群号列表超时").catch(() => []);
        const workspaceNames = await withTimeout(loadPanelWorkspaceNames(), 1200, "读取工作区目录列表超时").catch(() => []);
        const promptOptions = await loadPanelPromptOptions().catch(() => []);
        const currentPrompt = promptOptions.find((item) => item.content === aiConfig?.systemPrompt)
            ?.name || "";
        return {
            page,
            currentGuid: identity.guid,
            aiConfigs,
            currentAI,
            chatGuid: identity.guid,
            chatUserId: identity.userId,
            chatNickname: identity.nickname,
            chatBotId: PANEL_BOT_ID,
            chatModel: aiConfig?.model || "",
            groupGuidOptions,
            workspaceNames,
            promptOptions,
            currentPrompt,
            chatMessages,
            currentGroupConfig,
            panelStatus,
            panelMessage,
            chatConfigOpen,
        };
    }
    try {
        const aiConfigs = await loadPanelAIConfigs();
        const currentState = await withTimeout(getPanelCurrentAI(), 800, "读取 ai:currentAI 超时").catch(() => ({ currentAI: "", currentGuid: "global" }));
        const groupConfigs = await withTimeout(loadPanelGroupConfigs(), 1500, "读取群配置列表超时").catch(() => []);
        return {
            page,
            aiConfigs,
            groupConfigs,
            currentAI: currentState.currentAI,
            currentGuid: currentState.currentGuid,
            panelStatus,
            panelMessage,
            restoreGroupListOpen,
            restoreOpenGroups,
            restoreAiListOpen,
            restoreOpenRows,
            restoreScrollY,
        };
    }
    catch (error) {
        return {
            page,
            aiConfigs: [],
            groupConfigs: [],
            currentAI: "",
            currentGuid: "global",
            redisError: toErrorMessage(error),
            panelStatus,
            panelMessage,
            restoreGroupListOpen,
            restoreOpenGroups,
            restoreAiListOpen,
            restoreOpenRows,
            restoreScrollY,
        };
    }
};
const statics = [
    join(runtimeRoot, "assets"),
    join(packageRoot, "public"),
    join(process.cwd(), "public"),
].filter((item, index, list) => list.indexOf(item) === index);
var panelConfig = defineConfig({
    port: Number.isFinite(panelPort) && panelPort > 0 ? panelPort : 8080,
    statics,
    routes: {
        "/": {
            component: React.createElement(App$1, null),
        },
        "/panel": {
            element: PanelPreview,
            propsCall: (ctx) => loadPanelProps("config", ctx),
        },
        "/panel/config": {
            element: PanelPreview,
            propsCall: (ctx) => loadPanelProps("config", ctx),
        },
        "/panel/chat": {
            element: PanelPreview,
            propsCall: (ctx) => loadPanelProps("chat", ctx),
        },
        "/ai-config": {
            component: (React.createElement(App, { switch: true, tools: true, complex: true, affection: true, tts: true, deep: false, model: "gpt-4", prompt: "\u4F60\u662F\u4E00\u4E2A\u53CB\u597D\u7684AI\u52A9\u624B", atTrigger: false, currentAI: "OpenAI", aiList: ["OpenAI", "Claude", "Gemini"], skillList: [
                    { name: "use-alemon", description: "控制AI配置和框架开关" },
                    { name: "send-media", description: "发送图片、音频和视频等媒体" },
                ], toolList: { 搜索工具: "0", 翻译工具: "1" }, toolPromptSwitch: true, toolPromptRevokeSwitch: false, toolPromptArgsSwitch: true, toolCallContentSwitch: false, imageBedSwitch: true })),
        },
    },
});

export { panelConfig as default };
