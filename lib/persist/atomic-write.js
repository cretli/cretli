/**
 * Atomic JSON write: write to a temporary file, then rename.
 * Prevents data loss on concurrent writes and on a crash mid-write.
 */

import fs from 'fs';
import path from 'path';

/**
 * @param {string} filePath - destination path
 * @param {unknown} data - value to serialize
 * @param {string} [encoding='utf8']
 */
export function writeJsonAtomic(filePath, data, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), encoding);
  fs.renameSync(tmp, filePath);
}

/**
 * Atomic text write (patch artifacts, logs): write to a temporary file, then
 * rename so a crash mid-write cannot leave a truncated artifact.
 *
 * @param {string} filePath - destination path
 * @param {string} text
 * @param {string} [encoding='utf8']
 */
export function writeTextAtomic(filePath, text, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, String(text ?? ''), encoding);
  fs.renameSync(tmp, filePath);
}
