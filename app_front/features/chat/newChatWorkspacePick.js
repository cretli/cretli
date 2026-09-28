/**
 * Pick the workspace id for the new-chat modal without falling back to the
 * first registry row when the intended folder workspace is not in a stale list.
 */

/**
 * @param {string} [pathValue]
 * @returns {string}
 */
export function normalizeWorkspaceKey(pathValue) {
  if (!pathValue || typeof pathValue !== 'string') return '';
  return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

/**
 * @param {object} [item]
 * @returns {string}
 */
export function workspaceListEntryKey(item) {
  if (!item || typeof item !== 'object') return '';
  return normalizeWorkspaceKey(item.workspaceFile || item.id || '');
}

/**
 * @param {object[]} workspaces
 * @param {string} [workspaceFile]
 * @returns {boolean}
 */
export function isWorkspaceInList(workspaces, workspaceFile) {
  const wanted = normalizeWorkspaceKey(workspaceFile);
  if (!wanted) return false;
  const rows = Array.isArray(workspaces) ? workspaces : [];
  return rows.some((item) => workspaceListEntryKey(item) === wanted);
}

/**
 * @param {{
 *   workspaces?: object[],
 *   selectedWorkspaceFile?: string | null,
 *   headerWorkspaceFile?: string | null,
 * }} params
 * @returns {string}
 */
export function pickNewChatWorkspaceFile(params = {}) {
  const workspaces = Array.isArray(params.workspaces) ? params.workspaces : [];
  const selected = normalizeWorkspaceKey(params.selectedWorkspaceFile);
  const header = normalizeWorkspaceKey(params.headerWorkspaceFile);
  if (selected && isWorkspaceInList(workspaces, selected)) return selected;
  if (header && isWorkspaceInList(workspaces, header)) return header;
  if (selected) return selected;
  if (header) return header;
  return workspaceListEntryKey(workspaces[0]);
}
