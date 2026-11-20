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

/** Name a watcher by its selected folder, never by a shared workspace-file parent. */
export function workspaceDisplayNameForFolder(workspaces, folder, getPreferredFolder = () => '') {
  const wanted = normalizeWorkspacePath(folder);
  const rows = Array.isArray(workspaces) ? workspaces : [];
  const primary = rows.find((workspace) => {
    const key = workspace.sidebarKey || workspace.workspaceFile || '';
    return normalizeWorkspacePath(getPreferredFolder(key)) === wanted;
  });
  const fallback = rows.find((workspace) => {
    const key = workspace.sidebarKey || workspace.workspaceFile || '';
    // A configured folder owns the name. Its .code-workspace directory does
    // not identify another watcher, even if that watcher uses the same parent.
    if (normalizeWorkspacePath(getPreferredFolder(key))) return false;
    return normalizeWorkspacePath(workspace.workspaceFolder) === wanted
      || normalizeWorkspacePath(workspace.workspaceDir) === wanted;
  });
  return (primary || fallback)?.name
    || wanted.split('/').filter(Boolean).pop()
    || folder;
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
    // Scout/review chats) belong to the group with their exact folder. A clone
    // owns its folder just as it does for chats that also store workspaceFile.
    if (!chatFolder || !groupFolder || chatFolder !== groupFolder) return false;
    return params.isClone === true || !cloneFolders.has(chatFolder);
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
  // A configured primary/clone folder identifies the intended workspace more
  // precisely than membership: another workspace may include it read-only.
  if (prefer) {
    const primary = rows.find((workspace) => {
      const file = String(workspace?.workspaceFile || workspace?.id || '').trim();
      return file && normalizeWorkspacePath(prefer(workspace.sidebarKey || file)) === wanted;
    });
    if (primary) return String(primary.workspaceFile || primary.id).trim();
  }
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
  let folderRaw = typeof chat.workspaceFolder === 'string' ? chat.workspaceFolder.trim() : '';
  const fileRaw = typeof chat.workspaceFile === 'string' ? chat.workspaceFile.trim() : '';
  const file = fileRaw || findWorkspaceFileContainingFolder(workspaces, folderRaw, getPreferredFolder);
  if (!file) return null;
  if (fileRaw && typeof getPreferredFolder === 'function') {
    const preferred = String(getPreferredFolder(fileRaw) || '').trim();
    const normalizedFile = normalizeWorkspacePath(fileRaw);
    const fileDir = normalizedFile.slice(0, normalizedFile.lastIndexOf('/')) || '/';
    const cloneFolders = listCloneFoldersForWorkspaceFile(workspaces, fileRaw, getPreferredFolder);
    // Old chats often saved the directory containing the .code-workspace files
    // (e.g. projects). Opening one should select the configured project for
    // workspace controls. Keep real project/clone folders and folder-only
    // watcher chats exact; the chat's execution metadata is left intact.
    if (preferred && (!folderRaw || (normalizeWorkspacePath(folderRaw) === fileDir
      && !cloneFolders.includes(normalizeWorkspacePath(folderRaw))))) {
      folderRaw = preferred;
    }
  }
  const activeFile = normalizeWorkspacePath(active?.workspaceFile);
  const activeFolder = normalizeWorkspacePath(active?.workspaceFolder);
  const sameFile = normalizeWorkspacePath(file) === activeFile;
  const sameFolder = !folderRaw || normalizeWorkspacePath(folderRaw) === activeFolder;
  if (sameFile && sameFolder) return null;
  return { workspaceFile: file, workspaceFolder: folderRaw };
}
