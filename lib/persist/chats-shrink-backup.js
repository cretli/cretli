/**
 * Safety net for chats.json: before a write that drops many chats, keep a copy
 * of the current file (`chats.json.pre-shrink-<ts>.json`, newest 5 kept) and
 * log a warning. Also keeps one copy per day (`chats.json.daily-<date>.json`,
 * newest 7 kept). Backups never block the write: failures only log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertDataWriteAllowed } from '../runtime-paths.js';

export const SHRINK_RATIO = 0.2;
export const SHRINK_ABSOLUTE = 100;
export const KEEP_PRE_SHRINK = 5;
export const KEEP_DAILY = 7;

/**
 * @param {number} previous
 * @param {number} next
 */
export function isChatShrink(previous, next) {
  const dropped = previous - next;
  return dropped > 0 && (dropped > previous * SHRINK_RATIO || dropped > SHRINK_ABSOLUTE);
}

/**
 * @param {string} dir
 * @param {string} prefix
 * @param {number} keep
 */
function rotate(dir, prefix, keep) {
  const names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Call right before writing `nextCount` chats over `file`.
 *
 * @param {string} file chats.json path
 * @param {number | null} previousCount chats currently stored, null when unknown
 * @param {number} nextCount
 * @param {{ now?: Date }} [options]
 * @returns {{ preShrink: string | null, daily: string | null }}
 */
export function backupChatsBeforeWrite(file, previousCount, nextCount, options = {}) {
  const result = { preShrink: null, daily: null };
  try {
    if (!fs.existsSync(file)) return result;
    const dir = path.dirname(file);
    const base = path.basename(file);
    const now = options.now || new Date();
    if (Number.isFinite(previousCount) && isChatShrink(/** @type {number} */ (previousCount), nextCount)) {
      const dest = path.join(dir, `${base}.pre-shrink-${now.getTime()}.json`);
      assertDataWriteAllowed(dest);
      fs.copyFileSync(file, dest);
      result.preShrink = dest;
      rotate(dir, `${base}.pre-shrink-`, KEEP_PRE_SHRINK);
      console.warn(`[cretli] ${base} shrinks from ${previousCount} to ${nextCount} chats; backup saved to ${dest}`);
    }
    const day = path.join(dir, `${base}.daily-${now.toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(day)) {
      assertDataWriteAllowed(day);
      fs.copyFileSync(file, day);
      result.daily = day;
      rotate(dir, `${base}.daily-`, KEEP_DAILY);
    }
  } catch (err) {
    if (err && err.code === 'CRETLI_TEST_REAL_DATA_WRITE') throw err;
    console.error(`[cretli] chats backup failed: ${err instanceof Error ? err.message : err}`);
  }
  return result;
}
