/**
 * Generic, kind-agnostic wake-up store (`data/wakeups.json`, schema `v: 1`).
 *
 * One durable row per scheduling episode. The store only knows the common
 * envelope (`id`, `kind`, `subjectType`, `subjectId`, `state`, `reason`,
 * `pausedAt`, `updatedAt`); kind-specific fields stay flat and are normalized by
 * the kind. Rows of a kind that is not in {@link WAKEUP_KINDS} are carried
 * through load/save/prune untouched and never cancelled by a sweep.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

export const WAKEUPS_SCHEMA_VERSION = 1;
export const WAKEUPS_MAX_ROWS = 200;
export const WAKEUPS_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Kinds this build knows how to prune; every other kind is left alone. */
export const WAKEUP_KINDS = Object.freeze(['usage_limit_resume', 'condition_check']);
const TERMINAL_STATES = new Set(['resumed', 'cancelled', 'expired', 'blocked']);

/**
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function wakeupsPath(options = {}) {
  const dir = String(options.dataDir ?? '').trim();
  return dir ? path.join(dir, 'wakeups.json') : resolveDataPath('wakeups.json');
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {Record<string, any>[]} rows; a missing or corrupt file is an empty list
 */
export function loadWakeups(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(wakeupsPath(options), 'utf8'));
    const rows = Array.isArray(parsed?.items) ? parsed.items : [];
    return rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row) && row.id);
  } catch {
    return [];
  }
}

function rowTime(row) {
  const t = Date.parse(row.updatedAt || row.pausedAt || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Drops old terminal rows, then the oldest known-kind rows beyond the cap.
 * Rows of an unknown kind are never dropped.
 *
 * @param {Record<string, any>[]} rows
 * @param {number} now
 * @returns {Record<string, any>[]}
 */
function pruneWakeups(rows, now) {
  const isKnown = (row) => WAKEUP_KINDS.includes(row.kind);
  let kept = rows.filter((row) => !isKnown(row)
    || !TERMINAL_STATES.has(row.state)
    || now - rowTime(row) <= WAKEUPS_TERMINAL_RETENTION_MS);
  let overflow = kept.length - WAKEUPS_MAX_ROWS;
  if (overflow <= 0) return kept;
  const droppable = kept.filter(isKnown).sort((a, b) => {
    const terminalDiff = Number(TERMINAL_STATES.has(b.state)) - Number(TERMINAL_STATES.has(a.state));
    return terminalDiff || rowTime(a) - rowTime(b);
  });
  const drop = new Set(droppable.slice(0, overflow));
  kept = kept.filter((row) => !drop.has(row));
  return kept;
}

/**
 * @param {Record<string, any>[]} rows
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {Record<string, any>[]} the rows actually written
 */
export function saveWakeups(rows, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const pruned = pruneWakeups(Array.isArray(rows) ? rows : [], now);
  writeJsonAtomic(wakeupsPath(options), {
    v: WAKEUPS_SCHEMA_VERSION,
    updatedAt: new Date(now).toISOString(),
    items: pruned,
  });
  return pruned;
}

/**
 * Idempotent on the record id: an existing row (in any state) is returned
 * unchanged, so re-detecting a window never duplicates or resurrects a row.
 *
 * @param {Record<string, any>} record
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {{ created: boolean, record: Record<string, any>|null }}
 */
export function armWakeup(record, options = {}) {
  if (!record || typeof record !== 'object' || !record.id || !record.kind) {
    return { created: false, record: null };
  }
  const rows = loadWakeups(options);
  const existing = rows.find((row) => row.id === record.id);
  if (existing) return { created: false, record: existing };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const row = { ...record, updatedAt: new Date(now).toISOString() };
  saveWakeups([...rows, row], options);
  return { created: true, record: row };
}

function cancelRow(row, reason, now) {
  row.state = 'cancelled';
  row.reason = String(reason || 'cancelled');
  row.updatedAt = new Date(now).toISOString();
}

/**
 * Cancels one `armed` row. Idempotent: a row that is already past `armed`
 * (including `cancelled`) is reported with `changed: false`.
 *
 * @param {string} id
 * @param {string} reason
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {{ ok: boolean, changed: boolean, record?: Record<string, any>, code?: string }}
 */
export function cancelWakeup(id, reason, options = {}) {
  const rows = loadWakeups(options);
  const row = rows.find((entry) => entry.id === String(id || ''));
  if (!row) return { ok: false, changed: false, code: 'not_found' };
  if (row.state !== 'armed') return { ok: true, changed: false, record: row };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  cancelRow(row, reason, now);
  saveWakeups(rows, options);
  return { ok: true, changed: true, record: row };
}

/**
 * Cancels every `armed` row of exactly one kind that matches the criteria.
 * A non-empty `leafId` matches rows with the same leaf and rows without a leaf
 * id (the parent-wide fallback); a row of another leaf is left alone.
 *
 * @param {{ kind: string, subjectType?: string, subjectId?: string, parentChatId?: string, leafId?: string, reason?: string }} criteria
 * @param {Record<string, any>} [options]
 * @returns {number} cancelled row count
 */
export function cancelWakeupsWhere(criteria = {}, options = {}) {
  const kind = String(criteria.kind || '');
  if (!kind) return 0;
  const leafId = String(criteria.leafId || '');
  const rows = loadWakeups(options);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  let count = 0;
  for (const row of rows) {
    if (row.kind !== kind || row.state !== 'armed') continue;
    if (criteria.subjectType && row.subjectType !== criteria.subjectType) continue;
    if (criteria.subjectId && row.subjectId !== criteria.subjectId) continue;
    if (criteria.parentChatId && row.parentChatId !== criteria.parentChatId) continue;
    if (leafId && row.leafId && row.leafId !== leafId) continue;
    cancelRow(row, criteria.reason, now);
    count += 1;
  }
  if (count > 0) saveWakeups(rows, options);
  return count;
}

/**
 * Shallow-merges `fields` into one row (scheduler state transitions). The
 * envelope identity (`id`, `kind`) can never be rewritten.
 *
 * @param {string} id
 * @param {Record<string, unknown>} fields
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {Record<string, any>|null} the updated row, or null when it does not exist
 */
export function patchWakeup(id, fields, options = {}) {
  const rows = loadWakeups(options);
  const row = rows.find((entry) => entry.id === String(id || ''));
  if (!row) return null;
  // Compare-and-set: refuse the write when the row left the expected state.
  if (options.expectState && row.state !== options.expectState) return null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  Object.assign(row, fields || {}, { id: row.id, kind: row.kind, updatedAt: new Date(now).toISOString() });
  saveWakeups(rows, options);
  return row;
}

/**
 * @param {{ kind?: string, state?: string }} [filter]
 * @param {{ dataDir?: string }} [options]
 * @returns {Record<string, any>[]}
 */
export function listWakeups(filter = {}, options = {}) {
  return loadWakeups(options).filter((row) => (!filter.kind || row.kind === filter.kind)
    && (!filter.state || row.state === filter.state));
}

/**
 * @param {string} kind
 * @param {string} subjectType
 * @param {string} subjectId
 * @param {{ dataDir?: string }} [options]
 * @returns {Record<string, any>|null} newest row for the subject by `pausedAt`
 */
export function newestWakeupForSubject(kind, subjectType, subjectId, options = {}) {
  const matches = loadWakeups(options).filter((row) => row.kind === kind
    && row.subjectType === subjectType && row.subjectId === subjectId);
  matches.sort((a, b) => (Date.parse(b.pausedAt) || 0) - (Date.parse(a.pausedAt) || 0));
  return matches[0] || null;
}
