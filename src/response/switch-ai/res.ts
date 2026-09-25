import redisClient from "@src/config";
import type { AIConfig } from "@src/types";
import { Text } from "alemonjs";
import { useMessage } from "@src/utils/command-message";
import { toolSessionController } from "@src/api/tool-session-controller";
import { getLockedAIMessage } from "@src/api/ai-lock";

const selects = onSelects(["message.create", "private.message.create"]);

type Provider = NonNullable<AIConfig["provider"]>;
type SwitchAISession = {
  stage: "provider" | "model";
  provider?: Provider;
  models?: string[];
  displayModels?: string[];
};

const SESSION_TTL_SECONDS = 10 * 60;
const PROVIDER_ORDER: Provider[] = ["deepseek", "openai", "grok", "other"];
const PROVIDER_LABELS: Record<Provider, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  grok: "Grok",
  other: "其他",
};

const providerMenu = [
  "请选择 AI 厂商：",
  "1. DeepSeek",
  "2. OpenAI",
  "3. Grok",
  "4. 其他",
  "",
  "请回复厂商前的序号，发送“取消”可终止切换。",
].join("\n");

const getSessionKey = (e: any, flow = "switch") => {
  const platform = String(e.Platform || e.platform || e.name || "unknown");
  const userId = String(e.UserId || e.user_id || "unknown");
  return `ai:${flow}:session:${platform}:${e.guid}:${userId}`;
};

const readSession = async (key: string): Promise<SwitchAISession | null> => {
  const value = await redisClient.redis.get(key);
  if (!value) return null;
  try {
    return JSON.parse(value) as SwitchAISession;
  } catch {
    await redisClient.redis.del(key);
    return null;
  }
};

const writeSession = async (key: string, session: SwitchAISession) => {
  await redisClient.redis.set(
    key,
    JSON.stringify(session),
    "EX",
    SESSION_TTL_SECONDS,
  );
};

const normalizeProvider = (value: string): Provider | null => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "其他") return "other";
  return PROVIDER_ORDER.includes(normalized as Provider)
    ? (normalized as Provider)
    : null;
};

const getProviderModels = async (provider: Provider) => {
  const prefix = `${provider}/`;
  return (await redisClient.getAIList())
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .sort((a, b) => a.localeCompare(b));
};

const formatModelMenu = (
  provider: Provider,
  models: string[],
  displayModels: string[] = models,
  lockedAI: Set<string> = new Set(),
) =>
  [
    `${PROVIDER_LABELS[provider]} 模型列表：`,
    ...models.map(
      (model, index) =>
        `${index + 1}. ${lockedAI.has(`${provider}/${model}`) ? "🔒 " : ""}${displayModels[index] || model}`,
    ),
    "",
    "请回复模型前的序号，发送“取消”可终止切换。",
  ].join("\n");

const showProviderModels = async (
  e: any,
  provider: Provider,
  sessionKey: string,
) => {
  const [message] = useMessage(e);
  const models = await getProviderModels(provider);
  if (models.length === 0) {
    await redisClient.redis.del(sessionKey);
    await message.send(
      format(Text(`${PROVIDER_LABELS[provider]} 下还没有可用模型。`)),
    );
    return;
  }
  const lockedAI = new Set(await redisClient.getLockedAIList());
  const displayModels = await redisClient.getAIDisplayNames(
    models.map((model) => `${provider}/${model}`),
    false,
  );
  await writeSession(sessionKey, {
    stage: "model",
    provider,
    models,
    displayModels,
  });
  await message.send(
    format(Text(formatModelMenu(provider, models, displayModels, lockedAI))),
  );
};

const switchToModel = async (e: any, identifier: string) => {
  const [message] = useMessage(e);
  if (e.IsMaster !== true && (await redisClient.isAILocked(identifier))) {
    await message.send(format(Text(getLockedAIMessage(identifier))));
    return false;
  }
  const ai = await redisClient.switchAI(e.guid, identifier);
  if (!ai) {
    await message.send(format(Text(`切换失败，未找到 AI ${identifier}。`)));
    return false;
  }
  await toolSessionController.syncModelFromCurrentAI(e.guid);
  await message.send(
    format(
      Text(`已切换到 AI ${identifier}。`),
      Text(`\n模型：${ai.model}`),
      Text(`\n接口：${ai.apiMode === "rapi" ? "RAPI" : "CAPI"}`),
    ),
  );
  return true;
};

export const handleSwitchAIMessage = async (e: any): Promise<boolean> => {
  const text = String(e.msg || "").trim();
  const command = text.match(/^(#|\/)切换(?:ai|配置)(?:\s+(.+))?$/i);
  const sessionKey = getSessionKey(e);
  const session = await readSession(sessionKey);

  if (command) {
    await redisClient.redis.del(getSessionKey(e, "add"));
    const argument = String(command[2] || "").trim();
    if (!argument) {
      await writeSession(sessionKey, { stage: "provider" });
      const [message] = useMessage(e);
      await message.send(format(Text(providerMenu)));
      return true;
    }

    const separatorIndex = argument.indexOf("/");
    if (separatorIndex > 0) {
      const provider = normalizeProvider(argument.slice(0, separatorIndex));
      const model = argument.slice(separatorIndex + 1).trim();
      if (!provider || !model) {
        const [message] = useMessage(e);
        await message.send(
          format(Text("格式错误，请使用：#切换AI <厂商>/<模型名称>")),
        );
        return true;
      }
      await redisClient.redis.del(sessionKey);
      await switchToModel(e, `${provider}/${model}`);
      return true;
    }

    const provider = normalizeProvider(argument);
    if (!provider) {
      const [message] = useMessage(e);
      await message.send(format(Text(`厂商不存在。\n\n${providerMenu}`)));
      return true;
    }
    await showProviderModels(e, provider, sessionKey);
    return true;
  }

  if (!session) return false;
  const [message] = useMessage(e);
  if (text === "取消") {
    await redisClient.redis.del(sessionKey);
    await message.send(format(Text("已取消切换 AI。")));
    return true;
  }

  if (session.stage === "provider") {
    const provider = PROVIDER_ORDER[Number(text) - 1];
    if (!provider) {
      await writeSession(sessionKey, session);
      await message.send(
        format(Text(`序号无效，请重新选择。\n\n${providerMenu}`)),
      );
      return true;
    }
    await showProviderModels(e, provider, sessionKey);
    return true;
  }

  if (session.stage === "model" && session.provider && session.models) {
    const model = session.models[Number(text) - 1];
    if (!model) {
      await writeSession(sessionKey, session);
      const lockedAI = new Set(await redisClient.getLockedAIList());
      await message.send(
        format(
          Text(
            `序号无效，请重新选择。\n\n${formatModelMenu(session.provider, session.models, session.displayModels, lockedAI)}`,
          ),
        ),
      );
      return true;
    }
    await redisClient.redis.del(sessionKey);
    await switchToModel(e, `${session.provider}/${model}`);
    return true;
  }

  await redisClient.redis.del(sessionKey);
  await message.send(
    format(Text("切换 AI 会话状态异常，请重新发送 #切换AI。")),
  );
  return true;
};

export default onResponse(selects, async (e, next) => {
  if (await handleSwitchAIMessage(e)) return;
  return next();
});
