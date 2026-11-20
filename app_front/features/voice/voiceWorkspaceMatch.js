/**
 * Resolves a spoken workspace name against the loaded workspace list.
 */

/**
 * @param {object} workspace
 * @returns {string}
 */
export function workspaceSpokenLabel(workspace) {
  const name = String(workspace?.name || '').trim();
  if (name) return name;
  const file = String(workspace?.workspaceFile || '').replace(/\\/g, '/');
  const base = file.split('/').pop() || '';
  return base.replace(/\.code-workspace$/i, '') || 'workspace';
}

/**
 * @param {object} workspace
 * @returns {string[]}
 */
function workspaceMatchLabels(workspace) {
  const file = String(workspace?.workspaceFile || '').replace(/\\/g, '/');
  const base = file.split('/').pop() || '';
  const stem = base.replace(/\.code-workspace$/i, '');
  const dir = String(workspace?.workspaceDir || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() || '';
  return [workspace?.name, stem, dir, base]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

/**
 * @param {string} label
 * @param {string} needle
 * @returns {boolean}
 */
function isSpokenMatch(label, needle) {
  const value = label.toLowerCase();
  if (value === needle) return true;
  if (needle.length >= 2 && value.includes(needle)) return true;
  if (value.length >= 4 && needle.includes(value)) return true;
  return false;
}

/**
 * @param {Array<object>} workspaces
 * @param {string} spoken
 * @returns {{ match?: object|null, ambiguous?: boolean, candidates?: string[] }}
 */
export function matchWorkspaceBySpokenName(workspaces, spoken) {
  const needle = String(spoken || '').trim().toLowerCase();
  if (!needle) return { match: null };
  const items = Array.isArray(workspaces)
    ? workspaces.filter((entry) => entry && String(entry.workspaceFile || '').trim())
    : [];
  const hits = items.filter((entry) =>
    workspaceMatchLabels(entry).some((label) => isSpokenMatch(label, needle))
  );
  if (hits.length === 1) return { match: hits[0] };
  if (hits.length > 1) {
    return {
      ambiguous: true,
      candidates: hits.map((entry) => workspaceSpokenLabel(entry)),
    };
  }
  return { match: null };
}

/**
 * @param {object} folder
 * @returns {string}
 */
export function folderSpokenLabel(folder) {
  const name = String(folder?.name || '').trim();
  if (name) return name;
  const pathValue = String(folder?.path || folder?.resolvedPath || '').replace(/\\/g, '/');
  return pathValue.split('/').filter(Boolean).pop() || pathValue || 'folder';
}

/**
 * Unique folders a workspace can switch to (parent dir + enabled folders).
 *
 * @param {object} workspace
 * @returns {Array<{ name: string, path: string }>}
 */
export function collectWorkspaceFolders(workspace) {
  const seen = new Set();
  const folders = [];
  function addFolder(name, resolvedPath) {
    const pathValue = String(resolvedPath || '').replace(/\\/g, '/').replace(/\/$/, '').trim();
    if (!pathValue) return;
    const key = pathValue.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    folders.push({
      name: String(name || '').trim() || pathValue.split('/').filter(Boolean).pop() || pathValue,
      path: pathValue,
    });
  }
  addFolder('', workspace?.workspaceDir);
  const items = Array.isArray(workspace?.folders) ? workspace.folders : [];
  items.forEach((folder) => {
    if (folder && folder.enabled === false) return;
    addFolder(folder?.name, folder?.resolvedPath);
  });
  return folders;
}

/**
 * @param {Array<{ name?: string, path?: string, resolvedPath?: string }>} folders
 * @param {string} spoken
 * @returns {{ match?: object|null, ambiguous?: boolean, candidates?: string[] }}
 */
export function matchFolderBySpokenName(folders, spoken) {
  const needle = String(spoken || '').trim().toLowerCase();
  if (!needle) return { match: null };
  const items = Array.isArray(folders)
    ? folders.filter((entry) => entry && String(entry.path || entry.resolvedPath || '').trim())
    : [];
  const hits = items.filter((entry) => {
    const pathValue = String(entry.path || entry.resolvedPath || '').replace(/\\/g, '/');
    const base = pathValue.split('/').filter(Boolean).pop() || '';
    return [entry.name, base, pathValue].some((label) => isSpokenMatch(String(label || ''), needle));
  });
  if (hits.length === 1) return { match: hits[0] };
  if (hits.length > 1) {
    return {
      ambiguous: true,
      candidates: hits.map((entry) => folderSpokenLabel(entry)),
    };
  }
  return { match: null };
}
