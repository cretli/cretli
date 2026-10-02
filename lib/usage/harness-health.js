/**
 * Per-harness health view: run success/latency, lockout history and the last
 * known plan rate-limit snapshot.
 *
 * Telemetry stays aggregate: no prompt text, report bodies or file paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { readUsageEvents } from '../persist/usage-persist.js';
import { resolveUsageHarness, summarizeUsage } from './usage-ledger.js';
import { getHarnessUsageLimit, readHarnessUsageLimitHistory } from '../harness-usage-limits.js';

/** A plan snapshot older than this is flagged `stale` in the health response. */
export const PLAN_LIMIT_STALE_MS = 6 * 60 * 60 * 1000;

const PLAN_LIMITS_FILE = 'harness-plan-limits.json';
const MAX_LAST_ERRORS = 5;

/**
 * @param {unknown} dataDir
 * @returns {string}
 */
function resolvePlanLimitsFile(dataDir) {
  const override = String(dataDir || '').trim();
  return override ? path.join(override, PLAN_LIMITS_FILE) : resolveDataPath(PLAN_LIMITS_FILE);
}

/**
 * @param {unknown} dataDir
 * @returns {object[]}
 */
function readPlanLimitStore(dataDir) {
  const file = resolvePlanLimitsFile(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // A missing store is normal: nothing recorded yet.
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === 'object') : [];
  } catch (error) {
    // Keep the unreadable bytes next to the store instead of silently letting
    // the next upsert overwrite every snapshot.
    try {
      fs.copyFileSync(file, `${file}.corrupt`);
    } catch { /* best effort */ }
    console.warn(
      '[harness-health] plan-limit store is corrupt; kept a copy at *.corrupt:',
      error?.message || error,
    );
    return [];
  }
}

/**
 * @param {unknown} value
 * @returns {string} ISO timestamp or ''
 */
function normalizeObservedAt(value) {
  if (value == null || value === '') return '';
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const parsed = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/**
 * @param {unknown} value
 * @returns {string} ISO timestamp or ''
 */
function normalizeResetsAt(value) {
  return normalizeObservedAt(value);
}

/**
 * Upserts the last known plan-limit snapshot, keyed by harness + window type.
 * Missing numbers stay missing: the caller must not invent a percentage.
 *
 * @param {{ harness?: string, status?: string, utilization?: number, resetsAt?: string, rateLimitType?: string, observedAt?: string, dataDir?: string }} [input]
 * @returns {object|null} the stored snapshot, or null when there is nothing to store
 */
export function noteHarnessPlanLimit(input = {}) {
  const harness = String(input.harness || '').trim().toLowerCase();
  if (!harness) return null;
  const status = String(input.status || '').trim();
  const rateLimitType = String(input.rateLimitType || '').trim();
  const utilizationValue = input.utilization == null || input.utilization === '' ? NaN : Number(input.utilization);
  const utilization = Number.isFinite(utilizationValue) ? utilizationValue : undefined;
  const resetsAt = normalizeResetsAt(input.resetsAt);
  const observedAt = normalizeObservedAt(input.observedAt) || new Date().toISOString();
  if (!status && !rateLimitType && utilization === undefined && !resetsAt) return null;
  const snapshot = {
    harness,
    ...(status ? { status } : {}),
    ...(utilization === undefined ? {} : { utilization }),
    ...(resetsAt ? { resetsAt } : {}),
    ...(rateLimitType ? { rateLimitType } : {}),
    observedAt,
  };
  const snapshotKey = `${harness}:${rateLimitType || '*'}`;
  const store = readPlanLimitStore(input.dataDir);
  const previous = store.find((row) => `${String(row.harness || '').toLowerCase()}:${String(row.rateLimitType || '*')}` === snapshotKey);
  // Samples belong to one reset window. Decreases/reset changes start a new
  // baseline; never turn token-ledger totals into a provider percentage.
  const sameWindow = resetsAt && previous?.resetsAt === resetsAt;
  const samples = sameWindow && utilization !== undefined && utilization >= previous?.utilization
    ? (Array.isArray(previous.samples) ? previous.samples : [previous]) : [];
  snapshot.samples = [...samples.filter((row) => Date.parse(row.observedAt) < Date.parse(observedAt)),
    ...(utilization === undefined ? [] : [{ utilization, observedAt }])]
    .slice(-32).map(({ utilization, observedAt }) => ({ utilization, observedAt }));
  if (previous && Date.parse(previous.observedAt) > Date.parse(observedAt)) return previous;
  const next = store.filter(
    (row) => `${String(row.harness || '').toLowerCase()}:${String(row.rateLimitType || '*')}` !== snapshotKey
  );
  next.push(snapshot);
  try {
    writeJsonAtomic(resolvePlanLimitsFile(input.dataDir), next);
  } catch (error) {
    console.warn('[harness-health] plan-limit persist failed:', error?.message || error);
  }
  return snapshot;
}

/**
 * @param {string} harness
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {object[]}
 */
export function readHarnessPlanLimits(harness, options = {}) {
  const wanted = String(harness || '').trim().toLowerCase();
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return readPlanLimitStore(options.dataDir)
    .filter((row) => !wanted || String(row.harness || '').toLowerCase() === wanted)
    .map((row) => {
      const observed = new Date(row.observedAt).getTime();
      const stale = !Number.isFinite(observed) || now - observed > PLAN_LIMIT_STALE_MS;
      const resetMs = Date.parse(row.resetsAt);
      const expired = Number.isFinite(resetMs) && resetMs <= now;
      const knownUsage = row.utilization != null && row.utilization !== '' && Number.isFinite(Number(row.utilization));
      const remainingPercent = !expired && knownUsage ? Math.max(0, 100 - Number(row.utilization)) : null;
      // Linear estimate from measured growth only. Keep it explicitly separate
      // from the last provider reading; require a minute between samples.
      let forecast = null;
      if (!stale && !expired && knownUsage && resetMs > now && observed <= now) {
        const samples = Array.isArray(row.samples) ? row.samples : [];
        const baseline = samples.find((sample) => {
          const at = Date.parse(sample.observedAt);
          return observed - at >= 60_000 && observed - at <= PLAN_LIMIT_STALE_MS
            && sample.utilization != null && Number(sample.utilization) < Number(row.utilization);
        });
        if (baseline) {
          const rate = (Number(row.utilization) - Number(baseline.utilization)) / (observed - Date.parse(baseline.observedAt));
          const exhaustionMs = observed + Math.max(0, 100 - Number(row.utilization)) / rate;
          if (Number.isFinite(exhaustionMs) && Math.abs(exhaustionMs) <= 8.64e15) forecast = {
            exhaustsAt: new Date(exhaustionMs).toISOString(),
            beforeReset: exhaustionMs < resetMs,
            percentPerHour: rate * 3_600_000,
          };
        }
      }
      const { samples: _samples, ...snapshot } = row;
      return { ...snapshot, stale, expired, remainingPercent,
        resetInMs: Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : null, forecast };
    })
    .sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || '')));
}

/**
 * @param {unknown} value
 * @returns {string} YYYY-MM-DD or ''
 */
function normalizeDay(value) {
  const day = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? '' : day;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function enumerateDays(from, to) {
  const days = [];
  if (from > to) return days;
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * @param {object} event
 * @param {string} day
 * @returns {boolean}
 */
function isRunOnDay(event, day) {
  return String(event?.at || '').slice(0, 10) === day;
}

/**
 * Builds the aggregate health payload for one harness.
 *
 * `events` optionally injects already range-filtered usage events so a caller
 * that builds health for every catalog harness reads the ledger only once.
 *
 * @param {{ harness?: string, from?: string, to?: string, dataDir?: string, now?: number, events?: object[] }} [input]
 * @returns {object|null}
 */
export function buildHarnessHealth(input = {}) {
  const harness = String(input.harness || '').trim().toLowerCase();
  if (!harness) return null;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const to = normalizeDay(input.to) || new Date(now).toISOString().slice(0, 10);
  const from = normalizeDay(input.from) || to;

  const sourceEvents = Array.isArray(input.events)
    ? input.events
    : readUsageEvents({
      from,
      to: `${to}T23:59:59.999Z`,
      dataDir: input.dataDir,
    });
  const events = sourceEvents.filter((event) => resolveUsageHarness(event) === harness);
  const summary = summarizeUsage(events);
  const runEvents = events.filter((event) => event?.eventType === 'run');
  const errorEvents = runEvents.filter((event) => String(event.outcome || '').trim().toLowerCase() === 'error');

  const limitRows = readHarnessUsageLimitHistory({
    from,
    to,
    harness,
    dataDir: input.dataDir,
    limit: 5000,
  });
  /** @type {Record<string, number>} */
  const byDay = {};
  let lastAt = null;
  for (const row of limitRows) {
    const day = String(row.ts || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    byDay[day] = (byDay[day] || 0) + 1;
    if (!lastAt || String(row.ts) > lastAt) lastAt = String(row.ts);
  }

  const daily = enumerateDays(from, to).map((day) => {
    const dayRuns = runEvents.filter((event) => isRunOnDay(event, day));
    return {
      day,
      runs: dayRuns.length,
      errors: dayRuns.filter((event) => String(event.outcome || '').trim().toLowerCase() === 'error').length,
    };
  });

  return {
    harness,
    activeLimit: getHarnessUsageLimit({ harness, dataDir: input.dataDir }),
    planLimits: readHarnessPlanLimits(harness, { dataDir: input.dataDir, now }),
    limitHistory: { count: limitRows.length, lastAt, byDay },
    runs: summary.runs,
    okRuns: summary.okRuns,
    errorRuns: summary.errorRuns,
    limitHits: summary.limitHits,
    successRate: summary.successRate,
    p50LatencyMs: summary.p50LatencyMs,
    p95LatencyMs: summary.p95LatencyMs,
    lastErrors: errorEvents
      .slice()
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, MAX_LAST_ERRORS)
      .map((event) => ({
        ts: event.at,
        errorCode: event.errorCode || null,
        model: event.model || '',
      })),
    daily,
  };
}
