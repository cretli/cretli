/**
 * Create a directory and fail if the current process cannot write into it.
 */

import fs from 'fs';
import path from 'path';

const PROBE_FILE_NAME = '.cretli-write-probe';

/**
 * Ensures `dir` exists and is writable by the current uid.
 * `mkdirSync({ recursive: true })` succeeds on an existing directory even when
 * it is owned by another user (e.g. root `700`), so a write probe is required.
 *
 * @param {string} dir
 * @returns {string}
 */
export function ensureWritableDir(dir) {
  const resolved = String(dir || '').trim();
  if (!resolved) {
    throw new Error('Directory path is empty.');
  }
  fs.mkdirSync(resolved, { recursive: true });
  const probePath = path.join(resolved, PROBE_FILE_NAME);
  try {
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
  } catch (err) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Directory is not writable by uid ${uid}: ${resolved} (${detail})`);
  }
  return resolved;
}
