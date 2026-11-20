import { t } from '../../i18n/index.js';

export const CLONE_KEY_SEPARATOR = '#clone-';

/**
 * @param {string} pathValue
 * @returns {string}
 */
export function normalizePath(pathValue) {
  if (!pathValue || typeof pathValue !== 'string') return '';
  return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

/**
 * @param {string} sidebarKey
 * @returns {boolean}
 */
export function isSidebarCloneKey(sidebarKey) {
  if (!sidebarKey || typeof sidebarKey !== 'string') return false;
  return sidebarKey.includes(CLONE_KEY_SEPARATOR);
}

/**
 * @param {string} sidebarKey
 * @returns {string}
 */
export function getWorkspaceFileFromSidebarKey(sidebarKey) {
  const key = normalizePath(sidebarKey);
  if (!key) return '';
  if (!isSidebarCloneKey(key)) return key;
  return normalizePath(key.split(CLONE_KEY_SEPARATOR)[0]);
}

/**
 * @param {string} workspaceFile
 * @returns {string}
 */
export function createCloneSidebarKey(workspaceFile) {
  const base = normalizePath(workspaceFile);
  if (!base) return '';
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${base}${CLONE_KEY_SEPARATOR}${id}`;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, {
 *   enabled: boolean,
 *   folder: string,
 *   workspaceFile: string,
 *   label: string,
 *   folders: Record<string, { enabled: boolean, name: string, source: string }>
 * }>}
 */
export function normalizeWorkspaceSidebarConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const next = {};
  Object.entries(raw).forEach(([sidebarKey, value]) => {
    const key = normalizePath(sidebarKey);
    if (!key) return;
    const entry = value && typeof value === 'object' ? value : {};
    const workspaceFile = typeof entry.workspaceFile === 'string' && entry.workspaceFile.trim()
      ? normalizePath(entry.workspaceFile)
      : getWorkspaceFileFromSidebarKey(key);
    const folders = {};
    if (entry.folders && typeof entry.folders === 'object') {
      Object.entries(entry.folders).forEach(([folderPath, folderValue]) => {
        const resolvedPath = normalizePath(folderPath);
        if (!resolvedPath) return;
        const folderEntry = folderValue && typeof folderValue === 'object' ? folderValue : {};
        folders[resolvedPath] = {
          enabled: folderEntry.enabled !== false,
          name: typeof folderEntry.name === 'string' ? folderEntry.name.trim() : '',
          source: folderEntry.source === 'cursor' ? 'cursor' : 'cretli',
        };
      });
    }
    next[key] = {
      enabled: entry.enabled === false ? false : true,
      folder: typeof entry.folder === 'string' ? entry.folder.trim() : '',
      workspaceFile,
      label: typeof entry.label === 'string' ? entry.label.trim() : '',
      folders,
    };
  });
  return next;
}

/**
 * @param {object} workspaceItem
 * @returns {string}
 */
export function resolveWorkspaceItemKey(workspaceItem) {
  return normalizePath(workspaceItem?.id || workspaceItem?.workspaceFile || '');
}

/**
 * @param {object} workspaceItem
 * @returns {string}
 */
export function getWorkspaceDirFromFile(workspaceOrFile) {
  if (!workspaceOrFile) return '';
  if (typeof workspaceOrFile === 'object' && workspaceOrFile.workspaceDir) {
    return workspaceOrFile.workspaceDir;
  }
  const workspaceFile = typeof workspaceOrFile === 'string'
    ? workspaceOrFile
    : (workspaceOrFile.workspaceFile || '');
  const normalized = normalizePath(workspaceFile);
  if (!normalized || normalized.startsWith('cretli:ws:')) return '';
  const slashIdx = normalized.lastIndexOf('/');
  if (slashIdx <= 0) return '';
  return normalized.slice(0, slashIdx);
}

/**
 * @param {object | null} workspaceItem
 * @param {string} preferredFolder
 * @returns {{ options: Array<{ value: string, label: string }>, value: string }}
 */
export function listFolderSelectOptions(workspaceItem, preferredFolder) {
  const options = [];
  if (!workspaceItem) return { options, value: '' };
  const parentDir = workspaceItem.kind === 'folders' ? '' : (workspaceItem.workspaceDir || '');
  if (parentDir) {
    options.push({ value: parentDir, label: t('workspace.parent') });
  }
  (workspaceItem.folders || []).forEach((folderItem) => {
    if (folderItem.enabled === false) return;
    if (!folderItem.resolvedPath) return;
    if (parentDir && normalizePath(folderItem.resolvedPath) === normalizePath(parentDir)) return;
    options.push({
      value: folderItem.resolvedPath,
      label: folderItem.name || folderItem.resolvedPath,
    });
  });
  const preferred = preferredFolder
    || parentDir
    || (workspaceItem.folders || []).find((folder) => folder.enabled !== false)?.resolvedPath
    || '';
  const matched = options.find((option) => normalizePath(option.value) === normalizePath(preferred));
  return { options, value: matched?.value || options[0]?.value || '' };
}

/**
 * @param {HTMLSelectElement | HTMLElement | null} folderSelect
 * @param {object | null} workspaceItem
 * @param {string} preferredFolder
 */
export function fillFolderSelect(folderSelect, workspaceItem, preferredFolder) {
  if (!folderSelect) return;
  const { options, value } = listFolderSelectOptions(workspaceItem, preferredFolder);
  if (folderSelect.tagName === 'CR-BAR-SELECT') {
    folderSelect.options = options;
    folderSelect.value = value;
    return;
  }
  folderSelect.innerHTML = '';
  options.forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    folderSelect.appendChild(option);
  });
  folderSelect.value = value;
}

/**
 * @param {object} overlayFolders
 * @param {object} workspaceItem
 * @returns {boolean}
 */
export function overlayDiffersFromFile(overlayFolders, workspaceItem) {
  if (workspaceItem?.kind !== 'file') return false;
  const fromFile = (workspaceItem.folders || [])
    .filter((folder) => folder.source !== 'cretli')
    .map((folder) => normalizePath(folder.resolvedPath))
    .filter(Boolean)
    .sort();
  const toWrite = Object.entries(overlayFolders || {})
    .filter(([, meta]) => meta?.enabled !== false)
    .map(([folderPath]) => normalizePath(folderPath))
    .filter(Boolean)
    .sort();
  return JSON.stringify(fromFile) !== JSON.stringify(toWrite);
}
