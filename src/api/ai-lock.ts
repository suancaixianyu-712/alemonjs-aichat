export type AISelectionResolution =
  | { ok: true; names: string[] }
  | { ok: false; invalid: string[] };

const splitSelectionTokens = (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/[\s,，、]+/)
    .map((token) => token.trim())
    .filter(Boolean);
};

/**
 * 将 AI 列表序号、连续范围或完整配置名解析为稳定的配置名。
 * 任何一项无效时整体失败，避免批量命令只执行一部分。
 */
export const resolveAISelection = (
  input: string,
  aiList: string[],
): AISelectionResolution => {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, invalid: ["未提供序号"] };
  if (aiList.includes(trimmed)) return { ok: true, names: [trimmed] };

  const resolved: string[] = [];
  const invalid: string[] = [];
  for (const token of splitSelectionTokens(trimmed)) {
    const range = token.match(/^(\d+)[-~～](\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < 1 || start > end || end > aiList.length) {
        invalid.push(token);
        continue;
      }
      for (let index = start; index <= end; index += 1) {
        resolved.push(aiList[index - 1]);
      }
      continue;
    }

    if (/^\d+$/.test(token)) {
      const name = aiList[Number(token) - 1];
      if (name) resolved.push(name);
      else invalid.push(token);
      continue;
    }

    if (aiList.includes(token)) resolved.push(token);
    else invalid.push(token);
  }

  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, names: [...new Set(resolved)] };
};

export const formatAIListWithLocks = (
  aiList: string[],
  lockedAI: Iterable<string>,
  displayNames: string[] = aiList,
) => {
  const locked = new Set(lockedAI);
  return aiList.map(
    (name, index) =>
      `${index + 1}. ${locked.has(name) ? "🔒 " : ""}${displayNames[index] || name}`,
  );
};

export const getLockedAIMessage = (name: string) =>
  `AI ${name} 已被主人锁定，普通用户无法使用，请切换到其他 AI。`;
