/**
 * Usage journal retention.
 *
 * The append-only journal under `data/usage/` is stored as one
 * `YYYY-MM-DD.jsonl` file per UTC day. This module owns the operator-facing
 * retention: it deletes day files older than the configured window and reports
 * the directory size for the Settings UI.
 *
 * The durable ledger read-model (`ledger-index.json`) has its own key/baseline
 * retention floor (`USAGE_KEY_RETENTION_MS`, 30 days) and is pruned through
 * `pruneUsageRetention`, never by deleting files behind its back. A configured
 * window shorter than that floor only shortens the journal, not identity dedup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pruneUsageRetention, resolveUsageDataDir } from '../persist/usage-persist.js';
import {
  getUsageSettings,
  normalizeUsageSettings,
  USAGE_MAX_RETENTION_DAYS,
  USAGE_MIN_RETENTION_DAYS,
} from './usage-settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * @param {unknown} value
 * @returns {number}
 */
function nowFrom(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

/**
 * Retention window in whole days. Accepts a normalized settings object, a raw
 * settings object, or a plain day count.
 *
 * @param {unknown} input
 * @returns {number}
 */
export function resolveUsageRetentionDays(input) {
  if (Number.isFinite(Number(input))) {
    return Math.min(USAGE_MAX_RETENTION_DAYS, Math.max(USAGE_MIN_RETENTION_DAYS, Math.round(Number(input))));
  }
  if (input && typeof input === 'object' && input.alerts && input.retentionDays != null) {
    return normalizeUsageSettings(input).retentionDays;
  }
  if (input && typeof input === 'object' && input.retentionDays != null) {
    return normalizeUsageSettings(input).retentionDays;
  }
  return getUsageSettings(input || null).retentionDays;
}

/**
 * Every `YYYY-MM-DD.jsonl` day file with its size and day key.
 *
 * @param {unknown} dataDir
 * @returns {Array<{ name: string, day: string, file: string, size: number }>}
 */
export function listUsageDayFiles(dataDir) {
  const dir = resolveUsageDataDir(dataDir);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const match = DAY_FILE_RE.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    rows.push({ name, day: match[1], file, size });
  }
  rows.sort((left, right) => left.day.localeCompare(right.day));
  return rows;
}

/**
 * Directory summary for the Settings UI. `bytes`/`files` cover the whole
 * `data/usage/` directory (journal, ledger index and the auxiliary JSONL
 * stores), while `dayFiles` covers only the prunable day journal.
 *
 * @param {{ dataDir?: unknown }} [input]
 * @returns {{
 *   dir: string,
 *   exists: boolean,
 *   files: number,
 *   bytes: number,
 *   dayFiles: number,
 *   journalBytes: number,
 *   oldestDay: string,
 *   newestDay: string,
 * }}
 */
export function summarizeUsageDataDir(input = {}) {
  const dir = resolveUsageDataDir(input.dataDir);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return {
      dir,
      exists: false,
      files: 0,
      bytes: 0,
      dayFiles: 0,
      journalBytes: 0,
      oldestDay: '',
      newestDay: '',
    };
  }
  let files = 0;
  let bytes = 0;
  let journalBytes = 0;
  let dayFiles = 0;
  let oldestDay = '';
  let newestDay = '';
  for (const name of names) {
    let stat;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files += 1;
    bytes += stat.size;
    const match = DAY_FILE_RE.exec(name);
    if (!match) continue;
    dayFiles += 1;
    journalBytes += stat.size;
    if (!oldestDay || match[1] < oldestDay) oldestDay = match[1];
    if (!newestDay || match[1] > newestDay) newestDay = match[1];
  }
  return { dir, exists: true, files, bytes, dayFiles, journalBytes, oldestDay, newestDay };
}

/**
 * Delete `YYYY-MM-DD.jsonl` files older than `retentionDays`. The cutoff is the
 * UTC day `retentionDays` before `now`; a file for that exact day is kept.
 * Auxiliary stores (`limits.jsonl`, `plan-limits.jsonl`, ...) are untouched.
 *
 * @param {{ dataDir?: unknown, retentionDays?: unknown, now?: unknown }} [input]
 * @returns {{
 *   retentionDays: number,
 *   cutoffDay: string,
 *   deleted: string[],
 *   kept: string[],
 *   bytesFreed: number,
 * }}
 */
export function pruneUsageJournal(input = {}) {
  const retentionDays = resolveUsageRetentionDays(input.retentionDays);
  const now = nowFrom(input.now);
  const cutoffDay = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 10);
  const deleted = [];
  const kept = [];
  let bytesFreed = 0;
  for (const row of listUsageDayFiles(input.dataDir)) {
    if (row.day < cutoffDay) {
      try {
        fs.unlinkSync(row.file);
        deleted.push(row.name);
        bytesFreed += row.size;
      } catch (error) {
        // A file we cannot remove is reported by staying in `kept`; retention
        // must never throw into the server startup path.
        kept.push(row.name);
      }
    } else {
      kept.push(row.name);
    }
  }
  return { retentionDays, cutoffDay, deleted, kept, bytesFreed };
}

/**
 * Full retention pass: prune the day journal with the configured window, then
 * prune ledger identity keys/baselines with the (floored) ledger retention.
 * Key pruning is best effort and never breaks the journal result.
 *
 * @param {{ dataDir?: unknown, settings?: unknown, retentionDays?: unknown, now?: unknown }} [input]
 * @returns {{ retentionDays: number, journal: ReturnType<typeof pruneUsageJournal>, keys: object }}
 */
export function runUsageRetention(input = {}) {
  const settings = input.settings ? normalizeUsageSettings(input.settings) : getUsageSettings();
  const retentionDays = input.retentionDays != null
    ? resolveUsageRetentionDays(input.retentionDays)
    : settings.retentionDays;
  const now = nowFrom(input.now);
  const journal = pruneUsageJournal({ dataDir: input.dataDir, retentionDays, now });
  let keys;
  try {
    keys = pruneUsageRetention({
      dataDir: input.dataDir,
      now,
      retentionMs: retentionDays * DAY_MS,
      pruneJournal: false,
    });
  } catch (error) {
    keys = { error: error instanceof Error ? error.message : String(error) };
  }
  return { retentionDays, journal, keys };
}
