import { createHash, randomUUID } from 'node:crypto';

const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 只记录当前聊天、用户和工作目录通过工具创建的会话。 */
class CodexSessionStore {
    redis;
    directory;
    prefix;
    constructor(redis, guid, userID, directory) {
        this.redis = redis;
        this.directory = directory;
        const scope = createHash("sha256")
            .update(JSON.stringify([guid, userID, directory]))
            .digest("hex");
        this.prefix = `ai:codex_tool:${scope}`;
    }
    parse(raw) {
        try {
            const session = JSON.parse(raw || "null");
            if (!session ||
                !CODEX_SESSION_ID_RE.test(session.id) ||
                session.directory !== this.directory ||
                typeof session.title !== "string" ||
                !Number.isFinite(session.createdAt) ||
                !Number.isFinite(session.updatedAt))
                return null;
            return session;
        }
        catch {
            return null;
        }
    }
    async get(id) {
        return this.parse(await this.redis.hget(`${this.prefix}:sessions`, id));
    }
    async current() {
        const id = await this.redis.get(`${this.prefix}:current`);
        return id ? this.get(id) : null;
    }
    async list() {
        const values = await this.redis.hgetall(`${this.prefix}:sessions`);
        return Object.values(values)
            .map((raw) => this.parse(raw))
            .filter((session) => session !== null)
            .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    }
    async select(id) {
        const session = await this.get(id);
        if (!session)
            throw new Error("未找到当前聊天、用户和工作目录下的 Codex 会话");
        await this.redis.set(`${this.prefix}:current`, id);
        return session;
    }
    async save(input) {
        if (!CODEX_SESSION_ID_RE.test(input.id)) {
            throw new Error("Codex 返回了无效的会话 UUID");
        }
        const previous = await this.get(input.id);
        const now = Date.now();
        const session = {
            id: input.id,
            title: previous?.title || input.prompt.replace(/\s+/g, " ").slice(0, 100),
            directory: this.directory,
            model: input.model || previous?.model || null,
            status: input.status,
            createdAt: previous?.createdAt || now,
            updatedAt: now,
        };
        await this.redis.hset(`${this.prefix}:sessions`, session.id, JSON.stringify(session));
        await this.redis.set(`${this.prefix}:current`, session.id);
        return session;
    }
    /** 跨机器人进程互斥，避免同一会话同时执行或切换。 */
    async acquire(timeoutSeconds) {
        const key = `${this.prefix}:lock`;
        const token = randomUUID();
        const acquired = await this.redis.set(key, token, "EX", timeoutSeconds + 30, "NX");
        if (acquired !== "OK") {
            throw new Error("当前 Codex 会话正在执行，请等待完成或使用 #stop 中止任务");
        }
        return async () => {
            await this.redis.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', 1, key, token);
        };
    }
}

export { CODEX_SESSION_ID_RE, CodexSessionStore };
