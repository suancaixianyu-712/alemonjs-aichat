import redisClient from "@src/config";

export type PanelGroupSwitchKey =
  | "chatSwitch"
  | "imageBedSwitch"
  | "toolSwitch"
  | "toolCallContentSwitch"
  | "complexOutput"
  | "affectionSwitch"
  | "ttsResponseSwitch"
  | "deepThoughtSwitch"
  | "r18Switch"
  | "atTriggerSwitch"
  | "toolPromptSwitch"
  | "toolPromptRevokeSwitch"
  | "toolPromptArgsSwitch"
  | "proactiveSwitch";

export type PanelGroupSwitchState = Record<PanelGroupSwitchKey, boolean>;

export type PanelGroupConfigDraft = {
  guid: string;
  currentAI: string;
  model: string;
  capiContextLimit: number;
  switches: PanelGroupSwitchState;
};

export const panelGroupSwitchDefinitions: Array<{
  key: PanelGroupSwitchKey;
  label: string;
  desc: string;
}> = [
  { key: "chatSwitch", label: "聊天总开关", desc: "控制这个群是否启用聊天能力" },
  {
    key: "imageBedSwitch",
    label: "全局图床开关",
    desc: "控制 WebUI 是否允许通过代理访问图片，影响全部群",
  },
  { key: "toolSwitch", label: "工具总开关", desc: "允许模型调用已启用工具" },
  {
    key: "toolCallContentSwitch",
    label: "工具调用内容",
    desc: "展示工具调用前的回复内容",
  },
  { key: "complexOutput", label: "复杂输出", desc: "保留更完整的富文本结果" },
  { key: "affectionSwitch", label: "好感度系统", desc: "记录长期会话偏好" },
  { key: "ttsResponseSwitch", label: "语音回复", desc: "允许启用 TTS 输出" },
  { key: "deepThoughtSwitch", label: "深度思考", desc: "允许模型使用深度思考" },
  { key: "r18Switch", label: "R18开关", desc: "允许当前群启用 R18 内容" },
  { key: "atTriggerSwitch", label: "仅艾特触发", desc: "群聊中只响应艾特消息" },
  { key: "toolPromptSwitch", label: "工具提示", desc: "工具调用时发送提示" },
  {
    key: "toolPromptRevokeSwitch",
    label: "提示撤回",
    desc: "工具提示发送后自动撤回",
  },
  {
    key: "toolPromptArgsSwitch",
    label: "提示参数",
    desc: "工具提示里显示传参",
  },
  { key: "proactiveSwitch", label: "主动搭话", desc: "允许 AI 主动发起对话" },
];

const panelGroupPrefixes = [
  "ai:config:",
  "ai:currentAI:",
  "ai:tool:switch:",
  "ai:tool_prompt:switch:",
  "ai:tool_prompt_revoke:switch:",
  "ai:tool_prompt_args:switch:",
  "ai:tool_call_content:switch:",
  "ai:complex_output:",
  "ai:affection:switch:",
  "ai:tts:response:",
  "ai:deep_thought:switch:",
  "ai:r18:switch:",
  "ai:at_trigger:switch:",
  "ai:proactive:switch:",
  "ai:capi_context_limit:",
];

const uniqueGuids = (groups: string[]) =>
  [...new Set(groups.map((item) => item.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );

const stripPrefix = (prefix: string, key: string) => key.replace(prefix, "");

export const listPanelGroupGuids = async (): Promise<string[]> => {
  const keyGroups = await Promise.all(
    panelGroupPrefixes.map(async (prefix) => {
      const keys = await redisClient.redis.keys(`${prefix}*`);
      return keys.map((key) => stripPrefix(prefix, key));
    }),
  );

  return uniqueGuids(keyGroups.flat());
};

const toBool = (value: string | null | undefined) => value === "1";

export const loadPanelGroupConfig = async (
  guid: string,
): Promise<PanelGroupConfigDraft> => {
  const [
    currentAI,
    aiConfig,
    capiContextLimit,
    imageBedSwitch,
    toolSwitch,
    toolCallContentSwitch,
    complexOutput,
    affectionSwitch,
    ttsResponseSwitch,
    deepThoughtSwitch,
    r18Switch,
    atTriggerSwitch,
    toolPromptSwitch,
    toolPromptRevokeSwitch,
    toolPromptArgsSwitch,
    proactiveSwitch,
  ] = await Promise.all([
    redisClient.getCurrentAI(guid),
    redisClient.getAIConfig(guid),
    redisClient.getCAPIContextLimit(guid),
    redisClient.getImageBedSwitch(guid),
    redisClient.getToolSwitch(guid),
    redisClient.getToolCallContentSwitch(guid),
    redisClient.getComplexOutput(guid),
    redisClient.getAffectionSwitch(guid),
    redisClient.getTTSResponseSwitch(guid),
    redisClient.getDeepThoughtSwitch(guid),
    redisClient.getR18Switch(guid),
    redisClient.getAtTriggerSwitch(guid),
    redisClient.getToolPromptSwitch(guid),
    redisClient.getToolPromptRevokeSwitch(guid),
    redisClient.getToolPromptArgsSwitch(guid),
    redisClient.getProactiveSwitch(guid),
  ]);

  return {
    guid,
    currentAI,
    model: aiConfig.model || "",
    capiContextLimit,
    switches: {
      chatSwitch: Boolean(aiConfig.model && aiConfig.model.trim()),
      imageBedSwitch: toBool(imageBedSwitch),
      toolSwitch: toBool(toolSwitch),
      toolCallContentSwitch: toBool(toolCallContentSwitch),
      complexOutput: toBool(complexOutput),
      affectionSwitch: toBool(affectionSwitch),
      ttsResponseSwitch: toBool(ttsResponseSwitch),
      deepThoughtSwitch: toBool(deepThoughtSwitch),
      r18Switch: toBool(r18Switch),
      atTriggerSwitch: toBool(atTriggerSwitch),
      toolPromptSwitch: toBool(toolPromptSwitch),
      toolPromptRevokeSwitch: toBool(toolPromptRevokeSwitch),
      toolPromptArgsSwitch: toBool(toolPromptArgsSwitch),
      proactiveSwitch: toBool(proactiveSwitch),
    },
  };
};

export const loadPanelGroupConfigs = async (): Promise<PanelGroupConfigDraft[]> => {
  const guids = await listPanelGroupGuids();
  return Promise.all(guids.map((guid) => loadPanelGroupConfig(guid)));
};

export const addPanelGroupConfig = async (input: {
  guid: string;
  currentAI?: string;
  chatSwitch?: boolean;
}) => {
  const guid = input.guid.trim();
  if (!guid) {
    throw new Error("缺少群号 guid");
  }

  const existingGuids = await listPanelGroupGuids();
  if (existingGuids.includes(guid)) {
    throw new Error(`群 ${guid} 已存在`);
  }

  const nextAI = String(input.currentAI || "").trim();
  if (nextAI) {
    const aiConfig = await redisClient.getAIListConfig(nextAI);
    if (!aiConfig) {
      throw new Error(`未找到AI：${nextAI}`);
    }
  }

  // 先创建默认配置，让这个 guid 能被配置面板发现。
  await redisClient.getAIConfig(guid);

  if (nextAI) {
    await redisClient.redis.set(`ai:currentAI:${guid}`, nextAI);
  }

  if (input.chatSwitch) {
    if (!nextAI) {
      throw new Error("开启聊天总开关前，请先选择一个AI");
    }

    const switched = await redisClient.switchAI(guid, nextAI);
    if (!switched) {
      throw new Error(`切换失败，未找到AI：${nextAI}`);
    }
  }
};

export const updatePanelGroupConfig = async (input: {
  guid: string;
  currentAI?: string;
  capiContextLimit?: number;
  switches: PanelGroupSwitchState;
}) => {
  const guid = input.guid.trim();
  if (!guid) {
    throw new Error("缺少群号 guid");
  }

  const nextAI = String(input.currentAI || "").trim();
  if (!input.switches.chatSwitch) {
    await redisClient.closeChat(guid);
  } else {
    const activeAI = nextAI || (await redisClient.getCurrentAI(guid));
    if (!activeAI) {
      throw new Error("请先选择一个AI，再开启聊天总开关");
    }

    const switched = await redisClient.switchAI(guid, activeAI);
    if (!switched) {
      throw new Error(`切换失败，未找到AI：${activeAI}`);
    }
  }

  if (Number.isFinite(input.capiContextLimit) && input.capiContextLimit) {
    await redisClient.setCAPIContextLimit(guid, Number(input.capiContextLimit));
  }

  await Promise.all([
    redisClient.setImageBedSwitch(input.switches.imageBedSwitch),
    redisClient.setToolSwitch(guid, input.switches.toolSwitch),
    redisClient.setToolCallContentSwitch(
      guid,
      input.switches.toolCallContentSwitch,
    ),
    redisClient.setComplexOutput(guid, input.switches.complexOutput),
    redisClient.setAffectionSwitch(guid, input.switches.affectionSwitch),
    redisClient.setTTSResponseSwitch(guid, input.switches.ttsResponseSwitch),
    redisClient.setDeepThoughtSwitch(guid, input.switches.deepThoughtSwitch),
    redisClient.setR18Switch(guid, input.switches.r18Switch),
    redisClient.setAtTriggerSwitch(guid, input.switches.atTriggerSwitch),
    redisClient.setToolPromptSwitch(guid, input.switches.toolPromptSwitch),
    redisClient.setToolPromptRevokeSwitch(
      guid,
      input.switches.toolPromptRevokeSwitch,
    ),
    redisClient.setToolPromptArgsSwitch(
      guid,
      input.switches.toolPromptArgsSwitch,
    ),
    redisClient.setProactiveSwitch(guid, input.switches.proactiveSwitch),
  ]);
};
