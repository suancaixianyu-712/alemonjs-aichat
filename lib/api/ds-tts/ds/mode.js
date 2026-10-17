/**
 * 决定尝试顺序。v1 一律只回 echo（忽略 requested / userModeSupported）。
 */
function resolveAttemptOrder(_requested, _userModeSupported) {
    return ["echo"];
}

export { resolveAttemptOrder };
