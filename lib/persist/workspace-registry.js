/**
 * Workspace registry stored in data/config.json.
 * A row is either a Cursor .code-workspace file or a folder-only virtual workspace.
 */

import { randomUUID } from 'node:crypto';

export const FOLDER_WORKSPACE_PREFIX = 'cretli:ws:';

/**
 * @param {string} pathValue
 * @returns {string}
 */
export function toPosixPath(pathValue) {
  if (!pathValue || typeof pathValue !== 'string') return '';
  return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isFolderWorkspaceId(id) {
  return typeof id === 'string' && id.startsWith(FOLDER_WORKSPACE_PREFIX) && id.length > FOLDER_WORKSPACE_PREFIX.length;
}

/**
 * @returns {string}
 */
export function createFolderWorkspaceId() {
  return `${FOLDER_WORKSPACE_PREFIX}${randomUUID()}`;
}

/**
 * @typedef {{ id: string, kind: 'file' | 'folders', workspaceFile?: string, label?: string }} WorkspaceRegistryEntry
 */

/**
 * @param {unknown} raw
 * @returns {WorkspaceRegistryEntry[]}
 */
export function sanitizeWorkspaces(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const kind = item.kind === 'folders' ? 'folders' : item.kind === 'file' ? 'file' : '';
    if (!kind) continue;
    /** @type {WorkspaceRegistryEntry} */
    let entry;
    if (kind === 'file') {
      const workspaceFile = toPosixPath(item.workspaceFile || item.id || '');
      if (!workspaceFile) continue;
      entry = { id: workspaceFile, kind: 'file', workspaceFile };
    } else {
      const id = String(item.id || '').trim();
      if (!isFolderWorkspaceId(id)) continue;
      entry = { id, kind: 'folders' };
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (typeof item.label === 'string' && item.label.trim()) {
      entry.label = item.label.trim();
    }
    out.push(entry);
  }
  return out;
}

/**
 * @param {unknown} filePaths
 * @returns {WorkspaceRegistryEntry[]}
 */
export function seedFileWorkspaces(filePaths) {
  if (!Array.isArray(filePaths)) return [];
  return sanitizeWorkspaces(
    filePaths.map((filePath) => ({
      kind: 'file',
      workspaceFile: toPosixPath(filePath),
    }))
  );
}

/**
 * @param {unknown} list
 * @param {string} workspaceFile
 * @returns {WorkspaceRegistryEntry[]}
 */
export function addFileWorkspace(list, workspaceFile) {
  const sanitized = sanitizeWorkspaces(list);
  const file = toPosixPath(workspaceFile);
  if (!file) return sanitized;
  if (sanitized.some((entry) => entry.id === file)) return sanitized;
  return [...sanitized, { id: file, kind: 'file', workspaceFile: file }];
}

/**
 * @param {unknown} list
 * @param {{ id?: string, label?: string }} [options]
 * @returns {WorkspaceRegistryEntry[]}
 */
export function addFolderWorkspace(list, options = {}) {
  const sanitized = sanitizeWorkspaces(list);
  const id = isFolderWorkspaceId(options.id) ? options.id : createFolderWorkspaceId();
  if (sanitized.some((entry) => entry.id === id)) return sanitized;
  /** @type {WorkspaceRegistryEntry} */
  const entry = { id, kind: 'folders' };
  if (typeof options.label === 'string' && options.label.trim()) {
    entry.label = options.label.trim();
  }
  return [...sanitized, entry];
}

/**
 * @param {unknown} list
 * @param {string} id
 * @returns {WorkspaceRegistryEntry[]}
 */
export function removeWorkspace(list, id) {
  const key = toPosixPath(id) || String(id || '').trim();
  if (!key) return sanitizeWorkspaces(list);
  return sanitizeWorkspaces(list).filter((entry) => entry.id !== key);
}

/**
 * @param {unknown} list
 * @param {string} id
 * @returns {WorkspaceRegistryEntry | null}
 */
export function findWorkspace(list, id) {
  const key = toPosixPath(id) || String(id || '').trim();
  if (!key) return null;
  return sanitizeWorkspaces(list).find((entry) => entry.id === key) || null;
}
