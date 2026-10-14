/**
 * Shadow-only benchmark signal for `model_pick` (plan v10 §2.5, leaf L5).
 *
 * `benchmark_score` is a 0..1 value per role derived from imported snapshots of
 * licence-cleared sources only (`allowed_api_only` in the registry). It is
 * shrunk toward the neutral 0.5, weighted by `benchmarkWeight` (0.1), and the
 * weight drops to 0 when the snapshot is older than the source TTL. Missing,
 * unmapped or stale data is neutral (no contribution).
 *
 * The block is reported in the shadow explanation and the decision journal. It
 * is never an input to the selection and does not reorder `shadow_top`.
 */

import { resolveModelIdentity } from './model-facts/identity.js';
import { computeSnapshotFreshness } from './benchmark-snapshot.js';
import {
  findBuiltinBenchmarkSource,
  isBenchmarkSourceUsableForShadow,
} from './benchmark-source-registry.js';

export const BENCHMARK_SHADOW_SCHEMA_VERSION = 'model-pick-benchmark-2026-10-14';
export const BENCHMARK_WEIGHT = 0.1;
/** Fraction of the distance from neutral that survives shrinkage. */
export const BENCHMARK_SHRINKAGE = 0.6;
export const BENCHMARK_NEUTRAL = 0.5;
/** Per-role metric used from a snapshot entry's `scores` object. */
export const BENCHMARK_ROLE_METRIC = Object.freeze({
  implement: 'coding',
  fix: 'coding',
  review: 'intelligence',
  plan: 'intelligence',
});
export const BENCHMARK_STATUSES = Object.freeze(['ok', 'stale', 'missing', 'unmapped', 'no_source']);

const MAX_CANDIDATES = 12;

/**
 * @param {unknown} value
 * @returns {string}
 */
function key(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Newest usable snapshot per licence-cleared, enabled source.
 *
 * @param {{
 *   snapshots?: object[],
 *   sourcePreferences?: Record<string, { enabled?: boolean }>,
 *   now?: number,
 * }} input
 * @returns {Array<{ sourceId: string, capturedAt: string, stale: boolean, ageMs: number, ttlMs: number, attribution: string, entries: Map<string, object> }>}
 */
export function buildBenchmarkShadowIndex(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const prefs = input.sourcePreferences && typeof input.sourcePreferences === 'object' ? input.sourcePreferences : {};
  const latest = new Map();
  for (const snap of Array.isArray(input.snapshots) ? input.snapshots : []) {
    const sourceId = String(snap?.sourceId || '').trim();
    const source = findBuiltinBenchmarkSource(sourceId);
    if (!source || !isBenchmarkSourceUsableForShadow(source)) continue;
    const enabled = typeof prefs[sourceId]?.enabled === 'boolean' ? prefs[sourceId].enabled : source.defaultEnabled;
    if (!enabled || snap.kind === 'fixture') continue;
    const prev = latest.get(sourceId);
    if (!prev || String(snap.capturedAt || '') > String(prev.capturedAt || '')) latest.set(sourceId, snap);
  }
  return [...latest.entries()].map(([sourceId, snap]) => {
    const source = findBuiltinBenchmarkSource(sourceId);
    const ttlMs = Number(source.cacheTtlMs) || 0;
    const freshness = computeSnapshotFreshness(String(snap.capturedAt || ''), ttlMs, now);
    const entries = new Map();
    for (const entry of Array.isArray(snap.payload?.entries) ? snap.payload.entries : []) {
      const modelKey = key(entry?.modelKey);
      if (modelKey && !entries.has(modelKey)) entries.set(modelKey, entry);
    }
    return {
      sourceId,
      capturedAt: String(snap.capturedAt || ''),
      stale: freshness.stale,
      ageMs: freshness.ageMs,
      ttlMs,
      attribution: String(source.attribution || ''),
      entries,
    };
  });
}

/**
 * @param {number} raw 0..1
 * @returns {number}
 */
export function shrinkBenchmarkScore(raw) {
  const clamped = Math.max(0, Math.min(1, raw));
  return Number((BENCHMARK_NEUTRAL + (clamped - BENCHMARK_NEUTRAL) * BENCHMARK_SHRINKAGE).toFixed(4));
}

/**
 * Score one candidate. Identity is an exact lookup: the registry-declared
 * external model id first, then the candidate's own model id, compared as
 * trimmed lower-case strings. No prefix, substring or family matching.
 *
 * @param {{ candidate: object, role: string, index: ReturnType<typeof buildBenchmarkShadowIndex>, identityOf?: Function }} input
 * @returns {object}
 */
export function scoreCandidateBenchmark(input) {
  const candidate = input.candidate || {};
  const harness = key(candidate.harness);
  const model = key(candidate.model);
  const candidateId = harness && model ? `${harness}/${model}` : '';
  const role = key(input.role);
  const metric = BENCHMARK_ROLE_METRIC[role] || null;
  const base = {
    candidateId,
    metric,
    benchmark_score: null,
    raw_score: null,
    weight: 0,
    contribution: 0,
    source: null,
    captured_at: null,
    matched_by: null,
    stale: false,
  };
  if (!candidateId || !metric) return { ...base, status: 'missing' };
  if (input.index.length === 0) return { ...base, status: 'no_source' };
  const identityOf = typeof input.identityOf === 'function' ? input.identityOf : resolveModelIdentity;
  const identity = identityOf({ harness, model });
  const ids = [];
  if (identity?.aliasStatus === 'matched' && identity.externalModelId) {
    ids.push({ id: key(identity.externalModelId), by: 'identity' });
  }
  ids.push({ id: model, by: 'model_id' });
  let sawEntry = false;
  for (const source of input.index) {
    for (const { id, by } of ids) {
      const entry = source.entries.get(id);
      if (!entry) continue;
      sawEntry = true;
      const raw = Number(entry.scores?.[metric]);
      if (!Number.isFinite(raw)) continue;
      const score = shrinkBenchmarkScore(raw);
      const weight = source.stale ? 0 : BENCHMARK_WEIGHT;
      return {
        ...base,
        status: source.stale ? 'stale' : 'ok',
        benchmark_score: score,
        raw_score: Number(Math.max(0, Math.min(1, raw)).toFixed(4)),
        weight,
        contribution: Number((weight * (score - BENCHMARK_NEUTRAL)).toFixed(4)),
        source: source.sourceId,
        captured_at: source.capturedAt,
        matched_by: by,
        stale: source.stale,
      };
    }
  }
  return { ...base, status: sawEntry ? 'missing' : 'unmapped' };
}

/**
 * Build the shadow block for a pick result.
 *
 * @param {{
 *   role: string,
 *   level?: string | null,
 *   candidates?: object[],
 *   selected?: object | null,
 *   snapshots?: object[],
 *   sourcePreferences?: object,
 *   now?: number,
 *   identityOf?: Function,
 * }} input
 * @returns {object}
 */
export function buildBenchmarkShadow(input = {}) {
  const index = buildBenchmarkShadowIndex({
    snapshots: input.snapshots,
    sourcePreferences: input.sourcePreferences,
    now: input.now,
  });
  const selectedId = input.selected?.harness && input.selected?.model
    ? `${key(input.selected.harness)}/${key(input.selected.model)}`
    : '';
  const pool = [];
  if (input.selected) pool.push(input.selected);
  for (const cand of Array.isArray(input.candidates) ? input.candidates : []) {
    const id = `${key(cand?.harness)}/${key(cand?.model)}`;
    if (id !== selectedId) pool.push(cand);
  }
  const candidates = pool
    .slice(0, MAX_CANDIDATES)
    .map((candidate) => scoreCandidateBenchmark({
      candidate,
      role: input.role,
      index,
      identityOf: input.identityOf,
    }));
  const attributions = [...new Set(
    candidates.filter((row) => row.source).map((row) => index.find((s) => s.sourceId === row.source)?.attribution).filter(Boolean),
  )];
  return {
    schema: BENCHMARK_SHADOW_SCHEMA_VERSION,
    shadow_only: true,
    role: key(input.role),
    level: input.level ? key(input.level) : null,
    weight: BENCHMARK_WEIGHT,
    shrinkage: BENCHMARK_SHRINKAGE,
    sources: index.map((s) => ({
      source: s.sourceId,
      captured_at: s.capturedAt,
      stale: s.stale,
      ttl_ms: s.ttlMs,
    })),
    attribution: attributions.join(' | ') || null,
    selected: selectedId ? candidates.find((row) => row.candidateId === selectedId) || null : null,
    candidates,
  };
}

/**
 * Reduce a stored/returned block to the closed field list for the journal.
 *
 * @param {unknown} input
 * @returns {object | null}
 */
export function normalizeBenchmarkShadow(input) {
  if (!input || typeof input !== 'object') return null;
  const block = /** @type {any} */ (input);
  const one = (row) => {
    if (!row || typeof row !== 'object') return null;
    const status = key(row.status);
    if (!BENCHMARK_STATUSES.includes(status)) return null;
    const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(Number(v).toFixed(4)) : null);
    return {
      candidateId: String(row.candidateId || '').slice(0, 160),
      status,
      metric: row.metric ? String(row.metric).slice(0, 24) : null,
      benchmark_score: num(row.benchmark_score),
      weight: num(row.weight) ?? 0,
      contribution: num(row.contribution) ?? 0,
      source: row.source ? String(row.source).slice(0, 64) : null,
      captured_at: row.captured_at ? String(row.captured_at).slice(0, 40) : null,
      stale: row.stale === true,
    };
  };
  const candidates = (Array.isArray(block.candidates) ? block.candidates : []).map(one).filter(Boolean).slice(0, MAX_CANDIDATES);
  const selected = one(block.selected);
  if (!selected && candidates.length === 0) return null;
  return {
    schema: BENCHMARK_SHADOW_SCHEMA_VERSION,
    shadow_only: true,
    role: key(block.role),
    level: block.level ? key(block.level) : null,
    weight: BENCHMARK_WEIGHT,
    attribution: block.attribution ? String(block.attribution).slice(0, 300) : null,
    selected,
    candidates,
  };
}
