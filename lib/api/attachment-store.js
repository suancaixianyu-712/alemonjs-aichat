import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const TTL = 7 * 24 * 60 * 60 * 1000;
const attachmentScope = (event) => JSON.stringify([
    String(event.Platform || ""),
    event.name === "private.message.create" || event.Name === "private.message.create" ? "private" : "group",
    String(event.guid || event.ChannelId || event.UserId || ""),
]);
const directory = (scope) => {
    if (!scope)
        throw new Error("缺少真实附件会话上下文");
    return path.join(process.env.AICHAT_ATTACHMENT_DIR || path.join(os.homedir(), ".alemonjs-aichat", "attachments"), createHash("sha256").update(scope).digest("hex"));
};
const filePath = (scope, id, ext) => {
    if (!/^[a-f0-9]{32}$/.test(id))
        throw new Error("附件 ID 无效，请使用消息中的附件 ID");
    return path.join(directory(scope), `${id}.${ext}`);
};
const listAttachments = async (scope) => {
    const dir = directory(scope);
    const names = await fs.readdir(dir).catch(() => []);
    const result = [];
    for (const name of names.filter((name) => /^[a-f0-9]{32}\.json$/.test(name))) {
        const record = await fs.readFile(path.join(dir, name), "utf8").then(JSON.parse).catch(() => null);
        if (record && Date.now() - record.createdAt < TTL)
            result.push(record);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
};
const saveAttachment = async (event, source, buffer) => {
    const scope = attachmentScope(event);
    const identity = `${event.MessageId || event.message_id || randomUUID()}:${source.FileId || source.Url || source.FileName}`;
    const id = createHash("sha256").update(identity).digest("hex").slice(0, 32);
    await fs.mkdir(directory(scope), { recursive: true, mode: 0o700 });
    // 每个会话最多保留 50 个附件及 200 MB 缓存，过期数据同时清理。
    const names = await fs.readdir(directory(scope));
    const records = [];
    for (const name of names.filter((name) => /^[a-f0-9]{32}\.json$/.test(name))) {
        const record = await fs.readFile(path.join(directory(scope), name), "utf8").then(JSON.parse).catch(() => null);
        if (record)
            records.push(record);
    }
    records.sort((a, b) => b.createdAt - a.createdAt);
    let bytes = buffer?.length || 0;
    let count = 1;
    for (const record of records) {
        if (record.id === id)
            continue;
        const size = (await fs.stat(filePath(scope, record.id, "bin")).catch(() => null))?.size || 0;
        if (Date.now() - record.createdAt >= TTL || count >= 50 || bytes + size > 200 * 1024 * 1024) {
            await fs.rm(filePath(scope, record.id, "json"), { force: true });
            await fs.rm(filePath(scope, record.id, "bin"), { force: true });
        }
        else {
            count++;
            bytes += size;
        }
    }
    const record = { id, fileName: source.FileName || "未命名文件", fileSize: buffer?.length ?? source.FileSize, createdAt: Date.now(), source };
    if (buffer)
        await fs.writeFile(filePath(scope, id, "bin"), buffer, { mode: 0o600 });
    await fs.writeFile(filePath(scope, id, "json"), JSON.stringify(record), { mode: 0o600 });
    return id;
};
const loadAttachment = async (scope, id) => {
    const record = JSON.parse(await fs.readFile(filePath(scope, id, "json"), "utf8")
        .catch(() => { throw new Error("当前会话中找不到该附件，请先 list 或重新发送文件"); }));
    if (Date.now() - record.createdAt >= TTL)
        throw new Error("附件已过期，请重新发送");
    const buffer = await fs.readFile(filePath(scope, id, "bin")).catch(() => null);
    return { record, buffer };
};
const cacheAttachmentBuffer = async (scope, id, buffer) => {
    if (buffer.length > 50 * 1024 * 1024)
        throw new Error("附件超过 50 MB");
    let total = buffer.length;
    for (const record of await listAttachments(scope)) {
        if (record.id !== id)
            total += (await fs.stat(filePath(scope, record.id, "bin")).catch(() => null))?.size || 0;
    }
    if (total > 200 * 1024 * 1024)
        throw new Error("当前会话附件缓存超过 200 MB，请稍后重发");
    await fs.writeFile(filePath(scope, id, "bin"), buffer, { mode: 0o600 });
};

export { attachmentScope, cacheAttachmentBuffer, listAttachments, loadAttachment, saveAttachment };
