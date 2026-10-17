/**
 * Normalize raw results from @alemonjs/onebot Client API / useClient.
 *
 * Current SDK (`@alemonjs/onebot` ≥2.1.x) resolves `send()` with
 * `parsedMessage.data` directly (e.g. `{ user_id, nickname }` for get_login_info).
 * Older alemonjs wrappers returned `[{ code, data }]`. This helper accepts both.
 */

const FAIL_CODE = 4000;

export type OneBotLoginInfo = {
  user_id?: string | number;
  nickname?: string;
  [key: string]: unknown;
};

const isFailCode = (code: unknown): boolean =>
  code === FAIL_CODE || code === String(FAIL_CODE);

/** True when the object looks like a payload rather than a Result wrapper. */
const looksLikePayload = (obj: Record<string, unknown>): boolean =>
  "user_id" in obj ||
  "nickname" in obj ||
  "message_id" in obj ||
  "sender" in obj ||
  "message" in obj ||
  "user_name" in obj;

/**
 * Unwrap onebot API / useClient result to the payload object, or null on
 * missing / timeout / Fail(4000) / empty array.
 */
export function unwrapOneBotData<T = Record<string, unknown>>(
  raw: unknown,
): T | null {
  if (raw == null) return null;

  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first == null || typeof first !== "object") return null;
    const item = first as Record<string, unknown>;
    if (isFailCode(item.code)) return null;
    if ("data" in item && item.data != null && typeof item.data === "object") {
      return item.data as T;
    }
    if (looksLikePayload(item)) return first as T;
    return null;
  }

  if (typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  // Single Result-like wrapper { code, data }
  if ("code" in obj && "data" in obj) {
    if (isFailCode(obj.code)) return null;
    if (obj.data != null && typeof obj.data === "object") {
      return obj.data as T;
    }
    return null;
  }

  return raw as T;
}

export type NormalizeLoginInfoResult =
  | {
      ok: true;
      loginInfo: OneBotLoginInfo;
      /** Nickname missing/blank → caller should soft-fallback + botInfoFault. */
      emptyNickname: boolean;
    }
  | { ok: false; loginInfo: null; emptyNickname: true };

/**
 * Normalize getLoginInfo result.
 * - ok + !emptyNickname: use loginInfo as event.bot
 * - ok + emptyNickname: soft-fallback nickname, set botInfoFault
 * - !ok: missing/invalid/timeout → fallback + botInfoFault (no ClientError)
 */
export function normalizeLoginInfo(raw: unknown): NormalizeLoginInfoResult {
  const data = unwrapOneBotData<OneBotLoginInfo>(raw);
  if (!data || typeof data !== "object") {
    return { ok: false, loginInfo: null, emptyNickname: true };
  }
  const nickname = String(data.nickname ?? "").trim();
  return {
    ok: true,
    loginInfo: data,
    emptyNickname: nickname.length === 0,
  };
}
