/**
 * Records priced usage events and builds summaries.
 */

import { appendUsageEvent, readUsageEvents } from '../persist/usage-persist.js';
import { createUsageEvent, emptyUsageTokens } from './usage-event.js';
import { mapProviderToHarness } from './usage-normalize.js';
import { priceUsage } from './usage-rates.js';

export const USAGE_TIMESERIES_BUCKETS = Object.freeze(['hour', 'day']);
export const USAGE_TIMESERIES_GROUPS = Object.freeze(['model', 'harness', 'feature']);
export const USAGE_TIMESERIES_METRICS = Object.freeze(['usd', 'tokens', 'events', 'runs']);

/**
 * @param {object} [partial]
 * @param {{ dataDir?: string }} [ctx]
 * @returns {object}
 */
export function recordUsage(partial = {}, ctx = {}) {
  const priced = priceUsage(createUsageEvent(partial));
  appendUsageEvent(priced, ctx);
  return priced;
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
 * @param {Record<string, number>} tokens
 * @returns {number}
 */
function totalTokens(tokens) {
  let sum = 0;
  for (const value of Object.values(tokens || {})) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) sum += count;
  }
  return sum;
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
    totalUsd: 0,
    estimatedUsd: 0,
    unpricedEvents: 0,
    tokens: emptyUsageTokens(),
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
      // Estimated rate-table USD is kept apart from actual/metered USD.
      if (Number.isFinite(event.usd)) {
        if (event.estimated) summary.estimatedUsd += event.usd;
        else summary.totalUsd += event.usd;
      } else {
        summary.unpricedEvents += 1;
      }
      const tokens = readTokens(event);
      for (const key of Object.keys(summary.tokens)) {
        summary.tokens[key] += Number(tokens[key]) > 0 ? Number(tokens[key]) : 0;
      }
    }
    const provider = String(event.provider || 'other');
    const feature = String(event.feature || 'other');
    const day = String(event.at || '').slice(0, 10) || 'unknown';
    const harness = resolveUsageHarness(event);
    const model = String(event.model || '').trim() || 'unknown';
    const role = String(event.role || '').trim() || 'unknown';
    if (!modelHarnessCounts.has(model)) modelHarnessCounts.set(model, new Map());
    const harnessCounts = modelHarnessCounts.get(model);
    harnessCounts.set(harness, (harnessCounts.get(harness) || 0) + 1);
    addGroup(summary.byProvider, provider, event, run);
    addGroup(summary.byFeature, feature, event, run);
    addGroup(summary.byDay, day, event, run);
    addGroup(summary.byHarness, harness, event, run);
    addGroup(summary.byModel, model, event, run);
    addGroup(summary.byRole, role, event, run);
    if (latency != null) {
      pushGroupLatency(groupLatencies.byProvider, provider, latency);
      pushGroupLatency(groupLatencies.byFeature, feature, latency);
      pushGroupLatency(groupLatencies.byDay, day, latency);
      pushGroupLatency(groupLatencies.byHarness, harness, latency);
      pushGroupLatency(groupLatencies.byModel, model, latency);
      pushGroupLatency(groupLatencies.byRole, role, latency);
    }
  }
  summary.totalUsd = Number(summary.totalUsd.toFixed(6));
  summary.estimatedUsd = Number(summary.estimatedUsd.toFixed(6));
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
 * @returns {void}
 */
function addGroup(groups, key, event, run) {
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
  row.events += 1;
  if (Number.isFinite(event.usd)) {
    if (event.estimated) row.estimatedUsd += event.usd;
    else row.usd += event.usd;
  } else {
    row.unpricedEvents += 1;
  }
  const tokens = readTokens(event);
  for (const name of Object.keys(row.tokens)) {
    row.tokens[name] += Number(tokens[name]) > 0 ? Number(tokens[name]) : 0;
  }
  row.usd = Number(row.usd.toFixed(6));
  row.estimatedUsd = Number(row.estimatedUsd.toFixed(6));
}

/**
 * @param {{ from?: string, to?: string, dataDir?: string }} [query]
 * @returns {object}
 */
export function loadUsageSummary(query = {}) {
  return summarizeUsage(readUsageEvents(query));
}

/**
 * Buckets events by hour/day and one grouping dimension.
 *
 * When `from`/`to` (ISO days) are provided the bucket axis is completed with
 * zero-value buckets, so a gap between two active days does not collapse the
 * time axis.
 *
 * @param {object[]} events
 * @param {{ bucket?: 'hour'|'day', groupBy?: 'model'|'harness'|'feature', metric?: 'usd'|'tokens'|'events'|'runs', from?: string, to?: string }} [options]
 * @returns {{ bucket: string, groupBy: string, metric: string, buckets: string[], series: Array<{ group: string, values: number[] }> }}
 */
export function summarizeUsageTimeseries(events, options = {}) {
  const bucket = options.bucket === 'hour' ? 'hour' : 'day';
  const groupBy = USAGE_TIMESERIES_GROUPS.includes(options.groupBy) ? options.groupBy : 'model';
  const metric = USAGE_TIMESERIES_METRICS.includes(options.metric) ? options.metric : 'usd';
  const from = normalizeTimeseriesDay(options.from);
  const to = normalizeTimeseriesDay(options.to);
  const list = Array.isArray(events) ? events : [];
  /** @type {Map<string, Map<string, number>>} */
  const points = new Map();
  const bucketKeys = new Set();
  const groupKeys = new Set();
  // First pass keeps every bucket/group visible so chart series stay aligned
  // even on days where the requested metric has no value.
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const at = timeseriesBucketKey(event.at, bucket);
    if (!at) continue;
    bucketKeys.add(at);
    groupKeys.add(timeseriesGroup(event, groupBy));
  }
  if (from && to && from <= to) {
    for (const key of enumerateTimeseriesBuckets(from, to, bucket)) bucketKeys.add(key);
  }
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const run = isRunEvent(event);
    // `runs` counts only run events; every other metric mirrors summary and
    // ignores run events entirely (previously `events` double-counted them).
    if (metric === 'runs' ? !run : run) continue;
    const at = timeseriesBucketKey(event.at, bucket);
    if (!at) continue;
    const group = timeseriesGroup(event, groupBy);
    let value = 1;
    if (metric === 'usd') value = Number.isFinite(event.usd) && !event.estimated ? event.usd : 0;
    else if (metric === 'tokens') value = totalTokens(readTokens(event));
    if (!points.has(at)) points.set(at, new Map());
    const byGroup = points.get(at);
    byGroup.set(group, (byGroup.get(group) || 0) + value);
  }
  const buckets = [...bucketKeys].sort();
  const series = [...groupKeys].sort().map((group) => ({
    group,
    values: buckets.map((at) => roundTimeseriesValue(points.get(at)?.get(group) || 0, metric)),
  }));
  return { bucket, groupBy, metric, buckets, series };
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
 * @returns {string}
 */
function timeseriesBucketKey(at, bucket) {
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
