/**
 * Pure helpers for sidebar drag: captured subtrees and drop parent ids.
 * DOM classes like is-child are not a parent pointer.
 */

export const MAX_SIDEBAR_NEST_INDENT = 8;

/**
 * @param {unknown} datasetNestLevel
 * @param {boolean} [isChild]
 * @returns {number}
 */
export function readNestLevel(datasetNestLevel, isChild = false) {
  const fromData = Number(datasetNestLevel);
  if (Number.isFinite(fromData) && fromData >= 0) return fromData;
  return isChild ? 1 : 0;
}

/**
 * Descendants of `startIndex` are the following rows with a strictly greater level.
 *
 * @param {{ id?: string, level?: number }[]} items
 * @param {number} startIndex
 * @returns {number[]}
 */
export function collectNestedBlockIndexes(items, startIndex) {
  if (!Array.isArray(items) || startIndex < 0 || startIndex >= items.length) return [];
  const startLevel = readNestLevel(items[startIndex]?.level);
  const indexes = [startIndex];
  for (let i = startIndex + 1; i < items.length; i += 1) {
    if (readNestLevel(items[i]?.level) <= startLevel) break;
    indexes.push(i);
  }
  return indexes;
}

/**
 * @param {{ nestParentId?: string, parentChatId?: string } | null | undefined} drop
 * @returns {string}
 */
export function readDropParentChatId(drop) {
  const nested = String(drop?.nestParentId || '').trim();
  if (nested) return nested;
  return String(drop?.parentChatId || '').trim();
}

/**
 * @param {{
 *   parentChatId?: string,
 *   parentLevel?: number,
 *   relativeLevels?: number[],
 * }} input
 * @returns {{ parentId: string, rootLevel: number, levels: number[], indentLevels: number[] }}
 */
export function resolveBlockNest(input = {}) {
  const parentId = String(input.parentChatId || '').trim();
  const parentLevel = Number(input.parentLevel);
  const rootLevel = parentId
    ? (Number.isFinite(parentLevel) && parentLevel >= 0 ? parentLevel + 1 : 1)
    : 0;
  const relative = Array.isArray(input.relativeLevels) && input.relativeLevels.length
    ? input.relativeLevels
    : [0];
  const levels = relative.map((rel) => rootLevel + Math.max(0, Number(rel) || 0));
  return {
    parentId,
    rootLevel,
    levels,
    indentLevels: levels.map((level) => Math.min(MAX_SIDEBAR_NEST_INDENT, level)),
  };
}
