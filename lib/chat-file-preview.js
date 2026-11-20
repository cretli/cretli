import { realpathSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isPathInsideBase } from './files-list.js';

/** Resolve symlinks before checking scope; external reads require an explicit opt-in. */
export function readChatFilePreview(basePath, filePath, { allowOutsideWorkspace = false } = {}) {
  let base;
  let resolved;
  try {
    base = realpathSync(basePath);
    resolved = realpathSync(path.resolve(base, filePath));
  } catch {
    return { status: 404, error: 'files.fileNotFound' };
  }
  const insideWorkspace = isPathInsideBase(base, resolved);
  if (!insideWorkspace && allowOutsideWorkspace !== true) return { status: 400, error: 'files.outsideWorkspace' };
  const stat = statSync(resolved);
  if (!stat.isFile()) return { status: 404, error: 'files.fileNotFound' };
  if (stat.size > 1024 * 1024) return { status: 413, error: 'files.tooLargeForPreview' };
  const content = readFileSync(resolved, 'utf8');
  if (content.includes('\0')) return { status: 400, error: 'files.readError' };
  return { status: 200, path: (insideWorkspace ? path.relative(base, resolved) : resolved).replace(/\\/g, '/'), content };
}
