import path from 'path';
import { existsSync, realpathSync, statSync } from 'fs';

/**
 * Resolves a relative path inside workspace cwd; returns null when outside sandbox.
 */
export function resolveWorkspacePath(cwd: string, relPath: string): string | null {
  const base = String(cwd || '').trim();
  if (!base || !existsSync(base)) return null;
  const rel = String(relPath || '').trim();
  if (!rel) return null;
  const requested = path.resolve(base, rel);
  let baseReal: string;
  let resolvedReal: string;
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

export function isExistingFile(resolvedPath: string): boolean {
  if (!resolvedPath) return false;
  try {
    return existsSync(resolvedPath) && statSync(resolvedPath).isFile();
  } catch {
    return false;
  }
}

export function isExistingDirectory(resolvedPath: string): boolean {
  if (!resolvedPath) return false;
  try {
    return existsSync(resolvedPath) && statSync(resolvedPath).isDirectory();
  } catch {
    return false;
  }
}

export function toWorkspaceRelativePath(cwd: string, resolvedPath: string): string {
  const rel = path.relative(cwd, resolvedPath);
  return rel.split(path.sep).join('/');
}
