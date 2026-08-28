/**
 * Merge, sync and optional write-back of workspace folders.
 */

import fs from 'fs';
import path from 'path';
import { modify, applyEdits } from 'jsonc-parser';
import { findWorkspace, isFolderWorkspaceId, toPosixPath } from './persist/workspace-registry.js';

/**
 * @param {string} pathValue
 * @returns {string}
 */
function normalizeFolderPath(pathValue) {
  return toPosixPath(pathValue);
}

/**
 * @param {unknown} overlay
 * @returns {Record<string, { enabled?: boolean, name?: string, source?: 'cursor' | 'cretli' }>}
 */
function asOverlay(overlay) {
  if (!overlay || typeof overlay !== 'object') return {};
  return overlay;
}

/**
 * Pull folders from a .code-workspace file into the Cretli overlay.
 * New file folders are enabled. Disabled state is kept. Cretli-only extras stay.
 *
 * @param {Array<{ name?: string, path?: string, resolvedPath?: string }>} fileFolders
 * @param {unknown} overlayFolders
 * @returns {Record<string, { enabled?: boolean, name?: string, source?: 'cursor' | 'cretli' }>}
 */
export function syncFoldersFromFile(fileFolders, overlayFolders) {
  const overlay = asOverlay(overlayFolders);
  const next = {};
  const fileByPath = new Map();
  for (const folder of Array.isArray(fileFolders) ? fileFolders : []) {
    const key = normalizeFolderPath(folder?.resolvedPath || '');
    if (!key) continue;
    fileByPath.set(key, folder);
    const prev = overlay[key] || {};
    next[key] = {
      enabled: prev.enabled === false ? false : true,
      name: (typeof prev.name === 'string' && prev.name.trim()) || folder.name || path.posix.basename(key),
      source: 'cursor',
    };
  }
  for (const [key, prev] of Object.entries(overlay)) {
    const normalized = normalizeFolderPath(key);
    if (!normalized || fileByPath.has(normalized)) continue;
    if (prev?.source === 'cursor') continue;
    next[normalized] = {
      enabled: prev.enabled === false ? false : true,
      name: (typeof prev.name === 'string' && prev.name.trim()) || path.posix.basename(normalized),
      source: 'cretli',
    };
  }
  return next;
}

/**
 * @typedef {{
 *   name: string,
 *   path: string,
 *   resolvedPath: string,
 *   exists: boolean,
 *   source: 'cursor' | 'cretli',
 *   enabled: boolean
 * }} ClientFolder
 */

/**
 * @param {{
 *   fileFolders?: Array<{ name?: string, path?: string, resolvedPath?: string }>,
 *   overlayFolders?: unknown,
 *   existsSet?: Set<string>
 * }} params
 * @returns {ClientFolder[]}
 */
export function mergeFoldersForClient(params) {
  const fileFolders = Array.isArray(params?.fileFolders) ? params.fileFolders : [];
  const overlay = asOverlay(params?.overlayFolders);
  const existsSet = params?.existsSet instanceof Set ? params.existsSet : null;
  const fileByPath = new Map();
  for (const folder of fileFolders) {
    const key = normalizeFolderPath(folder?.resolvedPath || '');
    if (!key) continue;
    fileByPath.set(key, folder);
  }
  const keys = new Set([...fileByPath.keys(), ...Object.keys(overlay).map((key) => normalizeFolderPath(key)).filter(Boolean)]);
  const list = [];
  for (const resolvedPath of keys) {
    const fileFolder = fileByPath.get(resolvedPath);
    const overlayFolder = overlay[resolvedPath] || {};
    const source = overlayFolder.source === 'cretli' || !fileFolder ? 'cretli' : 'cursor';
    const exists = existsSet
      ? existsSet.has(resolvedPath)
      : fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory();
    list.push({
      name: overlayFolder.name || fileFolder?.name || path.posix.basename(resolvedPath),
      path: fileFolder?.path || resolvedPath,
      resolvedPath,
      exists,
      source,
      enabled: overlayFolder.enabled !== false,
    });
  }
  return list;
}

/**
 * @param {unknown} overlayFolders
 * @param {string} workspaceDir
 * @returns {Array<{ name: string, path: string }>}
 */
export function foldersForWriteback(overlayFolders, workspaceDir) {
  const overlay = asOverlay(overlayFolders);
  const base = normalizeFolderPath(workspaceDir);
  const folders = [];
  for (const [resolvedPath, meta] of Object.entries(overlay)) {
    if (meta?.enabled === false) continue;
    const abs = normalizeFolderPath(resolvedPath);
    if (!abs) continue;
    const relative = base ? path.posix.relative(base, abs) || '.' : abs;
    folders.push({
      name: (typeof meta?.name === 'string' && meta.name.trim()) || path.posix.basename(abs),
      path: relative,
    });
  }
  return folders;
}

/**
 * Rewrite only the folders array of a JSONC .code-workspace file.
 *
 * @param {string} absoluteFilePath
 * @param {Array<{ name?: string, path: string }>} folders
 */
export function writeWorkspaceFoldersJsonc(absoluteFilePath, folders) {
  if (!absoluteFilePath || !fs.existsSync(absoluteFilePath)) {
    throw new Error('Workspace file not found');
  }
  const raw = fs.readFileSync(absoluteFilePath, 'utf8');
  const payload = (Array.isArray(folders) ? folders : []).map((folder) => {
    const next = { path: String(folder?.path || '.').trim() || '.' };
    if (typeof folder?.name === 'string' && folder.name.trim()) next.name = folder.name.trim();
    return next;
  });
  const edits = modify(raw, ['folders'], payload, {
    formattingOptions: { insertSpaces: false, tabSize: 2, eol: '\n' },
  });
  if (!edits || edits.length === 0) {
    throw new Error('Could not update workspace folders');
  }
  fs.writeFileSync(absoluteFilePath, applyEdits(raw, edits), 'utf8');
}

/**
 * @param {{
 *   workspaceId?: string,
 *   workspaceFolder?: string,
 *   registry?: unknown,
 *   sidebarConfig?: Record<string, { folder?: string, folders?: Record<string, { enabled?: boolean }> }>,
 *   existsSet?: Set<string>,
 *   fallbackCwd?: string
 * }} params
 * @returns {string}
 */
export function resolveWorkspaceCwd(params) {
  const existsSet = params?.existsSet instanceof Set ? params.existsSet : null;
  const exists = (dir) => {
    const key = normalizeFolderPath(dir);
    if (!key) return false;
    if (existsSet) return existsSet.has(key);
    return fs.existsSync(key) && fs.statSync(key).isDirectory();
  };
  const preferred = normalizeFolderPath(params?.workspaceFolder || '');
  if (preferred && exists(preferred)) return preferred;
  const workspaceId = String(params?.workspaceId || '').trim();
  const sidebar = params?.sidebarConfig && typeof params.sidebarConfig === 'object'
    ? params.sidebarConfig[workspaceId] || params.sidebarConfig[normalizeFolderPath(workspaceId)]
    : null;
  const pinned = normalizeFolderPath(sidebar?.folder || '');
  if (pinned && exists(pinned)) return pinned;
  const overlay = sidebar?.folders || {};
  const enabled = Object.entries(overlay)
    .filter(([, meta]) => meta?.enabled !== false)
    .map(([dir]) => normalizeFolderPath(dir))
    .filter((dir) => exists(dir));
  if (enabled.length > 0) return enabled[0];
  const entry = findWorkspace(params?.registry, workspaceId);
  if (entry?.kind === 'file' && entry.workspaceFile) {
    const dir = path.posix.dirname(entry.workspaceFile);
    if (exists(dir)) return dir;
  }
  if (workspaceId && !isFolderWorkspaceId(workspaceId) && !workspaceId.endsWith('.code-workspace') && exists(workspaceId)) {
    return normalizeFolderPath(workspaceId);
  }
  return params?.fallbackCwd || process.cwd();
}
