import path from 'path';
import { existsSync, realpathSync, statSync } from 'fs';

/**
 * Resolves a relative path inside workspace cwd; returns null when outside sandbox.
 *
 * @param {string} cwd
 * @param {string} relPath
 * @returns {string | null}
 */
export function resolveWorkspacePath(cwd, relPath) {
  const base = String(cwd || '').trim();
  if (!base || !existsSync(base)) return null;
  const rel = String(relPath || '').trim();
  if (!rel) return null;
  const requested = path.resolve(base, rel);
  let baseReal;
  let resolvedReal;
  try {
    baseReal = realpathSync(base);
    resolvedReal = realpathSync(requested);
  } catch {
    return null;
  }
  if (resolvedReal !== baseReal && !resolvedReal.startsWith(baseReal + path.sep)) {
    return null;
  }
  return resolvedReal;
}

/**
 * @param {string} resolvedPath
 * @returns {boolean}
 */
export function isExistingFile(resolvedPath) {
  if (!resolvedPath) return false;
  try {
    return existsSync(resolvedPath) && statSync(resolvedPath).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} resolvedPath
 * @returns {boolean}
 */
export function isExistingDirectory(resolvedPath) {
  if (!resolvedPath) return false;
  try {
    return existsSync(resolvedPath) && statSync(resolvedPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd
 * @param {string} resolvedPath
 * @returns {string}
 */
export function toWorkspaceRelativePath(cwd, resolvedPath) {
  const rel = path.relative(cwd, resolvedPath);
  return rel.split(path.sep).join('/');
}
