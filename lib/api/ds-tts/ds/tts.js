import WebSocket from 'ws';
import { mapDsCode, parseControlFrame, ackFrame, decodeFrame, parseVoices, assembleFrames, unwrapEnvelope } from './frames.js';

/**
 * DS 官方朗读通道（宿主侧，直连 chat.deepseek.com）。
 *
 * 已实测的事实（决定了这里为什么不需要浏览器、也不需要 PoW / cf_clearance）：
 * - 从 Node 直连 `GET /api/v0/chat/tts/voices` 与 `POST /api/v0/auth/ticket` 返回的是
 *   **干净的 JSON**（`{"code":40003,"msg":"INVALID_TOKEN"}`），响应头没有 `cf-mitigated`
 *   —— Cloudflare 并不阻拦非浏览器客户端，ticket 与 wss 都不需要 cookie / TLS 指纹。
 * - wss 握手被拒时不是 101，而是 **HTTP 200 + JSON**，所以必须用 `ws` 的
 *   `unexpected-response` 拿响应体，才能把 `code` 映射成用户能看懂的原因
 *   （Node 内置 WebSocket 只会给一个无信息的 1006）。
 *
 * 唯一需要浏览器的是"把文本投递进 DS 会话"（见 browser/page.ts）—— 那才是 PoW/CF 的战场，
 * 而我们用真实浏览器规避了它。
 */
/** DS 网页 origin。 */
const DS_ORIGIN = 'https://chat.deepseek.com';
/** DS 私有 API 前缀。 */
const API_BASE = `${DS_ORIGIN}/api/v0`;
/** 朗读合成 WebSocket 路径。 */
const TTS_WS_PATH = '/api/v0/chat/tts/';
/**
 * 造一个失败结果。
 * @param code - 结构化错误码。
 * @param error - 中文原因。
 * @param detail - 诊断细节。
 * @param bizCode - 服务端业务码。
 * @returns 失败结果。
 */
function dsFail(code, error, detail = '', bizCode) {
    return bizCode === undefined ? { ok: false, code, error, detail } : { ok: false, code, error, detail, bizCode };
}
/** 伪装成普通网页请求的头部（DS 侧不校验指纹，但带上更像正常客户端）。 */
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: DS_ORIGIN,
    Referer: `${DS_ORIGIN}/`,
};
/**
 * 调一个 DS JSON 接口并解开双层信封。
 * @param path - `/api/v0` 之后的路径。
 * @param options - token / 方法 / 请求体 / 取消 / 超时。
 * @returns 业务数据或结构化失败。
 */
async function dsJson(path, options) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 30000;
    const timer = setTimeout(() => {
        controller.abort();
    }, timeoutMs);
    const onAbort = () => {
        controller.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            method: options.method ?? 'GET',
            headers: {
                ...BROWSER_HEADERS,
                'Content-Type': 'application/json',
                Authorization: `Bearer ${options.token}`,
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
        });
        const text = await res.text();
        let raw;
        try {
            raw = JSON.parse(text);
        }
        catch {
            return dsFail('INTERNAL', `DS 返回了非 JSON 响应（HTTP ${res.status.toString()}）`, text.slice(0, 300));
        }
        if (!res.ok) {
            const env = raw;
            const info = mapDsCode(env.code, env.msg);
            return dsFail(info.code, info.text, `HTTP ${res.status.toString()} code=${env.code?.toString() ?? '-'} msg=${env.msg ?? ''}`);
        }
        const unwrapped = unwrapEnvelope(raw);
        if (!unwrapped.ok) {
            return dsFail(unwrapped.code, unwrapped.error, unwrapped.detail, unwrapped.bizCode ?? undefined);
        }
        return { ok: true, data: unwrapped.data };
    }
    catch (error) {
        if (options.signal?.aborted === true)
            return dsFail('CANCELLED', '已取消', '');
        const message = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted)
            return dsFail('INTERNAL', `调用 DS 接口超时（${timeoutMs.toString()}ms）`, path);
        return dsFail('INTERNAL', `调用 DS 接口失败：${message}`, path);
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}
/**
 * 取 DS 官方音色列表。
 * @param token - 用户 token。
 * @param options - 取消 / 超时。
 * @returns 音色列表与当前音色。
 */
async function fetchVoices(token, options = {}) {
    const res = await dsJson('/chat/tts/voices', { token, signal: options.signal, timeoutMs: options.timeoutMs ?? 20000 });
    if (!res.ok)
        return res;
    return { ok: true, data: parseVoices(res.data) };
}
/**
 * 切换账号级朗读音色（注意：这会改写 DS 账号里的设置）。
 * @param token - 用户 token。
 * @param voiceId - voice_id。
 * @param options - 取消 / 超时。
 * @returns 成功时的原始业务数据。
 */
async function setVoice(token, voiceId, options = {}) {
    return dsJson('/chat/tts/voice', {
        token,
        method: 'POST',
        body: { voice_id: voiceId },
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 20000,
    });
}
/**
 * 取一张 TTS 票据。
 * @param token - 用户 token。
 * @param options - 取消 / 超时。
 * @returns 票据。
 */
async function issueTicket(token, options = {}) {
    const res = await dsJson('/auth/ticket', {
        token,
        method: 'POST',
        body: { scope: 'tts' },
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 20000,
    });
    if (!res.ok)
        return res;
    const data = res.data;
    if (typeof data !== 'object' || data === null)
        return dsFail('TICKET_FAILED', 'DS 没有返回票据', JSON.stringify(data).slice(0, 200));
    const row = data;
    const ticket = typeof row.ticket === 'string' ? row.ticket : '';
    if (ticket === '')
        return dsFail('TICKET_FAILED', 'DS 返回的票据为空', JSON.stringify(row).slice(0, 200));
    const expires = typeof row.expires_in_secs === 'number' ? row.expires_in_secs : 600;
    return { ok: true, data: { ticket, expiresInSecs: expires } };
}
/**
 * 从一条 DS 会话消息合成音频（取票 → wss 收帧 → 拼接）。
 *
 * 票据一次性：本函数内部**每次调用都重新取票**，绝不复用。
 * @param input - 会话/消息/格式/取消/进度。
 * @returns 音频或结构化失败。
 */
async function synthFromMessage(input) {
    const timeoutMs = input.timeoutMs ?? 120000;
    input.onProgress?.({ phase: 'ticket' });
    const ticketRes = await issueTicket(input.token, { signal: input.signal, timeoutMs: Math.min(20000, timeoutMs) });
    if (!ticketRes.ok) {
        return dsFail('TICKET_FAILED', ticketRes.error, ticketRes.detail, ticketRes.bizCode);
    }
    const query = new URLSearchParams({
        chat_session_id: input.chatSessionId,
        message_id: input.messageId,
        ticket: ticketRes.data.ticket,
        mode: 'manual',
        format: input.format,
    });
    const wsUrl = `wss://chat.deepseek.com${TTS_WS_PATH}?${query.toString()}`;
    return await new Promise((resolve) => {
        const frames = new Map();
        let totalBytes = 0;
        let settled = false;
        let serverFormat = input.format;
        let voiceId = '';
        let audioId = '';
        let traceId = '';
        let lastError = '';
        let sawFinish = false;
        let finishCode;
        let finishMsg;
        const ws = new WebSocket(wsUrl, { headers: { ...BROWSER_HEADERS }, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', onAbort);
            try {
                ws.terminate();
            }
            catch {
                // ignore
            }
            resolve(result);
        };
        /** 收尾：finish 帧已到 + 有数据 → 成功；否则按错误码判定。 */
        const settleFromState = (context) => {
            if (settled)
                return;
            if (frames.size > 0 && (sawFinish || finishCode === undefined)) {
                if (finishCode !== undefined && finishCode !== 0) {
                    const info = mapDsCode(finishCode, finishMsg);
                    finish(dsFail(info.code, info.text, `${context} biz_code=${finishCode.toString()} biz_msg=${finishMsg ?? ''}`, finishCode));
                    return;
                }
                input.onProgress?.({ phase: 'finish', frames: frames.size, bytes: totalBytes });
                finish({
                    ok: true,
                    data: {
                        bytes: assembleFrames(frames),
                        serverFormat,
                        voiceId,
                        audioId,
                        traceId,
                        frames: frames.size,
                    },
                });
                return;
            }
            if (finishCode !== undefined && finishCode !== 0) {
                const info = mapDsCode(finishCode, finishMsg);
                finish(dsFail(info.code, info.text, `${context} biz_code=${finishCode.toString()} biz_msg=${finishMsg ?? ''}`, finishCode));
                return;
            }
            finish(dsFail('SYNTH_FAILED', lastError !== '' ? lastError : 'DS 朗读没有返回音频数据', `${context} frames=${frames.size.toString()} finish=${sawFinish ? 'yes' : 'no'}`));
        };
        const timer = setTimeout(() => {
            settleFromState('超时');
        }, timeoutMs);
        const onAbort = () => {
            finish(dsFail('CANCELLED', '已取消', '用户取消或会话结束'));
        };
        input.signal?.addEventListener('abort', onAbort, { once: true });
        ws.on('unexpected-response', (_req, res) => {
            const status = res.statusCode ?? 0;
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let code;
                let msg = '';
                try {
                    const parsed = JSON.parse(body);
                    code = parsed.code;
                    msg = parsed.msg ?? '';
                }
                catch {
                    // 非 JSON：直接用 HTTP 状态说明
                }
                const info = mapDsCode(code, msg);
                finish(dsFail(info.code, info.text, `WS 握手被拒：HTTP ${status.toString()} body=${body.slice(0, 200)}`, code));
            });
            res.on('error', () => {
                finish(dsFail('SYNTH_FAILED', 'WS 握手被拒且读取响应失败', `HTTP ${status.toString()}`));
            });
        });
        ws.on('open', () => {
            input.onProgress?.({ phase: 'connected' });
        });
        ws.on('message', (data, isBinary) => {
            if (settled)
                return;
            if (!isBinary) {
                const control = parseControlFrame(typeof data === 'string' ? data : data.toString('utf8'));
                if (control === undefined)
                    return;
                if (control.event === 'ready') {
                    serverFormat = typeof control.format === 'string' && control.format !== '' ? control.format : serverFormat;
                    voiceId = typeof control.voice_id === 'string' ? control.voice_id : voiceId;
                    audioId = typeof control.audio_id === 'string' ? control.audio_id : audioId;
                    traceId = typeof control.trace_id === 'string' ? control.trace_id : traceId;
                    input.onProgress?.({ phase: 'ready', frames: 0, bytes: 0 });
                    if (ws.readyState === WebSocket.OPEN)
                        ws.send(ackFrame(0));
                    return;
                }
                if (control.event === 'finish') {
                    sawFinish = true;
                    finishCode = typeof control.code === 'number' ? control.code : 0;
                    finishMsg = typeof control.msg === 'string' ? control.msg : '';
                    settleFromState('服务端 finish');
                    return;
                }
                return;
            }
            const buf = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(data);
            const frame = decodeFrame(buf);
            if (frame === undefined)
                return;
            if (!frames.has(frame.seq)) {
                frames.set(frame.seq, frame.payload);
                totalBytes += frame.payload.length;
            }
            if (ws.readyState === WebSocket.OPEN)
                ws.send(ackFrame(frame.seq));
            if (frames.size % 8 === 0)
                input.onProgress?.({ phase: 'frames', frames: frames.size, bytes: totalBytes });
        });
        ws.on('error', (error) => {
            lastError = `WS 错误：${error.message}`;
            // 不立刻失败：close 事件会带着最终状态进来
        });
        ws.on('close', (code, reason) => {
            if (settled)
                return;
            const detail = `WS 关闭 code=${code.toString()} reason=${reason.toString().slice(0, 120)}`;
            if (lastError === '')
                lastError = detail;
            settleFromState(detail);
        });
    });
}

export { DS_ORIGIN, dsFail, fetchVoices, issueTicket, setVoice, synthFromMessage };
