/**
 * Which sidebar workspace group a chat belongs to.
 * Clones share workspaceFile with the parent, so grouping must use the folder.
 */

/**
 * @param {string} [pathValue]
 * @returns {string}
 */
export function normalizeWorkspacePath(pathValue) {
  if (typeof pathValue !== 'string') return '';
  return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

/**
 * @param {object[]} workspaces
 * @param {string} workspaceFile
 * @param {(sidebarKey: string) => string} getPreferredWorkspaceFolder
 * @returns {string[]}
 */
export function listCloneFoldersForWorkspaceFile(
  workspaces,
  workspaceFile,
  getPreferredWorkspaceFolder,
) {
  const file = normalizeWorkspacePath(workspaceFile);
  if (!file) return [];
  const getFolder =
    typeof getPreferredWorkspaceFolder === 'function' ? getPreferredWorkspaceFolder : () => '';
  const rows = Array.isArray(workspaces) ? workspaces : [];
  const folders = [];
  const seen = new Set();
  rows.forEach((workspace) => {
    if (!workspace?.isClone) return;
    if (normalizeWorkspacePath(workspace.workspaceFile) !== file) return;
    const folder = normalizeWorkspacePath(
      getFolder(workspace.sidebarKey || workspace.workspaceFile || ''),
    );
    if (!folder || seen.has(folder)) return;
    seen.add(folder);
    folders.push(folder);
  });
  return folders;
}

/**
 * @param {object | null | undefined} chat
 * @param {{
 *   workspaceFile?: string,
 *   groupFolder?: string,
 *   isClone?: boolean,
 *   cloneFolders?: Iterable<string>,
 * }} params
 * @returns {boolean}
 */
export function chatBelongsToWorkspaceGroup(chat, params = {}) {
  const workspaceFile = normalizeWorkspacePath(params.workspaceFile);
  const chatFile = normalizeWorkspacePath(chat?.workspaceFile);
  if (!workspaceFile || !chatFile || chatFile !== workspaceFile) return false;
  const chatFolder = normalizeWorkspacePath(chat?.workspaceFolder);
  const groupFolder = normalizeWorkspacePath(params.groupFolder);
  const cloneFolders = new Set(
    [...(params.cloneFolders || [])].map((folder) => normalizeWorkspacePath(folder)).filter(Boolean),
  );
  if (params.isClone === true) {
    return Boolean(groupFolder && chatFolder === groupFolder);
  }
  if (chatFolder && cloneFolders.has(chatFolder)) return false;
  return true;
}
