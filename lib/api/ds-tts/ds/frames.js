/**
 * 解一条二进制帧。
 * @param buf - 完整帧字节。
 * @returns 解出的 seq 与负载；长度不足 5 字节时返回 undefined。
 */
function decodeFrame(buf) {
    if (buf.length < 5)
        return undefined;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const seq = view.getUint32(0, false);
    return { seq, payload: buf.subarray(4) };
}
/**
 * 解析一条服务端文本帧。
 * @param text - 文本帧内容。
 * @returns 控制帧对象；非 JSON 时返回 undefined。
 */
function parseControlFrame(text) {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null)
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/**
 * 按 seq 升序拼接去重后的音频负载。
 * @param frames - seq → 负载。
 * @returns 连续音频字节。
 */
function assembleFrames(frames) {
    const seqs = [...frames.keys()].sort((a, b) => a - b);
    let total = 0;
    for (const seq of seqs)
        total += frames.get(seq)?.length ?? 0;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const seq of seqs) {
        const payload = frames.get(seq);
        if (payload === undefined)
            continue;
        out.set(payload, offset);
        offset += payload.length;
    }
    return out;
}
/** 需要（重新）取票的一帧 ack。 */
function ackFrame(seq) {
    return JSON.stringify({ event: 'ack', received_seq: seq, played_seq: seq });
}
/** 业务码 → 结构化错误 + 中文文案（0 = 成功，见协议备忘）。 */
const DS_CODE_MAP = {
    0: { code: 'INTERNAL', text: '成功' },
    1: { code: 'SYNTH_FAILED', text: 'DS 朗读服务内部错误' },
    2: { code: 'BAD_REQUEST', text: '请求参数不被 DS 朗读服务接受' },
    3: { code: 'SYNTH_FAILED', text: 'DS 朗读服务暂时不可用' },
    4: { code: 'DS_QUOTA', text: '今日朗读额度已用完' },
    5: { code: 'DS_RATE_LIMIT', text: '朗读请求过于频繁，请稍后重试' },
    6: { code: 'NO_CONTENT', text: '这条消息没有可朗读的正文' },
    7: { code: 'UNSUPPORTED_LANGUAGE', text: '当前语言暂不支持朗读，可尝试切换音色' },
    8: { code: 'VOICE_UNSUPPORTED_LANGUAGE', text: '该音色不支持当前语言，请切换音色' },
    9: { code: 'DS_NOT_AVAILABLE', text: '朗读功能对该账号暂不可用（服务端未放行）' },
    10: { code: 'SYNTH_FAILED', text: '朗读续传票据已过期，请重试' },
    11: { code: 'DS_FORBIDDEN', text: '服务端拒绝了该账号的朗读请求' },
    12: { code: 'CONTENT_FILTER', text: '内容未通过服务端过滤，无法朗读' },
};
/** 顶层 code → 结构化错误（登录态等）。 */
const TOP_LEVEL_CODE_MAP = {
    40003: { code: 'NOT_LOGGED_IN', text: 'DS 登录态无效或已过期，请在专用浏览器里重新登录 chat.deepseek.com' },
};
/**
 * 把一个 DS 业务/顶层码映射成结构化错误。
 * @param code - 业务码或顶层码。
 * @param msg - 服务端原始 msg（用于补充细节）。
 * @returns 映射结果。
 */
function mapDsCode(code, msg) {
    if (code === undefined)
        return { code: 'SYNTH_FAILED', text: msg !== undefined && msg !== '' ? msg : 'DS 朗读请求失败' };
    const mapped = DS_CODE_MAP[code] ?? TOP_LEVEL_CODE_MAP[code];
    if (mapped !== undefined) {
        // 码 0 只在不该出错的位置出现，按成功文案返回，由调用方判断
        return mapped;
    }
    return { code: 'SYNTH_FAILED', text: `DS 朗读失败（code=${code.toString()}${msg !== undefined && msg !== '' ? ` ${msg}` : ''}）` };
}
/** user 模式失败后值得改用 echo 模式重试的业务码（消息本身读不出来）。 */
const RETRY_AS_ECHO_CODES = [2, 6, 10];
/**
 * 解开 DS 的 `{code, data:{biz_code, biz_data}}` 双层信封。
 * @param raw - 反序列化后的响应体。
 * @returns 业务数据或结构化错误。
 */
function unwrapEnvelope(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return { ok: false, code: 'INTERNAL', error: 'DS 返回了无法解析的响应', detail: JSON.stringify(raw).slice(0, 300), bizCode: null };
    }
    const env = raw;
    const topCode = typeof env.code === 'number' ? env.code : undefined;
    if (topCode !== undefined && topCode !== 0) {
        const info = mapDsCode(topCode, env.msg);
        return {
            ok: false,
            code: info.code,
            error: info.text,
            detail: `code=${topCode.toString()} msg=${env.msg ?? ''}`,
            bizCode: null,
        };
    }
    const data = env.data ?? undefined;
    const bizCode = typeof data?.biz_code === 'number' ? data.biz_code : 0;
    if (bizCode !== 0) {
        const info = mapDsCode(bizCode, data?.biz_msg);
        return {
            ok: false,
            code: info.code,
            error: info.text,
            detail: `biz_code=${bizCode.toString()} biz_msg=${data?.biz_msg ?? ''}`,
            bizCode,
        };
    }
    return { ok: true, data: (data?.biz_data ?? data) };
}
/**
 * 取 i18n 字段里的中文（或首个可用）文本。
 * @param value - 服务端给的字符串或语言字典。
 * @returns 展示文本；无法解析时为空串。
 */
function pickI18n(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'object' && value !== null) {
        const dict = value;
        for (const key of ['zh', 'zh-CN', 'zh_CN', 'cn', 'en', 'en-US']) {
            const v = dict[key];
            if (typeof v === 'string' && v !== '')
                return v;
        }
        for (const v of Object.values(dict))
            if (typeof v === 'string' && v !== '')
                return v;
    }
    return '';
}
/**
 * 把 `GET /chat/tts/voices` 的 biz_data 解析成稳定结构。
 * @param bizData - 信封里的 biz_data。
 * @returns 音色列表与当前/默认音色；结构不符时返回空列表。
 */
function parseVoices(bizData) {
    const empty = { voices: [], currentVoiceId: null, defaultVoiceId: null };
    if (typeof bizData !== 'object' || bizData === null)
        return empty;
    const data = bizData;
    const rawList = Array.isArray(data.voices) ? data.voices : [];
    const voices = [];
    for (const item of rawList) {
        if (typeof item !== 'object' || item === null)
            continue;
        const row = item;
        const id = typeof row.voice_id === 'string' ? row.voice_id : '';
        if (id === '')
            continue;
        const languages = Array.isArray(row.languages) ? row.languages.filter((l) => typeof l === 'string') : [];
        let demoUrls = {};
        if (typeof row.demo_urls === 'object' && row.demo_urls !== null) {
            demoUrls = Object.fromEntries(Object.entries(row.demo_urls).filter((entry) => typeof entry[1] === 'string'));
        }
        voices.push({
            id,
            name: pickI18n(row.name_i18n) || id,
            gender: typeof row.gender === 'string' ? row.gender : '',
            description: pickI18n(row.description_i18n),
            languages,
            isDefault: row.is_default === true,
            demoUrls,
        });
    }
    return {
        voices,
        currentVoiceId: typeof data.current_voice_id === 'string' ? data.current_voice_id : null,
        defaultVoiceId: typeof data.default_voice_id === 'string' ? data.default_voice_id : null,
    };
}

export { DS_CODE_MAP, RETRY_AS_ECHO_CODES, ackFrame, assembleFrames, decodeFrame, mapDsCode, parseControlFrame, parseVoices, unwrapEnvelope };
