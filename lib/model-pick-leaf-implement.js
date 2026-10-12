/**
 * Implement-role model pick adjustments from todo leaf size (flash only on small leaves).
 */

import { isFlashDelegationModel } from './model-pick-gate-primitives.js';
import {
  classifyLeafSize,
  LEAF_SIZE_LARGE,
  listExistingFilePathsInLeafBody,
} from './model-pick-leaf-size.js';
import { getTodoById, updateTodo } from './persist/todos-persist.js';
import { resolveDataPath } from './runtime-paths.js';

export const TODO_BLOCKED_REASON_NO_NON_FLASH_CANDIDATE = 'no_non_flash_candidate';

/**
 * @param {Record<string, { items?: Array<{ id?: string }> }>} modelsByHarness
 * @returns {string[]}
 */
export function collectFlashFavoriteModelIds(modelsByHarness) {
  /** @type {Set<string>} */
  const ids = new Set();
  const map = modelsByHarness && typeof modelsByHarness === 'object' ? modelsByHarness : {};
  for (const row of Object.values(map)) {
    const items = Array.isArray(row?.items) ? row.items : [];
    for (const item of items) {
      const id = String(item?.id ?? '').trim();
      if (!id || !isFlashDelegationModel(id)) continue;
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * @param {string[]} base
 * @param {string[]} extra
 * @returns {string[]}
 */
export function mergeExcludeModelIds(base, extra) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const value of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    const id = String(value ?? '').trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * @param {unknown} leafBody
 * @param {{ modelsByHarness?: Record<string, { items?: Array<{ id?: string }> }>, env?: Record<string, string | undefined> }} [options]
 * @returns {{
 *   leafSize: 'small' | 'large',
 *   excludeFlashModels: string[],
 *   fileCount: number,
 * }}
 */
export function resolveLeafImplementPickAdjustments(leafBody, options = {}) {
  const leafSize = classifyLeafSize(leafBody, { env: options.env });
  const fileCount = listExistingFilePathsInLeafBody(leafBody).length;
  const excludeFlashModels = leafSize === LEAF_SIZE_LARGE
    ? collectFlashFavoriteModelIds(options.modelsByHarness || {})
    : [];
  return {
    leafSize,
    excludeFlashModels,
    fileCount,
  };
}

/**
 * Append leaf-size context to an automatic pick reason (read-only annotation).
 *
 * @param {unknown} reason
 * @param {{ leafSize?: string, flashExcluded?: number }} context
 * @returns {string}
 */
export function appendLeafSizeToPickReason(reason, context = {}) {
  const base = String(reason || '').trim();
  const leafSize = String(context.leafSize || '').trim();
  if (!leafSize) return base;
  const flashExcluded = Number(context.flashExcluded) || 0;
  const suffix = flashExcluded > 0
    ? `; leaf=${leafSize}; flash_excluded=${flashExcluded}`
    : `; leaf=${leafSize}`;
  if (!base) return suffix.slice(2);
  return `${base}${suffix}`;
}

/**
 * Record a leaf blocker when a large stage has no non-flash implement candidate.
 *
 * @param {{
 *   dataDir: string,
 *   workspaceFolder: string,
 *   todoId: string,
 *   expectedUpdatedAt?: string,
 * }} input
 * @returns {{ ok: boolean, reason?: string }}
 */
export function blockTodoForNoNonFlashCandidate(input) {
  const dataDir = String(input?.dataDir || '').trim() || resolveDataPath();
  const workspaceFolder = String(input?.workspaceFolder || '').trim();
  const todoId = String(input?.todoId || '').trim();
  if (!dataDir || !workspaceFolder || !todoId) {
    return { ok: false, reason: 'missing_context' };
  }
  const current = getTodoById(dataDir, workspaceFolder, todoId);
  if (!current) return { ok: false, reason: 'todo_missing' };
  const expectedUpdatedAt = String(input.expectedUpdatedAt || current.updatedAt || '').trim();
  const updated = updateTodo(dataDir, workspaceFolder, todoId, {
    expectedUpdatedAt,
    blockedReason: TODO_BLOCKED_REASON_NO_NON_FLASH_CANDIDATE,
    appendChangelog: {
      kind: 'note',
      text: 'Blocked: no eligible non-flash implement model after leaf-size policy.',
    },
  });
  if (!updated?.items) return { ok: false, reason: 'update_failed' };
  return { ok: true };
}
