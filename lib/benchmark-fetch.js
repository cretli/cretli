/**
 * Explicit, operator-triggered fetch of Artificial Analysis benchmark data
 * through its official free API (plan v10 §2.5; terms audited 2026-10-14).
 *
 * Guards, all enforced before any network request:
 * - the registry source must allow a manual keyed fetch and be enabled;
 * - an API key must be configured (`x-api-key`, server-side only);
 * - the persisted per-UTC-day request counter must be below the provider limit;
 * - a fresh snapshot (younger than the source TTL) is reused unless `force`.
 *
 * Two persisted per-UTC-day counters (`{ day, count, errors }`):
 * - `count` = attempts reserved against the provider's daily request budget.
 *   The provider counts requests, so a failed attempt still spends budget;
 * - `errors` = attempts that reached the network but failed (`network_error`,
 *   `rate_limited`, `http_error`, `size_exceeded`, `bad_response`,
 *   `empty_response`). It never gates anything; operators read it to see how
 *   much of the budget was wasted.
 *
 * Atomicity limitation: the check-and-spend is synchronous, so it is safe
 * within one process only. There is no cross-process locking; two server
 * processes sharing one data dir could both pass the check.
 *
 * The site itself is never scraped. The key is never logged, never part of a
 * returned error message and never stored in a snapshot.
 */

import fs from 'node:fs';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { resolveDataPath } from './runtime-paths.js';
import { findBuiltinBenchmarkSource } from './benchmark-source-registry.js';
import {
  BENCHMARK_SNAPSHOT_MAX_ENTRIES,
} from './benchmark-snapshot.js';

export const BENCHMARK_FETCH_TIMEOUT_MS = 15_000;
/** Stay below the provider's 1,000/day limit so a manual retry never hits 429. */
export const BENCHMARK_FETCH_DAILY_BUDGET = 900;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * @param {string} [filePath]
 * @returns {string}
 */
function usagePath(filePath) {
  return String(filePath || '').trim() || resolveDataPath('benchmark-fetch-usage.json');
}

/**
 * @param {string} now ISO timestamp
 * @returns {string} UTC day key
 */
function dayKey(now) {
  return String(now).slice(0, 10);
}

/**
 * Requests already spent today for one source.
 *
 * @param {{ sourceId: string, now?: number, usageFile?: string }} input
 * @returns {number}
 */
export function readBenchmarkFetchCount(input) {
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(input.usageFile), 'utf8'));
    const day = dayKey(new Date(input.now ?? Date.now()).toISOString());
    const row = raw && raw[input.sourceId];
    return row && row.day === day && Number.isFinite(Number(row.count)) ? Number(row.count) : 0;
  } catch {
    return 0;
  }
}

/**
 * Attempts that failed after the budget was reserved, today, for one source.
 *
 * @param {{ sourceId: string, now?: number, usageFile?: string }} input
 * @returns {number}
 */
export function readBenchmarkFetchErrors(input) {
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(input.usageFile), 'utf8'));
    const day = dayKey(new Date(input.now ?? Date.now()).toISOString());
    const row = raw && raw[input.sourceId];
    return row && row.day === day && Number.isFinite(Number(row.errors)) ? Number(row.errors) : 0;
  } catch {
    return 0;
  }
}

/**
 * Count one failed attempt without touching the budget counter.
 *
 * @param {{ sourceId: string, now?: number, usageFile?: string }} input
 */
function recordBenchmarkFetchError(input) {
  try {
    const file = usagePath(input.usageFile);
    let doc = {};
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      doc = {};
    }
    const day = dayKey(new Date(input.now ?? Date.now()).toISOString());
    const row = doc[input.sourceId];
    const sameDay = row && row.day === day;
    doc[input.sourceId] = {
      day,
      count: sameDay && Number.isFinite(Number(row.count)) ? Number(row.count) : 0,
      errors: readBenchmarkFetchErrors(input) + 1,
    };
    writeJsonAtomic(file, doc);
  } catch {
    // Diagnostics only; never mask the fetch result.
  }
}

/**
 * Check the daily budget and spend one request in a single synchronous step.
 * There is no await between the read and the write, so concurrent fetches in
 * this process cannot both pass the check and exceed the budget.
 *
 * @param {{ sourceId: string, limit: number, now?: number, usageFile?: string }} input
 * @returns {boolean} true when a request slot was reserved
 */
function reserveBenchmarkFetch(input) {
  const file = usagePath(input.usageFile);
  const count = readBenchmarkFetchCount(input);
  if (count >= input.limit) return false;
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    doc = {};
  }
  const day = dayKey(new Date(input.now ?? Date.now()).toISOString());
  doc[input.sourceId] = { day, count: count + 1, errors: readBenchmarkFetchErrors(input) };
  writeJsonAtomic(file, doc);
  return true;
}

/**
 * Read a response body with a hard byte limit.
 *
 * @param {any} response
 * @returns {Promise<string | null>} null when the body exceeds the cap
 */
async function readCappedBody(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES ? null : text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {unknown} value
 * @returns {number | null} 0..1
 */
function normalizeIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, Number(unit.toFixed(4))));
}

/**
 * Reduce the provider response to bounded snapshot entries.
 *
 * @param {unknown} body
 * @returns {Record<string, any>[]}
 */
export function parseArtificialAnalysisModels(body) {
  const root = /** @type {any} */ (body);
  const rows = Array.isArray(root) ? root : (Array.isArray(root?.data) ? root.data : []);
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = String(row.slug || row.id || row.name || '').trim().toLowerCase();
    if (!key) continue;
    const evals = row.evaluations && typeof row.evaluations === 'object' ? row.evaluations : {};
    const intelligence = normalizeIndex(evals.artificial_analysis_intelligence_index);
    const coding = normalizeIndex(evals.artificial_analysis_coding_index);
    if (intelligence == null && coding == null) continue;
    entries.push({
      modelKey: key,
      mappingDimension: 'base',
      scores: {
        ...(intelligence != null ? { intelligence } : {}),
        ...(coding != null ? { coding } : {}),
      },
    });
    if (entries.length >= BENCHMARK_SNAPSHOT_MAX_ENTRIES) break;
  }
  return entries;
}

/**
 * @param {{
 *   sourceId?: string,
 *   apiKey?: string,
 *   enabled?: boolean,
 *   force?: boolean,
 *   latestCapturedAt?: string | null,
 *   termsRecord?: object | null,
 *   fetchImpl?: typeof fetch,
 *   now?: number,
 *   usageFile?: string,
 * }} input
 * @returns {Promise<{ ok: boolean, code?: string, error?: string, networkAttempted: boolean, importBody?: Record<string, any> }>}
 */
export async function fetchBenchmarkSourceSnapshot(input = {}) {
  const sourceId = String(input.sourceId || 'artificial-analysis').trim();
  const source = findBuiltinBenchmarkSource(sourceId);
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const refuse = (code, error) => ({ ok: false, code, error, networkAttempted: false });
  if (!source) return refuse('source_unknown', 'unknown benchmark source');
  if (source.manualFetchSupported !== true || source.scrapingAllowed !== false) {
    return refuse('fetch_not_supported', 'this source does not allow automated fetching');
  }
  if (input.enabled !== true) return refuse('source_disabled', 'enable the source before fetching');
  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey) return refuse('key_missing', 'an API key is required for this source');
  const ttl = Number(source.cacheTtlMs) || 0;
  const lastMs = Date.parse(String(input.latestCapturedAt || ''));
  if (!input.force && ttl > 0 && Number.isFinite(lastMs) && now - lastMs < ttl) {
    return refuse('cache_fresh', 'a snapshot younger than the cache TTL already exists');
  }
  const limit = Math.min(BENCHMARK_FETCH_DAILY_BUDGET, Number(source.dailyRequestLimit) || BENCHMARK_FETCH_DAILY_BUDGET);
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return refuse('fetch_unavailable', 'fetch is not available');
  if (!reserveBenchmarkFetch({ sourceId, limit, now, usageFile: input.usageFile })) {
    return refuse('daily_limit', 'daily request budget for this source is exhausted');
  }
  const failed = (code, error) => {
    recordBenchmarkFetchError({ sourceId, now, usageFile: input.usageFile });
    return { ok: false, code, error, networkAttempted: true };
  };
  let response;
  try {
    response = await fetchImpl(String(source.apiEndpoint), {
      method: 'GET',
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(BENCHMARK_FETCH_TIMEOUT_MS),
    });
  } catch {
    return failed('network_error', 'request failed');
  }
  if (!response.ok) {
    const code = response.status === 429 ? 'rate_limited' : 'http_error';
    return failed(code, `provider returned HTTP ${response.status}`);
  }
  let body;
  try {
    const text = await readCappedBody(response);
    if (text == null) {
      return failed('size_exceeded', 'response too large');
    }
    body = JSON.parse(text);
  } catch {
    return failed('bad_response', 'response is not valid JSON');
  }
  const entries = parseArtificialAnalysisModels(body);
  if (entries.length === 0) {
    return failed('empty_response', 'no usable benchmark rows');
  }
  return {
    ok: true,
    networkAttempted: true,
    importBody: {
      sourceId,
      capturedAt: new Date(now).toISOString(),
      payload: { entries },
    },
  };
}
