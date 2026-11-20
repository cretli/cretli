import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function countRecords(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['chats', 'items', 'todos']) if (Array.isArray(value[key])) return value[key].length;
  return null;
}

/** Last record count written per guarded file, so a write does not parse the previous file again. */
const lastCounts = new Map();

export function guardJsonShrink(filePath, nextValue, { logger = console, now = Date.now } = {}) {
  try {
  const rel = path.basename(filePath) === 'chats.json' ? 'chats.json' : filePath.replaceAll('\\', '/').split('/').slice(-2).join('/');
  if (rel !== 'chats.json' && !/^todos\/[^/]+\.json$/.test(rel)) return null;
  const nextCount = countRecords(nextValue);
  // Only the first guarded write of a file in this process reads it from disk.
  let oldCount = lastCounts.get(filePath);
  if (oldCount === undefined) {
    try { oldCount = countRecords(JSON.parse(fs.readFileSync(filePath, 'utf8'))); } catch { oldCount = null; }
  }
  if (Number.isFinite(nextCount)) lastCounts.set(filePath, nextCount);
  if (!Number.isFinite(oldCount) || !Number.isFinite(nextCount) || oldCount - nextCount <= 20 || nextCount >= oldCount * 0.5) return null;
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const backup = `${filePath}.pre-shrink-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  fs.copyFileSync(filePath, backup, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(backup, 0o600); } catch {}
  logger.error?.(`[backup] shrink alert: ${rel} records ${oldCount} -> ${nextCount}; preserved ${path.basename(backup)}`);
  return backup;
  } catch (error) {
    try { logger.warn?.('[backup] shrink guard failed; allowing the JSON write to continue:', String(error?.message || error)); } catch {}
    return null;
  }
}
