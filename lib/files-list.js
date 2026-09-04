/**
 * Workspace file listing for the Files panel.
 * Uses name + stat (not Dirent.d_type) so Android/Termux still lists folders
 * when readdir reports UV_DIRENT_UNKNOWN.
 */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandUserPath } from './workspace.js';

/**
 * @param {string} rawPath
 * @returns {string}
 */
export function resolveExistingDir(rawPath) {
  const expanded = expandUserPath(rawPath);
  if (!expanded) return '';
  const absolutePath = path.resolve(expanded);
  if (!existsSync(absolutePath)) return '';
  try {
    if (!statSync(absolutePath).isDirectory()) return '';
  } catch {
    return '';
  }
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * @param {string} basePath
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isPathInsideBase(basePath, targetPath) {
  if (!basePath || !targetPath) return false;
  if (targetPath === basePath) return true;
  return targetPath.startsWith(basePath + path.sep);
}

/**
 * @typedef {Object} FileListEntry
 * @property {string} name
 * @property {string} path
 * @property {boolean} isDir
 * @property {number|null} sizeBytes
 * @property {number|null} dirEntries
 */

/**
 * @param {object} params
 * @param {string} params.basePath
 * @param {string} [params.relDir]
 * @param {boolean} [params.includeHidden]
 * @returns {{ ok: boolean, error?: string, root?: string, dir?: string, entries: FileListEntry[] }}
 */
export function listWorkspaceEntries({ basePath, relDir = '', includeHidden = false }) {
  const root = resolveExistingDir(basePath);
  if (!root) {
    return { ok: false, error: 'no-workspace', entries: [] };
  }
  const rel = typeof relDir === 'string' ? relDir.trim() : '';
  const requested = rel ? path.join(root, rel) : root;
  const resolved = path.resolve(requested);
  if (!isPathInsideBase(root, resolved)) {
    return { ok: false, error: 'outside', entries: [] };
  }
  const listed = resolveExistingDir(resolved);
  if (!listed || !isPathInsideBase(root, listed)) {
    return { ok: false, error: 'missing', entries: [] };
  }
  let names;
  try {
    names = readdirSync(listed);
  } catch (err) {
    return { ok: false, error: err?.message || 'readdir', entries: [] };
  }
  const toPosix = (value) => (value || '').split(path.sep).join('/');
  const entries = names
    .filter((name) => includeHidden || !String(name).startsWith('.'))
    .map((name) => {
      const fullPath = path.join(listed, name);
      let isDir = false;
      let sizeBytes = null;
      try {
        const st = statSync(fullPath);
        isDir = st.isDirectory();
        if (st.isFile()) sizeBytes = st.size;
      } catch {
        return null;
      }
      return {
        name,
        path: toPosix(path.join(rel, name)),
        isDir,
        sizeBytes,
        dirEntries: null,
      };
    })
    .filter((entry) => entry != null)
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  return {
    ok: true,
    root,
    dir: rel || '.',
    entries,
  };
}
