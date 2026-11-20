/**
 * Shared helpers for the performance-budget tests (tests/perf-budget-*.test.js).
 *
 * Everything here is synthetic: fixed seed, temp-dir fixtures, never `data/`.
 * Timing rules: median of RUNS runs per metric, event loop delay sampled at
 * 1 ms (CRETLI_BASELINE_ELD_RESOLUTION_MS, docs/storage-gates.md "Event loop").
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const PERF_SEED = 20261030;
export const RUNS = 3;
export const BASELINE_MARGIN = 0.2;
export const baselinePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'perf-budgets-baseline.json',
);

/** Absolute ceilings (sanity limits of the performance plan; never loosened without a decision). */
export const CEILINGS = Object.freeze({
  'chat-list-page-50': { p95Ms: 500 },
  'chat-metadata-write': { p95Ms: 1000 },
});

/** @returns {number} Event loop sampling resolution in ms; coarser than 1 ms makes a run invalid. */
export function eventLoopResolutionMs() {
  const value = Number.parseInt(process.env.CRETLI_BASELINE_ELD_RESOLUTION_MS || '1', 10) || 1;
  if (value > 1) throw new Error(`CRETLI_BASELINE_ELD_RESOLUTION_MS=${value}: event loop numbers need 1 ms resolution`);
  return value;
}

/** @param {number} seed @returns {() => number} mulberry32 PRNG in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number[]} samples @param {number} q @returns {number} nearest-rank quantile. */
export function quantile(samples, q) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

/** @param {number[]} samples @returns {{ n: number, p50Ms: number, p95Ms: number, p99Ms: number }} */
export function summarize(samples) {
  const round = (v) => Math.round(v * 100) / 100;
  return {
    n: samples.length,
    p50Ms: round(quantile(samples, 0.5)),
    p95Ms: round(quantile(samples, 0.95)),
    p99Ms: round(quantile(samples, 0.99)),
  };
}

/** @param {number[]} values @returns {number} median. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Run `measureOnce` RUNS times and take the per-quantile median across runs.
 *
 * @param {() => Promise<number[]> | number[]} measureOnce returns the samples (ms) of one run
 * @returns {Promise<{ n: number, runs: number, p50Ms: number, p95Ms: number, p99Ms: number }>}
 */
export async function medianOfRuns(measureOnce) {
  const perRun = [];
  for (let i = 0; i < RUNS; i += 1) perRun.push(summarize(await measureOnce()));
  return {
    n: perRun[0].n,
    runs: RUNS,
    p50Ms: median(perRun.map((r) => r.p50Ms)),
    p95Ms: median(perRun.map((r) => r.p95Ms)),
    p99Ms: median(perRun.map((r) => r.p99Ms)),
  };
}

/**
 * Event loop delay monitor at the mandated resolution.
 *
 * @returns {{ stop: () => { monitorResolutionMs: number, p99Ms: number, maxMs: number } }}
 */
export function startEventLoopMonitor() {
  const resolution = eventLoopResolutionMs();
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();
  return {
    stop() {
      histogram.disable();
      return {
        monitorResolutionMs: resolution,
        p99Ms: Math.round(histogram.percentile(99) / 1e4) / 100,
        maxMs: Math.round(histogram.max / 1e4) / 100,
      };
    },
  };
}

/**
 * Baseline schema (docs/perf-budgets-baseline.json):
 * { schemaVersion: 1, description, schema: {...}, entries: [Entry] }
 * Entry = { operation, backend, chats, seed, node, samples, p50Ms, p95Ms, p99Ms,
 *           bytesWritten?, eventLoopResolutionMs, capturedAt }
 *
 * @param {unknown} entry
 * @returns {string[]} schema problems (empty when valid)
 */
export function validateBaselineEntry(entry) {
  const problems = [];
  const e = /** @type {Record<string, any>} */ (entry || {});
  for (const key of ['operation', 'backend', 'node', 'capturedAt']) {
    if (typeof e[key] !== 'string' || !e[key]) problems.push(`${key} must be a non-empty string`);
  }
  for (const key of ['chats', 'seed', 'samples', 'p50Ms', 'p95Ms', 'p99Ms', 'eventLoopResolutionMs']) {
    if (typeof e[key] !== 'number' || !Number.isFinite(e[key]) || e[key] < 0) problems.push(`${key} must be a non-negative number`);
  }
  if (e.bytesWritten !== undefined && (typeof e.bytesWritten !== 'number' || e.bytesWritten < 0)) {
    problems.push('bytesWritten must be a non-negative number when present');
  }
  if (e.eventLoopResolutionMs > 1) problems.push('eventLoopResolutionMs must be <= 1 (docs/storage-gates.md)');
  if (!(e.p50Ms <= e.p95Ms && e.p95Ms <= e.p99Ms)) problems.push('quantiles must satisfy p50 <= p95 <= p99');
  return problems;
}

/** @returns {{ entries: Record<string, any>[] }} parsed baseline file (throws when missing). */
export function readBaseline() {
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

/**
 * Threshold for a metric: min(baseline * (1 + margin), absolute ceiling).
 *
 * @param {number} baselineMs
 * @param {number} ceilingMs
 * @returns {number}
 */
export function thresholdMs(baselineMs, ceilingMs) {
  return Math.min(baselineMs * (1 + BASELINE_MARGIN), ceilingMs);
}

/**
 * Merge freshly measured entries into the baseline file (CRETLI_PERF_BASELINE_WRITE=1 only).
 *
 * @param {Record<string, any>} entry
 * @param {Record<string, any>} header schema/description written when the file is created
 */
export function writeBaselineEntry(entry, header) {
  let doc = { ...header, entries: [] };
  try { doc = { ...JSON.parse(fs.readFileSync(baselinePath, 'utf8')) }; } catch { /* first write */ }
  doc.entries = (doc.entries || []).filter((e) => !(e.operation === entry.operation && e.backend === entry.backend && e.chats === entry.chats));
  doc.entries.push(entry);
  fs.writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`);
}
