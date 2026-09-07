import redisClient from '../../config.js';
import { Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';

const selects = onSelects(["message.create", "private.message.create"]);
const SESSION_TTL_SECONDS = 10 * 60;
const PROVIDER_ORDER = ["deepseek", "openai", "grok", "other"];
const PROVIDERS = {
    deepseek: {
        name: "DeepSeek",
        host: "https://api.deepseek.com",
        modelsPath: "/models",
    },
    openai: {
        name: "OpenAI",
        host: "https://api.openai.com/v1",
        modelsPath: "/models",
    },
    grok: {
        name: "Grok",
        host: "https://api.x.ai/v1",
        modelsPath: "/language-models",
    },
    other: {
        name: "其他",
        host: "",
        modelsPath: "",
    },
};
const providerMenu = [
    "请选择 AI 厂商：",
    "1. DeepSeek",
    "2. OpenAI",
    "3. Grok",
    "4. 其他",
    "",
    "请回复厂商前的序号，发送“取消”可终止添加。",
].join("\n");
const getSessionKey = (e) => {
    const platform = String(e.Platform || e.platform || e.name || "unknown");
    const userId = String(e.UserId || e.user_id || "unknown");
    return `ai:add:session:${platform}:${e.guid}:${userId}`;
};
const readSession = async (key) => {
    const value = await redisClient.redis.get(key);
    if (!value)
        return null;
    try {
        return JSON.parse(value);
    }
    catch {
        await redisClient.redis.del(key);
        return null;
    }
};
const writeSession = async (key, session) => {
    await redisClient.redis.set(key, JSON.stringify(session), "EX", SESSION_TTL_SECONDS);
};
const isOpenAIChatModel = (model) => {
    const id = model.toLowerCase();
    const excluded = [
        "embedding",
        "moderation",
        "whisper",
        "transcribe",
        "tts",
        "realtime",
        "audio",
        "image",
        "dall-e",
        "sora",
        "babbage",
        "davinci",
    ];
    return !excluded.some((value) => id.includes(value));
};
const fetchModels = async (provider, key) => {
    const config = PROVIDERS[provider];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(`${config.host}${config.modelsPath}`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const body = (await response.json());
        const source = provider === "grok" ? body.models : body.data;
        const models = (Array.isArray(source) ? source : [])
            .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
            .filter(Boolean)
            .filter((model) => provider !== "openai" || isOpenAIChatModel(model));
        return [...new Set(models)].sort((a, b) => a.localeCompare(b));
    }
    finally {
        clearTimeout(timeout);
    }
};
const formatModelMenu = (provider, models) => {
    return [
        `${PROVIDERS[provider].name} 可用模型：`,
        ...models.map((model, index) => `${index + 1}. ${model}`),
        "",
        "请回复模型前的序号，发送“取消”可终止添加。",
    ].join("\n");
};
const handleAddAIMessage = async (e) => {
    const text = String(e.msg || "").trim();
    const sessionKey = getSessionKey(e);
    let session = await readSession(sessionKey);
    if (/^(#|\/)添加ai$/i.test(text)) {
        await redisClient.redis.del(sessionKey.replace("ai:add:session:", "ai:switch:session:"));
        session = { stage: "provider" };
        await writeSession(sessionKey, session);
        const [message] = useMessage(e);
        await message.send(format(Text(providerMenu)));
        return true;
    }
    if (!session)
        return false;
    const [message] = useMessage(e);
    if (text === "取消") {
        await redisClient.redis.del(sessionKey);
        await message.send(format(Text("已取消添加 AI。")));
        return true;
    }
    if (session.stage === "provider") {
        const provider = PROVIDER_ORDER[Number(text) - 1];
        if (!provider) {
            await writeSession(sessionKey, session);
            await message.send(format(Text(`序号无效，请重新选择。\n\n${providerMenu}`)));
            return true;
        }
        await writeSession(sessionKey, { stage: "key", provider });
        await message.send(format(Text(`已选择 ${PROVIDERS[provider].name}，请输入 API Key。`)));
        return true;
    }
    if (session.stage === "key" && session.provider) {
        if (!text) {
            await writeSession(sessionKey, session);
            await message.send(format(Text("API Key 不能为空，请重新填写。")));
            return true;
        }
        if (session.provider === "other") {
            await writeSession(sessionKey, {
                stage: "host",
                provider: "other",
                key: text,
            });
            await message.send(format(Text("请输入服务器地址。")));
            return true;
        }
        try {
            const models = await fetchModels(session.provider, text);
            if (models.length === 0) {
                throw new Error("empty model list");
            }
            await writeSession(sessionKey, {
                stage: "model",
                provider: session.provider,
                key: text,
                models,
            });
            await message.send(format(Text(formatModelMenu(session.provider, models))));
        }
        catch {
            await writeSession(sessionKey, {
                stage: "key",
                provider: session.provider,
            });
            await message.send(format(Text(`无法获取 ${PROVIDERS[session.provider].name} 模型列表，请重新填写可用的 API Key。`)));
        }
        return true;
    }
    if (session.stage === "host" && session.provider === "other" && session.key) {
        let host;
        try {
            host = new URL(text);
            if (host.protocol !== "http:" && host.protocol !== "https:") {
                throw new Error("invalid protocol");
            }
        }
        catch {
            await writeSession(sessionKey, session);
            await message.send(format(Text("服务器地址无效，请填写以 http:// 或 https:// 开头的地址。")));
            return true;
        }
        await writeSession(sessionKey, {
            stage: "manual-model",
            provider: "other",
            key: session.key,
            host: host.toString().replace(/\/$/, ""),
        });
        await message.send(format(Text("请输入模型名称。")));
        return true;
    }
    if (session.stage === "manual-model" &&
        session.provider === "other" &&
        session.key &&
        session.host) {
        if (!text) {
            await writeSession(sessionKey, session);
            await message.send(format(Text("模型名称不能为空，请重新填写。")));
            return true;
        }
        await redisClient.addAI(e.guid, text, session.host, session.key, text, "other");
        await redisClient.redis.del(sessionKey);
        await message.send(format(Text(`AI other/${text} 添加成功，已切换到该模型。`)));
        return true;
    }
    if (session.stage === "model" &&
        session.provider &&
        session.key &&
        session.models) {
        const model = session.models[Number(text) - 1];
        if (!model) {
            await writeSession(sessionKey, session);
            await message.send(format(Text(`序号无效，请重新选择。\n\n${formatModelMenu(session.provider, session.models)}`)));
            return true;
        }
        const config = PROVIDERS[session.provider];
        await redisClient.addAI(e.guid, model, config.host, session.key, model, session.provider);
        await redisClient.redis.del(sessionKey);
        await message.send(format(Text(`AI ${session.provider}/${model} 添加成功，已切换到该模型。`)));
        return true;
    }
    await redisClient.redis.del(sessionKey);
    await message.send(format(Text("添加 AI 会话状态异常，请重新发送 #添加ai。")));
    return true;
};
var res = onResponse(selects, async (e, next) => {
    if (await handleAddAIMessage(e))
        return;
    return next();
});

export { res as default, handleAddAIMessage };
