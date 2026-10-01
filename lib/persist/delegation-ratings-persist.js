/**
 * Append-only persistence for delegation ratings.
 *
 * `data/delegation-ratings.jsonl` holds one JSON object per line: job identity,
 * the rater, the score/tags/note and a payload fingerprint — metadata only,
 * never report text. The file is capped (`DELEGATION_RATINGS_MAX_BYTES`) and
 * rotated to `<file>.1` exactly like the approval audit, so a noisy install
 * cannot fill the disk.
 *
 * Node is single-threaded and the append is one synchronous write, so records
 * from this process cannot interleave. A partial last line from a crash is
 * skipped by the tolerant reader rather than failing every later read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeDelegationRatingRecord } from '../delegation-ratings.js';

export const DELEGATION_RATINGS_FILE = resolveDataPath('delegation-ratings.jsonl');
export const DELEGATION_RATINGS_MAX_BYTES = 2_000_000;

/** Reuse a parsed snapshot while the file signature is unchanged. */
const RATINGS_CACHE_TTL_MS = 2000;

/** @type {{ file: string, signature: string, at: number, rows: object[] } | null} */
let ratingsCache = null;

/**
 * @param {string} file
 * @returns {string} Empty when the file cannot be stat'ed (first run), so the
 *   caller reads fresh instead of trusting a stale cache.
 */
function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * @param {string} file
 * @param {number} maxBytes
 */
function rotateIfNeeded(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < maxBytes) return;
    const rotated = `${file}.1`;
    try {
      fs.rmSync(rotated, { force: true });
    } catch {
      // A missing/stale rotation target must not block the new one.
    }
    fs.renameSync(file, rotated);
  } catch {
    // Missing file is fine: the first append creates it.
  }
}

/**
 * Append one validated rating record.
 *
 * @param {object} record
 * @param {{ file?: string, maxBytes?: number }} [options]
 * @returns {boolean} False on any I/O failure; the caller must not report success.
 */
export function appendDelegationRating(record, options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : DELEGATION_RATINGS_FILE;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : DELEGATION_RATINGS_MAX_BYTES;
  if (!normalizeDelegationRatingRecord(record)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file, maxBytes);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    if (ratingsCache && ratingsCache.file === file) ratingsCache = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * Read back every valid record (oldest first). Tolerates a missing file and
 * drops unparseable/truncated lines.
 *
 * @param {{ file?: string, limit?: number }} [options]
 * @returns {object[]}
 */
export function readDelegationRatings(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : DELEGATION_RATINGS_FILE;
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : 0;
  const now = Date.now();
  const signature = fileSignature(file);
  // A limited read must not poison the full-file cache with a truncated list.
  if (!limit && signature && ratingsCache && ratingsCache.file === file
    && ratingsCache.signature === signature && now - ratingsCache.at < RATINGS_CACHE_TTL_MS) {
    return ratingsCache.rows;
  }
  /** @type {object[]} */
  let rows = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    rows = text
      .split('\n')
      .map((line) => {
        if (!line.trim()) return null;
        try {
          return normalizeDelegationRatingRecord(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    rows = [];
  }
  if (signature && !limit) {
    ratingsCache = { file, signature, at: now, rows };
  }
  return limit ? rows.slice(-limit) : rows;
}

/**
 * Newest stored rating for one `(delegationId, rater)` key. Append-only order
 * means the last matching line wins.
 *
 * @param {unknown} delegationId
 * @param {unknown} rater
 * @param {{ file?: string }} [options]
 * @returns {object | null}
 */
export function findDelegationRating(delegationId, rater, options = {}) {
  const id = String(delegationId || '').trim();
  if (!id) return null;
  const wanted = `${id}:${String(rater || '').trim().toLowerCase()}`;
  const rows = readDelegationRatings(options);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (`${row.delegationId}:${row.rater}` === wanted) return row;
  }
  return null;
}

/**
 * Records at/after `from` (inclusive), oldest first.
 *
 * @param {{ file?: string, from?: number }} [options]
 * @returns {object[]}
 */
export function loadDelegationRatings(options = {}) {
  const from = Number.isFinite(Number(options.from)) ? Number(options.from) : 0;
  if (!(from > 0)) return readDelegationRatings(options);
  return readDelegationRatings(options).filter((row) => Date.parse(row.ts) >= from);
}
