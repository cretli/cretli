/**
 * Records priced usage events and builds summaries.
 */

import {
  commitRunStart,
  commitUsageEvent,
  readUsageEvents,
  readUsageLedgerState,
} from '../persist/usage-persist.js';
import { createUsageEvent, createUsageId, emptyUsageTokens } from './usage-event.js';
import { mapProviderToHarness } from './usage-normalize.js';
import { billedTotalTokens, partitionUsageTokens, resolveAccountingScope } from './usage-contract.js';
import { priceUsage } from './usage-rates.js';
import { formatZoneDay, formatZoneHour, isValidTimeZone, zoneDayStartMs, addZoneDays } from './usage-window.js';

export const USAGE_TIMESERIES_BUCKETS = Object.freeze(['hour', 'day']);
export const USAGE_TIMESERIES_GROUPS = Object.freeze(['model', 'harness', 'feature']);
export const USAGE_TIMESERIES_METRICS = Object.freeze(['usd', 'tokens', 'events', 'runs']);

/**
 * Commit one usage event through the durable, idempotent ledger.
 *
 * Store-only hints (`baselineKey`/`snapshotTokens`/`final`) are read from the
 * incoming partial: they steer the journal read-model (durable snapshot
 * baseline, late coverage correction) without changing the canonical event
 * shape, which keeps `schemaVersion`/`normalizationVersion` stable.
 *
 * @param {object} [partial]
 * @param {{ dataDir?: string, now?: number, persistIndex?: boolean, lock?: boolean }} [ctx]
 * @returns {object}
 */
export function recordUsage(partial = {}, ctx = {}) {
  const priced = priceUsage(createUsageEvent(partial));
  const hints = {
    baselineKey: typeof partial.baselineKey === 'string' && partial.baselineKey.trim()
      ? partial.baselineKey.trim()
      : undefined,
    snapshotTokens:
      partial.snapshotTokens && typeof partial.snapshotTokens === 'object'
        ? partial.snapshotTokens
        : undefined,
    final: partial.final === true,
    correction: partial.correction === true,
    supersedes: partial.supersedes === true,
    legacy: partial.legacy === true,
  };
  commitUsageEvent(priced, ctx, hints);
  return priced;
}

/**
 * Persist a durable run-start before the harness launches. When the transport
 * did not supply a runId, a fresh one is minted and returned so the room can
 * attach it to every following measurement and to the single run-ended event.
 *
 * @param {object} [partial]
 * @param {{ dataDir?: string, now?: number }} [ctx]
 * @returns {{ runId: string, runKey: string|null, status: string }}
 */
export function beginUsageRun(partial = {}, ctx = {}) {
  const runId = String(partial.runId || '').trim() || createUsageId();
  const run = {
    harness: String(partial.harness || '').trim(),
    runId,
    attemptId: partial.attemptId ? String(partial.attemptId).trim() : undefined,
    sourceSessionId: partial.sourceSessionId ? String(partial.sourceSessionId).trim() : undefined,
    chatId: partial.chatId ? String(partial.chatId).trim() : undefined,
    role: partial.role ? String(partial.role).trim() : undefined,
    model: partial.model ? String(partial.model).trim() : undefined,
    contextEpoch: partial.contextEpoch,
    startedAt: partial.at || new Date(ctx.now || Date.now()).toISOString(),
  };
  const result = commitRunStart(run, ctx);
  return { runId: result.runId || runId, runKey: result.runKey || null, status: result.status };
}

/**
 * Ledger writes must never break the user-facing request.
 *
 * @param {object} [partial]
 * @param {{ dataDir?: string }} [ctx]
 * @returns {object|null}
 */
export function safeRecordUsage(partial = {}, ctx = {}) {
  try {
    return recordUsage(partial, ctx);
  } catch (error) {
    console.error('[usage] record failed', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * @param {object} event
 * @returns {boolean}
 */
function isRunEvent(event) {
  return event?.eventType === 'run';
}

/**
 * Old events have no harness; fall back to the provider mapping.
 *
 * @param {object} event
 * @returns {string}
 */
export function resolveUsageHarness(event) {
  const explicit = String(event?.harness || '').trim();
  if (explicit) return explicit;
  return mapProviderToHarness(event?.provider);
}

/**
 * @param {object} event
 * @returns {Record<string, number>}
 */
function readTokens(event) {
  return event?.tokens && typeof event.tokens === 'object' ? event.tokens : {};
}

/**
 * Disjoint total for one event. Uses the versioned contract so stored cache and
 * reasoning are never counted twice: `textInput` is uncached input,
 * `textOutput` excludes reasoning when reasoning is a subset, and diagnostic
 * (unknown-relation) reasoning stays out of the additive total.
 *
 * @param {Record<string, number>} tokens
 * @param {string} [harness]
 * @returns {number}
 */
function totalTokens(tokens, harness) {
  return billedTotalTokens(tokens || {}, harness);
}

/**
 * Adds one event's tokens to a bucket as disjoint contract buckets.
 *
 * @param {Record<string, number>} target
 * @param {Record<string, number>} tokens
 * @param {string} harness
 * @returns {void}
 */
function addDisjointTokens(target, tokens, harness) {
  const buckets = partitionUsageTokens(tokens || {}, harness);
  target.textInput += buckets.inputWithoutCache;
  target.textOutput += buckets.outputWithoutReasoning;
  target.cachedInput += buckets.cacheRead;
  target.cacheWrite += buckets.cacheWrite;
  // Diagnostic reasoning is a subcounter already inside textOutput; adding it
  // again would double count the aggregate.
  if (!buckets.reasoningDiagnostic) target.reasoning += buckets.reasoning;
  target.audioInput += buckets.audioInput;
  target.audioOutput += buckets.audioOutput;
}

/**
 * Nearest-rank percentile over an ascending list.
 *
 * @param {number[]} sorted
 * @param {number} percent
 * @returns {number|null}
 */
function percentile(sorted, percent) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const rank = Math.ceil((percent / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * Collects one latency sample per group key while the main loop runs.
 *
 * @param {Map<string, number[]>} map
 * @param {string} key
 * @param {number} value
 * @returns {void}
 */
function pushGroupLatency(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/**
 * Writes p50/p95 onto every group row (null when the group has no run samples).
 *
 * @param {Record<string, object>} groups
 * @param {Map<string, number[]>} latenciesByKey
 * @returns {void}
 */
function finalizeGroupLatencies(groups, latenciesByKey) {
  for (const [key, row] of Object.entries(groups || {})) {
    const values = latenciesByKey.get(key);
    if (Array.isArray(values) && values.length > 0) {
      const sorted = [...values].sort((a, b) => a - b);
      row.p50LatencyMs = percentile(sorted, 50);
      row.p95LatencyMs = percentile(sorted, 95);
    } else {
      row.p50LatencyMs = null;
      row.p95LatencyMs = null;
    }
  }
}

/**
 * Harness ids ordered by event count (descending) with an alphabetical tie-break.
 *
 * @param {Map<string, number>|undefined} counts
 * @returns {string[]}
 */
function rankHarnesses(counts) {
  if (!counts) return [];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([harness]) => harness);
}

/**
 * @param {object[]} events
 * @returns {object}
 */
export function summarizeUsage(events) {
  const summary = {
    // `own` and `consolidated` are alternative accounting scopes, never
    // additive sets. The top-level scalar fields stay the `own` view for
    // compatibility; the `*ByScope` subtotals below carry both scopes and
    // `mixed` states explicitly that a reader must not add them together.
    totalUsd: 0,
    estimatedUsd: 0,
    unpricedEvents: 0,
    tokens: emptyUsageTokens(),
    tokensByScope: {
      own: emptyUsageTokens(),
      consolidated: emptyUsageTokens(),
    },
    usdByScope: { own: 0, consolidated: 0 },
    estimatedUsdByScope: { own: 0, consolidated: 0 },
    eventsByScope: { own: 0, consolidated: 0 },
    mixed: false,
    runs: 0,
    okRuns: 0,
    errorRuns: 0,
    abortedRuns: 0,
    limitHits: 0,
    successRate: null,
    errorRate: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    byProvider: {},
    byFeature: {},
    byDay: {},
    byHarness: {},
    byModel: {},
    byRole: {},
  };
  const list = Array.isArray(events) ? events : [];
  const latencies = [];
  /** @type {Record<string, Map<string, number[]>>} */
  const groupLatencies = {
    byProvider: new Map(),
    byFeature: new Map(),
    byDay: new Map(),
    byHarness: new Map(),
    byModel: new Map(),
    byRole: new Map(),
  };
  /** @type {Map<string, Map<string, number>>} */
  const modelHarnessCounts = new Map();
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const run = isRunEvent(event);
    const provider = String(event.provider || 'other');
    const feature = String(event.feature || 'other');
    const day = String(event.at || '').slice(0, 10) || 'unknown';
    const harness = resolveUsageHarness(event);
    const model = String(event.model || '').trim() || 'unknown';
    const role = String(event.role || '').trim() || 'unknown';
    const scope = resolveAccountingScope(event);
    let latency = null;
    if (run) {
      summary.runs += 1;
      const outcome = String(event.outcome || '').trim().toLowerCase();
      if (outcome === 'ok') summary.okRuns += 1;
      else if (outcome === 'limit') summary.limitHits += 1;
      else if (outcome === 'aborted') summary.abortedRuns += 1;
      else if (outcome === 'error') summary.errorRuns += 1;
      const value = Number(event.latencyMs);
      if (Number.isFinite(value) && value >= 0) {
        latencies.push(value);
        latency = value;
      }
    } else {
      // Run events carry no tokens/usd, so they must not be summed here.
      // Estimated rate-table USD is kept apart from actual/metered USD, and
      // both stay inside their accounting scope: a consolidated (child) event
      // never lands in the `own` top-level totals.
      if (Number.isFinite(event.usd)) {
        if (event.estimated) {
          summary.estimatedUsdByScope[scope] += event.usd;
          if (scope === 'own') summary.estimatedUsd += event.usd;
        } else {
          summary.usdByScope[scope] += event.usd;
          if (scope === 'own') summary.totalUsd += event.usd;
        }
      } else if (scope === 'own') {
        summary.unpricedEvents += 1;
      }
      summary.eventsByScope[scope] += 1;
      addDisjointTokens(summary.tokensByScope[scope], readTokens(event), harness);
    }
    if (!modelHarnessCounts.has(model)) modelHarnessCounts.set(model, new Map());
    const harnessCounts = modelHarnessCounts.get(model);
    harnessCounts.set(harness, (harnessCounts.get(harness) || 0) + 1);
    addGroup(summary.byProvider, provider, event, run, harness);
    addGroup(summary.byFeature, feature, event, run, harness);
    addGroup(summary.byDay, day, event, run, harness);
    addGroup(summary.byHarness, harness, event, run, harness);
    addGroup(summary.byModel, model, event, run, harness);
    addGroup(summary.byRole, role, event, run, harness);
    if (latency != null) {
      pushGroupLatency(groupLatencies.byProvider, provider, latency);
      pushGroupLatency(groupLatencies.byFeature, feature, latency);
      pushGroupLatency(groupLatencies.byDay, day, latency);
      pushGroupLatency(groupLatencies.byHarness, harness, latency);
      pushGroupLatency(groupLatencies.byModel, model, latency);
      pushGroupLatency(groupLatencies.byRole, role, latency);
    }
  }
  // The top-level `tokens` view is `own`; consolidated tokens are only
  // reachable through `tokensByScope` so they cannot be added silently.
  summary.tokens = summary.tokensByScope.own;
  summary.mixed =
    summary.eventsByScope.own > 0 && summary.eventsByScope.consolidated > 0;
  summary.totalUsd = Number(summary.totalUsd.toFixed(6));
  summary.estimatedUsd = Number(summary.estimatedUsd.toFixed(6));
  summary.usdByScope.own = Number(summary.usdByScope.own.toFixed(6));
  summary.usdByScope.consolidated = Number(summary.usdByScope.consolidated.toFixed(6));
  summary.estimatedUsdByScope.own = Number(summary.estimatedUsdByScope.own.toFixed(6));
  summary.estimatedUsdByScope.consolidated = Number(
    summary.estimatedUsdByScope.consolidated.toFixed(6)
  );
  summary.successRate = summary.runs > 0 ? Number((summary.okRuns / summary.runs).toFixed(4)) : null;
  summary.errorRate = summary.runs > 0 ? Number((summary.errorRuns / summary.runs).toFixed(4)) : null;
  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    summary.p50LatencyMs = percentile(latencies, 50);
    summary.p95LatencyMs = percentile(latencies, 95);
  }
  for (const [name, buckets] of Object.entries(groupLatencies)) {
    finalizeGroupLatencies(summary[name], buckets);
  }
  // A harness row knows its own id; a model row records its dominant harness
  // (plus the full ranked list) so the UI can explain subscription pricing.
  for (const [harness, row] of Object.entries(summary.byHarness)) {
    row.harness = harness;
  }
  for (const [model, row] of Object.entries(summary.byModel)) {
    const ranked = rankHarnesses(modelHarnessCounts.get(model));
    row.harness = ranked[0] || null;
    row.harnesses = ranked;
  }
  return summary;
}

/**
 * @param {Record<string, object>} groups
 * @param {string} key
 * @param {object} event
 * @param {boolean} run
 * @param {string} harness
 * @returns {void}
 */
function addGroup(groups, key, event, run, harness) {
  if (!groups[key]) {
    groups[key] = {
      usd: 0,
      estimatedUsd: 0,
      unpricedEvents: 0,
      tokens: emptyUsageTokens(),
      events: 0,
      runs: 0,
      okRuns: 0,
      errorRuns: 0,
      limitHits: 0,
      p50LatencyMs: null,
      p95LatencyMs: null,
      // Scope subtotals: the scalar fields above are the `own` view, the
      // `*ByScope` fields carry both scopes, and `mixed` forbids adding them.
      tokensByScope: {
        own: emptyUsageTokens(),
        consolidated: emptyUsageTokens(),
      },
      usdByScope: { own: 0, consolidated: 0 },
      estimatedUsdByScope: { own: 0, consolidated: 0 },
      eventsByScope: { own: 0, consolidated: 0 },
      mixed: false,
    };
  }
  const row = groups[key];
  if (run) {
    row.runs += 1;
    const outcome = String(event.outcome || '').trim().toLowerCase();
    if (outcome === 'ok') row.okRuns += 1;
    else if (outcome === 'limit') row.limitHits += 1;
    else if (outcome === 'error') row.errorRuns += 1;
    return;
  }
  const scope = resolveAccountingScope(event);
  row.eventsByScope[scope] += 1;
  if (scope === 'own') row.events += 1;
  if (Number.isFinite(event.usd)) {
    if (event.estimated) {
      row.estimatedUsdByScope[scope] += event.usd;
      if (scope === 'own') row.estimatedUsd += event.usd;
    } else {
      row.usdByScope[scope] += event.usd;
      if (scope === 'own') row.usd += event.usd;
    }
  } else if (scope === 'own') {
    row.unpricedEvents += 1;
  }
  addDisjointTokens(row.tokensByScope[scope], readTokens(event), harness);
  row.tokens = row.tokensByScope.own;
  row.mixed = row.eventsByScope.own > 0 && row.eventsByScope.consolidated > 0;
  row.usd = Number(row.usd.toFixed(6));
  row.estimatedUsd = Number(row.estimatedUsd.toFixed(6));
  row.usdByScope.own = Number(row.usdByScope.own.toFixed(6));
  row.usdByScope.consolidated = Number(row.usdByScope.consolidated.toFixed(6));
  row.estimatedUsdByScope.own = Number(row.estimatedUsdByScope.own.toFixed(6));
  row.estimatedUsdByScope.consolidated = Number(
    row.estimatedUsdByScope.consolidated.toFixed(6)
  );
}

/**
 * @param {{ from?: string, to?: string, dataDir?: string }} [query]
 * @returns {object}
 */
export function loadUsageSummary(query = {}) {
  const summary = summarizeUsage(readUsageEvents(query));
  // Active (run-start persisted, not yet ended) and ended runs are separate
  // metrics: a late measurement never moves a run from one to the other.
  try {
    const ledger = readUsageLedgerState(query);
    summary.runLifecycle = { active: ledger.activeRuns, ended: ledger.endedRuns };
    summary.ledger = {
      lastSeq: ledger.lastSeq,
      keyCount: ledger.keyCount,
      baselineCount: ledger.baselineCount,
      correctionCount: ledger.correctionCount,
      supersededKeyCount: ledger.supersededKeyCount,
      activeRuns: ledger.activeRuns,
      endedRuns: ledger.endedRuns,
      diagnostics: ledger.diagnostics,
      retention: ledger.retention,
    };
  } catch (error) {
    summary.runLifecycle = { active: null, ended: null };
    summary.ledger = { error: error instanceof Error ? error.message : String(error) };
  }
  return summary;
}

/**
 * Buckets events by hour/day and one grouping dimension.
 *
 * When `from`/`to` (ISO days) are provided the bucket axis is completed with
 * zero-value buckets, so a gap between two active days does not collapse the
 * time axis.
 *
 * @param {object[]} events
 * @param {{ bucket?: 'hour'|'day', groupBy?: 'model'|'harness'|'feature', metric?: 'usd'|'tokens'|'events'|'runs', from?: string, to?: string, scope?: 'own'|'consolidated' }} [options]
 * @returns {{ bucket: string, groupBy: string, metric: string, scope: string, buckets: string[], series: Array<{ group: string, values: number[] }> }}
 */
export function summarizeUsageTimeseries(events, options = {}) {
  const bucket = options.bucket === 'hour' ? 'hour' : 'day';
  const groupBy = USAGE_TIMESERIES_GROUPS.includes(options.groupBy) ? options.groupBy : 'model';
  const metric = USAGE_TIMESERIES_METRICS.includes(options.metric) ? options.metric : 'usd';
  // Token/usd/event series belong to exactly one accounting scope; `own` and
  // `consolidated` are never mixed into one point. `runs` stays scope-agnostic
  // because a late child measurement never changes the run count.
  const scope = options.scope === 'consolidated' ? 'consolidated' : 'own';
  const from = normalizeTimeseriesDay(options.from);
  const to = normalizeTimeseriesDay(options.to);
  // An explicit IANA zone groups buckets by the caller's calendar; without it
  // the historical UTC-day axis is unchanged.
  const tz = isValidTimeZone(options.tz) ? String(options.tz) : '';
  const fromMs = Number(options.fromMs);
  const toMs = Number(options.toMs);
  const list = Array.isArray(events) ? events : [];
  /** @type {Map<string, Map<string, number>>} */
  const points = new Map();
  const bucketKeys = new Set();
  const groupKeys = new Set();
  // First pass keeps every bucket/group visible so chart series stay aligned
  // even on days where the requested metric has no value.
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const at = timeseriesBucketKey(event.at, bucket, tz);
    if (!at) continue;
    // For a scoped metric, a group that only exists in the other scope must not
    // appear as an all-zero series in this one.
    if (metric !== 'runs' && resolveAccountingScope(event) !== scope) continue;
    bucketKeys.add(at);
    groupKeys.add(timeseriesGroup(event, groupBy));
  }
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
    for (const key of enumerateZoneBuckets(fromMs, toMs, bucket, tz)) bucketKeys.add(key);
  } else if (from && to && from <= to) {
    for (const key of enumerateTimeseriesBuckets(from, to, bucket)) bucketKeys.add(key);
  }
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const run = isRunEvent(event);
    // `runs` counts only run events; every other metric mirrors summary and
    // ignores run events entirely (previously `events` double-counted them).
    if (metric === 'runs' ? !run : run) continue;
    if (metric !== 'runs' && resolveAccountingScope(event) !== scope) continue;
    const at = timeseriesBucketKey(event.at, bucket, tz);
    if (!at) continue;
    const group = timeseriesGroup(event, groupBy);
    let value = 1;
    if (metric === 'usd') value = Number.isFinite(event.usd) && !event.estimated ? event.usd : 0;
    else if (metric === 'tokens') value = totalTokens(readTokens(event), resolveUsageHarness(event));
    if (!points.has(at)) points.set(at, new Map());
    const byGroup = points.get(at);
    byGroup.set(group, (byGroup.get(group) || 0) + value);
  }
  const buckets = [...bucketKeys].sort();
  const series = [...groupKeys].sort().map((group) => ({
    group,
    values: buckets.map((at) => roundTimeseriesValue(points.get(at)?.get(group) || 0, metric)),
  }));
  return { bucket, groupBy, metric, scope, tz: tz || 'UTC', buckets, series };
}

/**
 * Explicit zone bucket axis between two instants. DST is handled by the real
 * hour step plus de-duplication; the day axis uses calendar-day addition.
 *
 * @param {number} fromMs
 * @param {number} toMs
 * @param {'hour'|'day'} bucket
 * @param {string} tz
 * @returns {string[]}
 */
function enumerateZoneBuckets(fromMs, toMs, bucket, tz) {
  const keys = [];
  if (!tz) return enumerateTimeseriesBuckets(
    new Date(fromMs).toISOString().slice(0, 10),
    new Date(toMs - 1).toISOString().slice(0, 10),
    bucket
  );
  if (bucket === 'day') {
    let cursor = zoneDayStartMs(fromMs, tz);
    let guard = 0;
    while (cursor < toMs && guard < MAX_TIMESERIES_BUCKETS) {
      keys.push(formatZoneDay(cursor, tz));
      cursor = addZoneDays(cursor, 1, tz);
      guard += 1;
    }
    return keys;
  }
  let cursor = zoneDayStartMs(fromMs, tz);
  let guard = 0;
  while (cursor < toMs && guard < MAX_TIMESERIES_BUCKETS) {
    keys.push(formatZoneHour(cursor, tz));
    cursor += 3_600_000;
    guard += 1;
  }
  return [...new Set(keys)];
}

/** Hard cap that still covers the 92-day API range at hourly resolution. */
const MAX_TIMESERIES_BUCKETS = 92 * 24;

/**
 * @param {unknown} value
 * @returns {string} ISO day or ''
 */
function normalizeTimeseriesDay(value) {
  const day = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

/**
 * Every day between `from` and `to`, or every hour for hourly buckets.
 *
 * @param {string} from
 * @param {string} to
 * @param {'hour'|'day'} bucket
 * @returns {string[]}
 */
function enumerateTimeseriesBuckets(from, to, bucket) {
  const keys = [];
  if (bucket === 'hour') {
    const cursor = new Date(`${from}T00:00:00.000Z`);
    const last = new Date(`${to}T23:00:00.000Z`);
    while (cursor <= last && keys.length < MAX_TIMESERIES_BUCKETS) {
      keys.push(cursor.toISOString());
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    }
    return keys;
  }
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= last && keys.length < MAX_TIMESERIES_BUCKETS) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

/**
 * @param {unknown} at
 * @param {'hour'|'day'} bucket
 * @param {string} [tz] IANA zone; empty keeps the historical UTC axis
 * @returns {string}
 */
function timeseriesBucketKey(at, bucket, tz = '') {
  if (tz) {
    const ms = Date.parse(String(at || ''));
    if (!Number.isFinite(ms)) return '';
    return bucket === 'hour' ? formatZoneHour(ms, tz) : formatZoneDay(ms, tz);
  }
  const iso = String(at || '');
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  if (bucket === 'hour') {
    const hour = iso.slice(11, 13);
    return /^\d{2}$/.test(hour) ? `${day}T${hour}:00:00.000Z` : `${day}T00:00:00.000Z`;
  }
  return day;
}

/**
 * @param {object} event
 * @param {'model'|'harness'|'feature'} groupBy
 * @returns {string}
 */
function timeseriesGroup(event, groupBy) {
  if (groupBy === 'harness') return resolveUsageHarness(event);
  if (groupBy === 'feature') return String(event.feature || 'other');
  return String(event.model || '').trim() || 'unknown';
}

/**
 * @param {number} value
 * @param {'usd'|'tokens'|'events'|'runs'} metric
 * @returns {number}
 */
function roundTimeseriesValue(value, metric) {
  if (metric === 'usd') return Number(value.toFixed(6));
  return Math.round(value);
}
