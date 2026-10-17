import { looseFingerprint } from './text.js';

/**
 * DS 会话历史消息的**宿主侧**解释层。
 *
 * 为什么要有这一层：`GET /api/v0/chat/history_messages` 的字段名并没有公开文档，
 * 而 ds-tts 的投递流程必须从里面取到 `message_id` 与角色。早期版本把字段解释写在
 * 页面内的注入脚本里（一段字符串），结果一旦字段名猜错就**无法单测**，只能靠实测撞。
 * 现在：页面只负责把原始行取回来，所有解释都在这里，纯函数、可测、可诊断。
 */
/** 角色别名 → 归一化角色。 */
const ROLE_ALIASES = {
    user: 'user',
    human: 'user',
    request: 'user',
    question: 'user',
    prompt: 'user',
    assistant: 'assistant',
    ai: 'assistant',
    bot: 'assistant',
    response: 'assistant',
    answer: 'assistant',
    reply: 'assistant',
    model: 'assistant',
};
/** 取消息 id 时按优先级尝试的键名。 */
const ID_KEYS = ['message_id', 'messageId', 'msg_id', 'msgId', 'id'];
/** 取角色时按优先级尝试的键名。 */
const ROLE_KEYS = ['role', 'role_type', 'roleType', 'sender', 'from', 'type'];
/** 取正文时按优先级尝试的键名（含"块列表"形态的顶层键）。 */
const CONTENT_KEYS = ['content', 'text', 'body', 'markdown', 'parts', 'fragments', 'children', 'blocks'];
/** 取消息状态时尝试的键名。 */
const STATUS_KEYS = ['status', 'message_status', 'state'];
/** 视为"已完成"的状态取值。 */
const FINISHED_STATUSES = new Set(['finished', 'complete', 'completed', 'done', 'success']);
/**
 * 消息是否已生成完成。
 *
 * 为什么要判：对**还在流式生成**的消息取音频，服务端可能只拿到半截正文
 * （甚至没有正文）。所以投递后优先等 `FINISHED`。取不到状态字段时视为可用，
 * 避免因为字段名变化而永久等待。
 * @param status - 服务端状态串。
 * @returns 是否可用。
 */
function isFinishedStatus(status) {
    if (status === '')
        return true;
    return FINISHED_STATUSES.has(status.trim().toLowerCase());
}
/**
 * 从任意形态里抽出一段可读文本。
 * @param value - 服务端给的候选值。
 * @returns 文本（抽不到就是空串）。
 */
function extractText(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        const parts = [];
        for (const item of value) {
            const text = extractText(item);
            if (text !== '')
                parts.push(text);
        }
        return parts.join('\n');
    }
    if (typeof value === 'object' && value !== null) {
        const row = value;
        // 只认"看起来是文本容器"的字段，避免把嵌套对象 stringify 成噪音
        for (const key of ['text', 'content', 'value', 'body']) {
            const nested = row[key];
            if (typeof nested === 'string' && nested !== '')
                return nested;
        }
        // 有些实现把块列表放在 parts / fragments / children 里
        for (const key of ['parts', 'fragments', 'children', 'blocks']) {
            const nested = row[key];
            if (Array.isArray(nested)) {
                const text = extractText(nested);
                if (text !== '')
                    return text;
            }
        }
    }
    return '';
}
/**
 * 把一条原始历史行归一化成稳定结构。
 * @param raw - 服务端返回的单条消息。
 * @returns 归一化结果；连 id 都取不到时返回 undefined。
 */
function normalizeHistoryRow(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const row = raw;
    let id = '';
    for (const key of ID_KEYS) {
        const value = row[key];
        if (typeof value === 'string' && value !== '') {
            id = value;
            break;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            id = String(value);
            break;
        }
    }
    if (id === '')
        return undefined;
    let rawRole = '';
    for (const key of ROLE_KEYS) {
        const value = row[key];
        if (typeof value === 'string' && value !== '') {
            rawRole = value;
            break;
        }
    }
    let content = '';
    for (const key of CONTENT_KEYS) {
        const text = extractText(row[key]);
        if (text !== '') {
            content = text;
            break;
        }
    }
    const role = ROLE_ALIASES[rawRole.trim().toLowerCase()] ?? 'other';
    let status = '';
    for (const key of STATUS_KEYS) {
        const value = row[key];
        if (typeof value === 'string' && value !== '') {
            status = value;
            break;
        }
    }
    return { id, role, rawRole, content, status };
}
/**
 * 批量归一化。
 * @param rows - 服务端返回的消息数组。
 * @returns 归一化后的消息（跳过无法解析的行）。
 */
function normalizeHistoryRows(rows) {
    if (!Array.isArray(rows))
        return [];
    const out = [];
    for (const raw of rows) {
        const message = normalizeHistoryRow(raw);
        if (message !== undefined)
            out.push(message);
    }
    return out;
}
/**
 * 从原始行里抽出"结构指纹"，用于诊断（例如字段名与预期不符时直接告诉用户）。
 * @param rows - 服务端返回的消息数组。
 * @returns 取样信息（含实际见到的角色与状态取值）。
 */
function describeHistoryRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0)
        return { count: 0, keys: [], roles: [], statuses: [] };
    const first = rows.find((row) => typeof row === 'object' && row !== null);
    const roles = new Set();
    const statuses = new Set();
    for (const raw of rows) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const row = raw;
        for (const key of ROLE_KEYS) {
            const value = row[key];
            if (typeof value === 'string' && value !== '') {
                roles.add(value);
                break;
            }
        }
        for (const key of STATUS_KEYS) {
            const value = row[key];
            if (typeof value === 'string' && value !== '') {
                statuses.add(value);
                break;
            }
        }
    }
    return {
        count: rows.length,
        keys: first === undefined ? [] : Object.keys(first),
        roles: [...roles],
        statuses: [...statuses],
    };
}
/**
 * 从历史里挑出"投递后新出现的那条消息"。
 *
 * **正文是可选的**：合成只需要 `message_id`（服务端自己按 id 取正文），`content`
 * 只用于文本核对。历史接口在某些状态下不给正文，那种情况仍然应该能朗读 ——
 * 所以策略是"有正文优先，没有正文也算候选"。
 *
 * 匹配策略（从紧到松）：
 *   1) 角色匹配 + 不在基线里 +（可选）已完成；
 *   2) 其中有正文者优先；有 matchText 时优先文本指纹命中；
 *   3) 全都没有正文 → 取最新候选（放弃文本校验，由调用方决定要不要提示）。
 * @param messages - 归一化后的消息（调用方保证顺序与服务端一致）。
 * @param options - 基线 / 角色 / 匹配文本 / 是否要求已完成。
 * @returns 命中的消息，没有则 undefined。
 */
function pickNewMessage(messages, options) {
    const candidates = messages.filter((message) => {
        if (options.baselineIds.has(message.id))
            return false;
        if (options.role !== 'any' && message.role !== options.role)
            return false;
        if (options.finishedOnly === true && !isFinishedStatus(message.status))
            return false;
        return true;
    });
    if (candidates.length === 0)
        return undefined;
    const withContent = candidates.filter((message) => message.content.trim() !== '');
    if (withContent.length === 0) {
        // 历史没给正文：仍然可以朗读（服务端按 id 取正文），只是无法做文本校验
        return candidates[candidates.length - 1];
    }
    const expected = options.matchText === undefined ? '' : looseFingerprint(options.matchText);
    if (expected !== '') {
        const head = expected.slice(0, Math.min(80, expected.length));
        const exact = withContent.filter((message) => looseFingerprint(message.content).includes(head));
        if (exact.length > 0)
            return exact[exact.length - 1];
    }
    return withContent[withContent.length - 1];
}

export { describeHistoryRows, isFinishedStatus, normalizeHistoryRow, normalizeHistoryRows, pickNewMessage };
