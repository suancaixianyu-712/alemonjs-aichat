/**
 * 投递模式决策（纯函数，可单测）。
 *
 * 实测：DS 官方 TTS 只接受助手消息；user 消息返回 code 6 / no_content，
 * 还会往会话永久塞一条废消息。首版固定 echo，不试 user/auto。
 */
import type { DsTtsMode, DsTtsResolvedMode } from "../protocol";

/**
 * 决定尝试顺序。v1 一律只回 echo（忽略 requested / userModeSupported）。
 */
export function resolveAttemptOrder(
  _requested: DsTtsMode,
  _userModeSupported: boolean | null,
): readonly DsTtsResolvedMode[] {
  return ["echo"];
}
