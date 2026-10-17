import { createHash } from 'node:crypto';
import { stat, readFile, mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AUDIO_EXTS } from '../protocol.js';

/**
 * 内容寻址缓存。
 *
 * 朗读一条消息的代价很高（要驱动浏览器投递 + DS 合成 + 可能等模型回显），
 * 所以缓存不是"优化"而是刚需：同一条消息第二次朗读必须秒回。
 * id = sha1(音色|模式|格式|归一化文本) 前 16 位 hex，文件名即身份。
 */
/**
 * 计算内容寻址 id。
 * @param parts - 参与身份计算的字段（顺序敏感）。
 * @returns 16 位小写 hex。
 */
function cacheId(parts) {
    const hash = createHash('sha1');
    for (const part of parts) {
        hash.update(`${part.length.toString()}:`);
        hash.update(part);
    }
    return hash.digest('hex').slice(0, 16);
}
/** 某个 id 的元数据文件路径。 */
function cacheMetaPath(dir, id) {
    return join(dir, `${id}.json`);
}
/**
 * 本次请求是否应该读缓存。
 *
 * 抽成纯函数是为了能单测这条**关键行为**：`regenerate` 时必须跳过缓存读取，
 * 否则"重新生成"会直接命中旧音频秒回，功能等于没做。
 * @param cacheEnabled - 配置里是否启用缓存。
 * @param regenerate - 调用方是否要求重新生成。
 * @returns 是否读缓存。
 */
function shouldReadCache(cacheEnabled, regenerate) {
    return cacheEnabled && !regenerate;
}
/**
 * 计算音频的版本令牌。
 *
 * 优先用 DS 侧 `audio_id`（每次合成唯一），拿不到时退到写入时间 —— 它只需要
 * "同一版稳定、新一版变化"，好让 `?v=` 承担 URL 缓存击穿。
 * @param audioId - DS ready 帧里的 audio_id（可能缺失）。
 * @param at - 缓存写入时间（epoch ms）。
 * @returns 非空版本串。
 */
function audioVersion(audioId, at) {
    if (audioId !== undefined && audioId !== '')
        return audioId;
    return `t${Math.round(at).toString(36)}`;
}
/**
 * 拼一条带版本令牌的音频 URL。
 *
 * 版本必须进 URL（而不是只靠响应头）：音频路由是 `immutable, max-age=31536000` 而路径
 * 按内容哈希固定，于是"重新生成覆盖同一文件"在浏览器侧完全不可见。
 * @param id - 内容寻址 id。
 * @param ext - 扩展名。
 * @param version - 版本令牌。
 * @returns 同源音频 URL。
 */
function audioUrlWithVersion(id, ext, version) {
    return `/api/ds-tts/audio/${id}.${ext}?v=${encodeURIComponent(version)}`;
}
/**
 * 按扩展名优先级查缓存。
 * @param dir - 缓存目录。
 * @param id - 内容寻址 id。
 * @param order - 期望的扩展名顺序（默认 wav → mp3 → opus）。
 * @returns 命中信息；未命中返回 undefined。
 */
async function readCache(dir, id, order = AUDIO_EXTS) {
    for (const ext of order) {
        const path = join(dir, `${id}.${ext}`);
        try {
            const info = await stat(path);
            if (!info.isFile())
                continue;
            let meta;
            try {
                meta = JSON.parse(await readFile(cacheMetaPath(dir, id), 'utf8'));
            }
            catch {
                meta = undefined;
            }
            return { path, ext, bytes: info.size, meta };
        }
        catch {
            // 该扩展名不存在，试下一个
        }
    }
    return undefined;
}
/**
 * 写缓存（音频 + 元数据 sidecar）。
 * @param dir - 缓存目录。
 * @param id - 内容寻址 id。
 * @param ext - 扩展名。
 * @param bytes - 音频字节。
 * @param meta - 元数据（不含 id/bytes/at，由本函数补齐）。
 * @returns 音频文件的绝对路径。
 */
async function writeCache(dir, id, ext, bytes, meta) {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.${ext}`);
    await writeFile(path, bytes);
    const full = { ...meta, id, ext, bytes: bytes.length, at: Date.now() };
    await writeFile(cacheMetaPath(dir, id), `${JSON.stringify(full, null, 2)}\n`, 'utf8');
    return path;
}
/**
 * 统计缓存规模。
 * @param dir - 缓存目录。
 * @returns 文件数与总字节数（只数音频，不含 sidecar）。
 */
async function cacheStats(dir) {
    let files = 0;
    let bytes = 0;
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return { files: 0, bytes: 0 };
    }
    for (const name of entries) {
        const ext = name.slice(name.lastIndexOf('.') + 1);
        if (!AUDIO_EXTS.includes(ext))
            continue;
        try {
            const info = await stat(join(dir, name));
            if (!info.isFile())
                continue;
            files += 1;
            bytes += info.size;
        }
        catch {
            // 并发删除，忽略
        }
    }
    return { files, bytes };
}
/**
 * 清理超过保留期的缓存条目（音频 + sidecar）。
 * @param dir - 缓存目录。
 * @param keepDays - 保留天数；<= 0 时不清理。
 * @returns 删除的条目数。
 */
async function pruneCache(dir, keepDays) {
    if (keepDays <= 0)
        return 0;
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return 0;
    }
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of entries) {
        const path = join(dir, name);
        try {
            const info = await stat(path);
            if (!info.isFile() || info.mtimeMs >= cutoff)
                continue;
            await unlink(path);
            removed += 1;
        }
        catch {
            // 忽略单个文件的清理失败
        }
    }
    return removed;
}

export { audioUrlWithVersion, audioVersion, cacheId, cacheMetaPath, cacheStats, pruneCache, readCache, shouldReadCache, writeCache };
