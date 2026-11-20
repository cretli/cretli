/**
 * Warns about top-level files in the runtime data directory that grew past a
 * size threshold, and exposes the same list to the diagnostics endpoint.
 *
 * The scan takes the directory as an argument so tests can point it at a temp
 * directory instead of the live `data/`.
 */

import { readdirSync, statSync } from 'fs';
import path from 'path';

const DEFAULT_WARN_BYTES = 20 * 1024 * 1024;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveDataWarnBytes(env = process.env) {
  const parsed = Number.parseInt(String(env?.CRETLI_DATA_WARN_BYTES ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WARN_BYTES;
}

/**
 * Lists the top-level regular files larger than `thresholdBytes`, largest
 * first. A missing or unreadable directory is a no-op.
 *
 * @param {string} dataDir
 * @param {{ thresholdBytes?: number }} [options]
 * @returns {Array<{ name: string, bytes: number }>}
 */
export function listLargeDataFiles(dataDir, { thresholdBytes = resolveDataWarnBytes() } = {}) {
  let entries;
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of entries) {
    // stat (not just the name) so a symlink to a large regular file is included;
    // directories are not.
    try {
      const stats = statSync(path.join(dataDir, name));
      if (stats.isFile() && stats.size > thresholdBytes) rows.push({ name, bytes: stats.size });
    } catch {
      // A file can disappear between readdir and stat; skip it.
    }
  }
  return rows.sort((left, right) => right.bytes - left.bytes);
}

/**
 * Logs one warning line per oversized top-level data file and returns the list.
 *
 * @param {string} dataDir
 * @param {{ thresholdBytes?: number, logger?: { warn: (...args: unknown[]) => void } }} [options]
 * @returns {Array<{ name: string, bytes: number }>}
 */
export function warnLargeDataFiles(dataDir, { thresholdBytes = resolveDataWarnBytes(), logger = console } = {}) {
  const rows = listLargeDataFiles(dataDir, { thresholdBytes });
  for (const row of rows) {
    logger.warn(`[data-dir] ${row.name} is ${row.bytes} bytes (threshold ${thresholdBytes})`);
  }
  return rows;
}
