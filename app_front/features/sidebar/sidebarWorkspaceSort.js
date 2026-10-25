/**
 * Stable workspace order for the sidebar (name, then key).
 * Optionally pins the active workspace to the top and applies a saved custom
 * (drag & drop) order below that pin.
 */

import { workspaceOrderIndex } from './sidebarWorkspaceOrder.js';

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
 * @param {{
 *   activeWorkspaceFile?: string,
 *   activeWorkspaceFolder?: string,
 *   getPreferredWorkspaceFolder?: (sidebarKey: string) => string,
 * }} options
 * @returns {boolean}
 */
export function isSidebarWorkspaceActive(workspace, options = {}) {
  if (!workspace) return false;
  const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
  const getPreferredWorkspaceFolder =
    typeof options.getPreferredWorkspaceFolder === 'function'
      ? options.getPreferredWorkspaceFolder
      : () => '';
  const folder = normalizePath(getPreferredWorkspaceFolder(sidebarKey));
  return (
    normalizePath(workspace.workspaceFile) === normalizePath(options.activeWorkspaceFile) &&
    folder === normalizePath(options.activeWorkspaceFolder)
  );
}

/**
 * @param {object[]} workspaces
 * @param {{
 *   pinActiveOnTop?: boolean,
 *   activeWorkspaceFile?: string,
 *   activeWorkspaceFolder?: string,
 *   getPreferredWorkspaceFolder?: (sidebarKey: string) => string,
 *   locale?: string,
 *   order?: string[],
 * }} [options]
 * @returns {object[]}
 */
export function sortSidebarWorkspaces(workspaces, options = {}) {
  if (!Array.isArray(workspaces) || !workspaces.length) return [];
  const locale = options.locale || 'en';
  const pinActiveOnTop = options.pinActiveOnTop === true;
  const order = Array.isArray(options.order) ? options.order : null;
  return workspaces.slice().sort((a, b) => {
    if (pinActiveOnTop) {
      const aActive = isSidebarWorkspaceActive(a, options) ? 0 : 1;
      const bActive = isSidebarWorkspaceActive(b, options) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
    }
    // Custom (drag & drop) order wins over the alphabetical fallback; workspaces
    // without a saved position share MAX_SAFE_INTEGER and stay alphabetical.
    if (order) {
      const aOrder = workspaceOrderIndex(a, order);
      const bOrder = workspaceOrderIndex(b, order);
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
    const byName = (a.name || '').localeCompare(b.name || '', locale);
    if (byName !== 0) return byName;
    const aKey = a.sidebarKey || a.workspaceFile || '';
    const bKey = b.sidebarKey || b.workspaceFile || '';
    return aKey.localeCompare(bKey, locale);
  });
}
