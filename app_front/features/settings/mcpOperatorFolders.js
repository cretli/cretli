/** Folder choices for Settings -> MCP -> MCP operator (pure, no DOM). */

import { collectWorkspaceFolders } from '../voice/voiceWorkspaceMatch.js';

/** @param {unknown} value */
export function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

/**
 * Overrides are stored per workspace folder, so only the folders of the
 * workspace this tab is looking at are offered (not every registered one).
 *
 * @param {Array<Record<string, any>>} workspaces
 * @param {string} workspaceFile
 * @param {string} current
 */
export function folderOptions(workspaces, workspaceFile, current) {
  const fileNorm = normalizePath(workspaceFile);
  const workspace = fileNorm ? workspaces.find((item) => normalizePath(item?.workspaceFile) === fileNorm) : null;
  // Only the workspace's own folders: `collectWorkspaceFolders` also adds the
  // directory holding the workspace file, which is not one of them.
  const rows = (workspace ? collectWorkspaceFolders({ folders: workspace.folders }) : [])
    .map((folder) => ({ value: folder.path, label: folder.name, description: folder.path }));
  const currentNorm = normalizePath(current);
  if (currentNorm && !rows.some((row) => row.value === currentNorm)) {
    rows.unshift({ value: currentNorm, label: currentNorm.split('/').pop() || currentNorm, description: currentNorm });
  }
  return rows;
}
