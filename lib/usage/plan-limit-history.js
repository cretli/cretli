/**
 * Append-only history of every accepted plan rate-limit reading, for every
 * harness, in ONE shared JSONL store. This is distinct from the lockout
 * history in `data/usage/limits.jsonl`: those rows record binary blocks, while
 * a plan-limit row records a single sampling (40% → 70% → rejected stays three
 * rows), never deduped.
 *
 * Kept in its own module so both `harness-health.js` (the structured snapshot
 * path) and `harness-usage-limits.js` (the text-rejection path) can import it
 * without a cycle. Only present, non-empty fields are written — no invented
 * percentages.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';

const HISTORY_FILE = resolveDataPath('usage', 'plan-limits.jsonl');
/** Retention bounds so the append-only file cannot grow without bound. */
const HISTORY_MAX_ROWS = 5000;
const HISTORY_MAX_AGE_MS = 92 * 24 * 60 * 60 * 1000;
/** Trim every N appends even when the file is still small. */
const HISTORY_TRIM_EVERY = 100;
const HISTORY_MAX_BYTES = 1024 * 1024;

/** Appends since the last retention pass, keyed by absolute history path. */
const historyAppendCounts = new Map();

/**
 * @param {unknown} dataDir
 * @returns {string}
 */
function resolvePlanLimitHistoryFile(dataDir) {
  const override = String(dataDir || '').trim();
  return override ? path.join(override, 'usage', 'plan-limits.jsonl') : HISTORY_FILE;
}

/**
 * Accepts epoch seconds, epoch milliseconds, or an ISO-ish string.
 *
 * @param {unknown} value
 * @returns {string} ISO timestamp or ''
 */
function normalizeTimestamp(value) {
  if (value == null || value === '') return '';
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const parsed = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/**
 * Builds a history row from only the present, non-empty fields, rejecting a
 * reading that carries none of status/utilization/resetsAt/rateLimitType.
 *
 * @param {object} input
 * @returns {object|null}
 */
function buildHistoryRow(input = {}) {
  const harness = String(input.harness || '').trim().toLowerCase();
  if (!harness) return null;
  const status = String(input.status || '').trim();
  const rateLimitType = String(input.rateLimitType || '').trim();
  const model = String(input.model || '').trim();
  const utilizationValue = input.utilization == null || input.utilization === '' ? NaN : Number(input.utilization);
  const utilization = Number.isFinite(utilizationValue) ? utilizationValue : undefined;
  const resetsAt = normalizeTimestamp(input.resetsAt);
  if (!status && !rateLimitType && utilization === undefined && !resetsAt) return null;
  const observedAt = normalizeTimestamp(input.observedAt) || new Date().toISOString();
  return {
    harness,
    ...(rateLimitType ? { rateLimitType } : {}),
    ...(status ? { status } : {}),
    ...(utilization === undefined ? {} : { utilization }),
    ...(resetsAt ? { resetsAt } : {}),
    observedAt,
    ...(model ? { model } : {}),
  };
}

/**
 * @param {string} file
 * @returns {object[]}
 */
function readHistoryRows(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // Skip a corrupt line rather than failing the whole history.
    }
  }
  return rows;
}

/**
 * Rewrites the history atomically, keeping the retention window: rows from the
 * last 92 days, capped at the newest `HISTORY_MAX_ROWS`.
 *
 * @param {string} file
 * @returns {void}
 */
function trimHistory(file) {
  const kept = readHistoryRows(file).filter((row) => {
    const ts = Date.parse(String(row.observedAt || ''));
    return !Number.isFinite(ts) || ts >= Date.now() - HISTORY_MAX_AGE_MS;
  });
  const limited = kept.length > HISTORY_MAX_ROWS ? kept.slice(kept.length - HISTORY_MAX_ROWS) : kept;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(
      tmp,
      limited.length ? `${limited.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
      'utf8',
    );
    fs.renameSync(tmp, file);
    historyAppendCounts.set(file, 0);
  } catch (error) {
    console.warn('[plan-limit-history] trim failed:', error?.message || error);
  }
}

/**
 * Schedules a retention pass: every `HISTORY_TRIM_EVERY` appends, or as soon as
 * the file grows past `HISTORY_MAX_BYTES`.
 *
 * @param {string} file
 * @returns {void}
 */
function maybeTrimHistory(file) {
  const appends = (historyAppendCounts.get(file) || 0) + 1;
  historyAppendCounts.set(file, appends);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  if (size <= HISTORY_MAX_BYTES && appends < HISTORY_TRIM_EVERY) return;
  trimHistory(file);
}

/**
 * Appends one plan-limit reading. Returns the stored row, or null when the
 * reading carried none of status/utilization/resetsAt/rateLimitType. Never
 * invents a percentage and never dedupes consecutive samples.
 *
 * @param {object} [input]
 * @returns {object|null}
 */
export function appendHarnessPlanLimitHistory(input = {}) {
  const row = buildHistoryRow(input);
  if (!row) return null;
  try {
    const file = resolvePlanLimitHistoryFile(input.dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    maybeTrimHistory(file);
  } catch (error) {
    console.warn('[plan-limit-history] append failed:', error?.message || error);
    return null;
  }
  return row;
}

/**
 * @param {unknown} value
 * @param {boolean} end
 * @returns {string}
 */
function normalizeHistoryBound(value, end) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return end ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  return raw;
}

/**
 * Reads the append-only plan-limit history (`data/usage/plan-limits.jsonl`),
 * sorted ascending by `observedAt`. A positive `limit` keeps the newest rows.
 *
 * @param {{ harness?: string, from?: string, to?: string, limit?: number, dataDir?: string }} [query]
 * @returns {object[]}
 */
export function readHarnessPlanLimitHistory(query = {}) {
  const rows = readHistoryRows(resolvePlanLimitHistoryFile(query.dataDir));
  const harness = String(query.harness || '').trim().toLowerCase();
  const from = normalizeHistoryBound(query.from, false);
  const to = normalizeHistoryBound(query.to, true);
  const requestedLimit = Number.parseInt(String(query.limit ?? ''), 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 0;
  let filtered = rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    if (harness && String(row.harness || '').toLowerCase() !== harness) return false;
    const at = String(row.observedAt || '');
    if (from && at < from) return false;
    if (to && at > to) return false;
    return true;
  });
  filtered.sort((a, b) => String(a.observedAt || '').localeCompare(String(b.observedAt || '')));
  if (limit > 0 && filtered.length > limit) filtered = filtered.slice(filtered.length - limit);
  return filtered;
}
