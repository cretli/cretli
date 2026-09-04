/**
 * Absolute filesystem browsing for path pickers (folders and workspace files).
 *
 * Directory listing plus single-level mkdir, used by the frontend folder/file
 * picker (Settings → Workspace, first run, Cursor context dirs). The route
 * layer (requireAuth) enforces access; this module never reads file contents.
 *
 * `~` in the picker means the login user's home, not the agent sandbox
 * (`data/runtime-home`) that Cretli / Cursor worktrees assign to `HOME`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataPath } from './runtime-paths.js';

/** Hard cap on entries returned for one directory (protects huge listings). */
export const FS_BROWSE_MAX_ENTRIES = 2000;

/** Single path segment; matches typical filesystem name limits. */
export const FS_BROWSE_MAX_FOLDER_NAME = 255;

const MAX_ANCESTOR_WALKS = 64;

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function isAgentSandboxHome(dir) {
  const resolved = path.resolve(String(dir || ''));
  if (!resolved || resolved === '/root') return true;
  const sandbox = path.resolve(resolveDataPath('runtime-home'));
  return resolved === sandbox || resolved.startsWith(`${sandbox}${path.sep}`);
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isExistingDirectory(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @returns {string}
 */
function homeFromHomeEntries() {
  let names;
  try {
    names = fs.readdirSync('/home');
  } catch {
    return '';
  }
  const preferred = String(process.env.SUDO_USER || '').trim();
  const ordered = preferred && preferred !== 'root' && names.includes(preferred)
    ? [preferred, ...names.filter((name) => name !== preferred)]
    : names;
  for (const name of ordered) {
    if (!name || name.startsWith('.') || name === 'lost+found') continue;
    const candidate = path.join('/home', name);
    if (isExistingDirectory(candidate)) return candidate;
  }
  return '';
}

/**
 * User-facing home for the path picker.
 * Skips `/root` and Cretli's `data/runtime-home` sandbox so Browse starts
 * in a real login home (needed when the server runs as root in a worktree).
 *
 * @returns {string}
 */
export function homeBrowseDir() {
  const envHome = String(process.env.HOME || os.homedir() || '').trim();
  let passwdHome = '';
  try {
    passwdHome = String(os.userInfo().homedir || '').trim();
  } catch {
    passwdHome = '';
  }
  const sudoUser = String(process.env.SUDO_USER || '').trim();
  const sudoHome = sudoUser && sudoUser !== 'root' ? path.join('/home', sudoUser) : '';
  const candidates = [
    envHome && !isAgentSandboxHome(envHome) ? envHome : '',
    passwdHome && !isAgentSandboxHome(passwdHome) ? passwdHome : '',
    sudoHome,
    homeFromHomeEntries(),
    isExistingDirectory(envHome) ? envHome : '',
    '/',
  ];
  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) return path.resolve(candidate);
  }
  return '/';
}

/**
 * Normalizes a raw picker path to an absolute directory path.
 * Empty input and a bare `~` both mean the user home directory.
 *
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizeBrowseDir(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed || trimmed === '~') return homeBrowseDir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(homeBrowseDir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

/**
 * Nearest existing directory at or above `rawPath` (files walk to dirname).
 *
 * @param {string} rawPath
 * @returns {string}
 */
export function resolveExistingBrowseDir(rawPath) {
  let target = normalizeBrowseDir(rawPath);
  for (let i = 0; i < MAX_ANCESTOR_WALKS; i += 1) {
    try {
      if (fs.statSync(target).isDirectory()) return target;
    } catch {
      // missing — walk up
    }
    const parent = path.dirname(target);
    if (parent === target) return '';
    target = parent;
  }
  return '';
}

/**
 * @param {string} rawPath
 * @returns {string} posix form of the path (used by the client for display/keys)
 */
export function toBrowsePosix(rawPath) {
  return String(rawPath || '').replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * Lists one directory for the picker.
 *
 * @param {string} rawPath - absolute path, `~` or empty (home)
 * @param {{ includeHidden?: boolean }} [options]
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   path?: string,
 *   parent?: string,
 *   home?: string,
 *   canGoUp?: boolean,
 *   entries?: Array<{ name: string, path: string, isDir: boolean, sizeBytes: number|null }>,
 *   truncated?: boolean
 * }}
 */
export function listAbsoluteBrowseDir(rawPath, options = {}) {
  const includeHidden = options?.includeHidden === true;
  const target = resolveExistingBrowseDir(rawPath);
  if (!target) return { ok: false, error: 'not-found' };
  let names;
  try {
    names = fs.readdirSync(target);
  } catch (err) {
    return { ok: false, error: 'readdir', detail: err?.message || '' };
  }
  const entries = [];
  let truncated = false;
  for (const name of names) {
    if (!includeHidden && String(name).startsWith('.')) continue;
    if (entries.length >= FS_BROWSE_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const fullPath = path.join(target, name);
    let isDir = false;
    let sizeBytes = null;
    try {
      const st = fs.statSync(fullPath);
      isDir = st.isDirectory();
      if (st.isFile()) sizeBytes = st.size;
    } catch {
      continue; // unreadable entry — skip it for the picker
    }
    entries.push({
      name,
      path: toBrowsePosix(fullPath),
      isDir,
      sizeBytes,
    });
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  const parent = path.dirname(target);
  return {
    ok: true,
    path: toBrowsePosix(target),
    parent: toBrowsePosix(parent),
    home: toBrowsePosix(homeBrowseDir()),
    canGoUp: parent !== target,
    entries,
    truncated,
  };
}

/**
 * True when `name` is a single path segment safe to mkdir under a parent.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidBrowseFolderName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  if (trimmed.length > FS_BROWSE_MAX_FOLDER_NAME) return false;
  if (trimmed.includes('\0') || /[\\/]/.test(trimmed)) return false;
  return true;
}

/**
 * @param {string} childPath
 * @param {string} parentPath
 * @returns {boolean}
 */
function isPathInsideParent(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * @param {NodeJS.ErrnoException} err
 * @returns {{ ok: false, error: string, detail?: string }}
 */
function mapMkdirError(err) {
  if (err?.code === 'EEXIST') return { ok: false, error: 'exists' };
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return { ok: false, error: 'permission' };
  return { ok: false, error: 'mkdir', detail: err?.message || '' };
}

/**
 * Creates one folder under an existing parent directory (no nested paths).
 *
 * @param {string} parentRawPath - absolute path, `~` or empty (home)
 * @param {string} name - single folder name (no `/` or `\`)
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   detail?: string,
 *   path?: string,
 *   parent?: string
 * }}
 */
export function createBrowseFolder(parentRawPath, name) {
  const folderName = String(name || '').trim();
  if (!isValidBrowseFolderName(folderName)) return { ok: false, error: 'invalid-name' };
  const parent = normalizeBrowseDir(parentRawPath);
  try {
    if (!fs.statSync(parent).isDirectory()) return { ok: false, error: 'not-dir' };
  } catch {
    return { ok: false, error: 'not-found' };
  }
  const fullPath = path.join(parent, folderName);
  if (!isPathInsideParent(fullPath, parent)) return { ok: false, error: 'invalid-name' };
  try {
    fs.mkdirSync(fullPath);
  } catch (err) {
    return mapMkdirError(err);
  }
  return {
    ok: true,
    path: toBrowsePosix(fullPath),
    parent: toBrowsePosix(parent),
  };
}
