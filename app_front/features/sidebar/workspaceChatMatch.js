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
  const chatFolder = normalizeWorkspacePath(chat?.workspaceFolder);
  const groupFolder = normalizeWorkspacePath(params.groupFolder);
  const cloneFolders = new Set(
    [...(params.cloneFolders || [])].map((folder) => normalizeWorkspacePath(folder)).filter(Boolean),
  );

  if (!workspaceFile) return false;

  if (!chatFile) {
    // Chats without workspaceFile (e.g. watcher orchestrator chats and their
    // delegation sub-chats) are matched by workspaceFolder instead. Clones are
    // excluded the same way as normal chats.
    if (!chatFolder || !groupFolder || chatFolder !== groupFolder) return false;
    if (params.isClone === true) return false;
    return !cloneFolders.has(chatFolder);
  }

  if (chatFile !== workspaceFile) return false;
  if (params.isClone === true) {
    return Boolean(groupFolder && chatFolder === groupFolder);
  }
  if (chatFolder && cloneFolders.has(chatFolder)) return false;
  return true;
}

/**
 * Folder paths stored on a workspace catalog row.
 *
 * @param {object | null | undefined} workspace
 * @returns {string[]}
 */
function workspaceFolderCandidates(workspace) {
  const folders = Array.isArray(workspace?.folders) ? workspace.folders : [];
  return [
    workspace?.workspaceDir,
    workspace?.workspaceFolder,
    ...folders.map((entry) => {
      if (typeof entry === 'string') return entry;
      return entry?.resolvedPath || entry?.path || entry?.folder || '';
    }),
  ];
}

/**
 * `.code-workspace` file whose catalog (or sidebar preferred folder) contains `folder`.
 *
 * @param {object[]} workspaces
 * @param {string} folder
 * @param {(sidebarKey: string) => string} [getPreferredFolder]
 * @returns {string}
 */
export function findWorkspaceFileContainingFolder(workspaces, folder, getPreferredFolder) {
  const wanted = normalizeWorkspacePath(folder);
  if (!wanted) return '';
  const prefer = typeof getPreferredFolder === 'function' ? getPreferredFolder : null;
  const rows = Array.isArray(workspaces) ? workspaces : [];
  for (const workspace of rows) {
    const file = String(workspace?.workspaceFile || workspace?.id || '').trim();
    if (!file) continue;
    const preferred = prefer ? prefer(workspace.sidebarKey || file) : '';
    const candidates = [preferred, ...workspaceFolderCandidates(workspace)];
    const hit = candidates.some((candidate) => normalizeWorkspacePath(candidate) === wanted);
    if (hit) return file;
  }
  return '';
}

/**
 * Header workspace to apply when `chat` becomes the active chat.
 * Null when the chat has no workspace, or the header already matches.
 *
 * @param {object | null | undefined} chat
 * @param {{ workspaceFile?: string, workspaceFolder?: string } | null | undefined} active
 * @param {object[]} [workspaces]
 * @param {(sidebarKey: string) => string} [getPreferredFolder]
 * @returns {{ workspaceFile: string, workspaceFolder: string } | null}
 */
export function resolveWorkspaceTargetForChat(chat, active, workspaces = [], getPreferredFolder) {
  if (!chat || typeof chat !== 'object') return null;
  const folderRaw = typeof chat.workspaceFolder === 'string' ? chat.workspaceFolder.trim() : '';
  const fileRaw = typeof chat.workspaceFile === 'string' ? chat.workspaceFile.trim() : '';
  const file = fileRaw || findWorkspaceFileContainingFolder(workspaces, folderRaw, getPreferredFolder);
  if (!file) return null;
  const activeFile = normalizeWorkspacePath(active?.workspaceFile);
  const activeFolder = normalizeWorkspacePath(active?.workspaceFolder);
  const sameFile = normalizeWorkspacePath(file) === activeFile;
  const sameFolder = !folderRaw || normalizeWorkspacePath(folderRaw) === activeFolder;
  if (sameFile && sameFolder) return null;
  return { workspaceFile: file, workspaceFolder: folderRaw };
}
