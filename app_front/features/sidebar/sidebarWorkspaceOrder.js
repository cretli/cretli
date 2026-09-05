/**
 * Persistent custom order for sidebar workspace groups (drag & drop).
 * The order is a JSON array of `sidebarKey`s in localStorage; keys that are
 * not part of the current workspace list are ignored, new workspaces are
 * appended after the ordered ones.
 */

import {
  readStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';

const SIDEBAR_WORKSPACE_ORDER_KEY = 'cretli-sidebar-workspace-order';

/**
 * @param {string | null | undefined} value
 * @returns {string}
 */
function normalizePath(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

/**
 * @param {object | null | undefined} workspace
 * @returns {string}
 */
export function workspaceSidebarKey(workspace) {
  if (!workspace) return '';
  return normalizePath(workspace.sidebarKey || workspace.workspaceFile || '');
}

/**
 * Reads the saved workspace order. Returns [] when nothing (valid) is saved
 * or when localStorage is unavailable (Node tests, privacy modes).
 *
 * @returns {string[]}
 */
export function readWorkspaceOrder() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = readStorageValueWithAlias(localStorage, SIDEBAR_WORKSPACE_ORDER_KEY, '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((key) => normalizePath(key)).filter((key) => key);
  } catch (_) {
    return [];
  }
}

/**
 * Persists the workspace order (normalized, deduped).
 *
 * @param {string[]} keys
 * @returns {void}
 */
export function writeWorkspaceOrder(keys) {
  if (typeof localStorage === 'undefined' || !Array.isArray(keys)) return;
  const seen = new Set();
  const normalized = [];
  keys.forEach((key) => {
    const path = normalizePath(key);
    if (!path || seen.has(path)) return;
    seen.add(path);
    normalized.push(path);
  });
  try {
    writeStorageValueWithAlias(
      localStorage,
      SIDEBAR_WORKSPACE_ORDER_KEY,
      JSON.stringify(normalized)
    );
  } catch (_) {}
}

/**
 * Position of the workspace in the saved order, or MAX_SAFE_INTEGER when the
 * workspace has no custom position yet (sorts after the ordered ones).
 *
 * @param {object | null | undefined} workspace
 * @param {string[] | null | undefined} order
 * @returns {number}
 */
export function workspaceOrderIndex(workspace, order) {
  if (!Array.isArray(order) || !order.length) return Number.MAX_SAFE_INTEGER;
  const key = workspaceSidebarKey(workspace);
  if (!key) return Number.MAX_SAFE_INTEGER;
  const index = order.indexOf(key);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

/**
 * `sidebarKey`s of workspace groups that are direct children of the list.
 *
 * @param {ParentNode | null | undefined} list
 * @returns {string[]}
 */
export function collectWorkspaceKeysFromList(list) {
  if (!list || typeof list.querySelectorAll !== 'function') return [];
  return Array.from(list.querySelectorAll(':scope > .sidebar-workspace'))
    .map((li) => (li.dataset && li.dataset.sidebarKey) || '')
    .filter((key) => key);
}

/**
 * Insertion index for a pointer position: how many item centers are above
 * the pointer. Works on the list WITHOUT the dragged item.
 *
 * @param {number[]} centers - ascending center Y of the remaining items
 * @param {number} y - pointer Y position
 * @returns {number} 0..centers.length
 */
export function computeDropIndex(centers, y) {
  if (!Array.isArray(centers) || !centers.length) return 0;
  const value = typeof y === 'number' && Number.isFinite(y) ? y : 0;
  let index = 0;
  centers.forEach((center) => {
    if (value > center) index += 1;
  });
  return Math.min(Math.max(index, 0), centers.length);
}
