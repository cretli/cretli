/**
 * Provider-neutral plan-window forecast.
 *
 * This module is intentionally pure: no filesystem, no ledger read and no
 * harness id in the logic. A "window" is identified by the tuple
 * `harness + rateLimitType + resetsAt`, so two harnesses — or two window types
 * of the same harness — never contaminate each other. Utilization growth is
 * extrapolated from measured percentage samples only; token samples are
 * informational and can never move a percentage or a forecast.
 */

import { billedTotalTokens } from './usage-contract.js';

/** A baseline needs at least this much separation to measure a growth rate. */
export const PLAN_WINDOW_MIN_BASELINE_MS = 60_000;
/** A latest reading older than this cannot be extrapolated (mirrors `stale`). */
export const PLAN_WINDOW_STALE_MS = 6 * 60 * 60 * 1000;
/** Points needed before a forecast is considered well supported. */
export const PLAN_WINDOW_HIGH_CONFIDENCE_POINTS = 3;
/** Time span needed before a forecast is considered well supported. */
export const PLAN_WINDOW_HIGH_CONFIDENCE_SPAN_MS = 10 * 60 * 1000;
/** Allowed confidence levels, lowest first. */
export const PLAN_WINDOW_CONFIDENCE = Object.freeze(['none', 'low', 'high']);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Accepts epoch seconds, epoch milliseconds or an ISO-ish string.
 *
 * @param {unknown} value
 * @returns {number} epoch ms, or NaN
 */
function toMs(value) {
  if (value == null || value === '') return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * @param {unknown} value
 * @returns {string} ISO timestamp or ''
 */
function toIso(value) {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * Missing or non-numeric utilization stays missing — never coerced to 0.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toUtilization(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Total billable tokens for one token sample. Samples may carry a precomputed
 * total or a ledger token bag. Returns null when the sample has no measurement.
 *
 * @param {object} sample
 * @param {string} harness
 * @returns {number|null}
 */
function tokenSampleTotal(sample, harness) {
  for (const key of ['totalTokens', 'totalBilledTokens', 'tokenTotal']) {
    const value = Number(sample?.[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  if (typeof sample?.tokens === 'number') {
    return Number.isFinite(sample.tokens) && sample.tokens >= 0 ? sample.tokens : null;
  }
  if (sample?.tokens && typeof sample.tokens === 'object') {
    return billedTotalTokens(sample.tokens, harness);
  }
  return null;
}

/**
 * Sums the token samples that fall inside one window. The ledger cannot label
 * a sample with a `rateLimitType`, so membership is the harness plus the
 * measured span `[first reading .. min(now, resetsAt)]`. No sample whose value
 * is unknown is counted, and an empty span yields null.
 *
 * @param {{ harness: string, resetsMs: number, readings: { observedMs: number }[] }} group
 * @param {object[]} tokenSamples
 * @param {number} now
 * @returns {number|null}
 */
function tokensInWindow(group, tokenSamples, now) {
  if (tokenSamples.length === 0) return null;
  if (group.readings.length === 0) return null;
  const fromMs = Math.min(...group.readings.map((reading) => reading.observedMs));
  const limitMs = Number.isFinite(group.resetsMs) ? Math.min(now, group.resetsMs) : now;
  let total = 0;
  let counted = false;
  for (const sample of tokenSamples) {
    if (!sample || typeof sample !== 'object') continue;
    if (text(sample.harness).toLowerCase() !== group.harness) continue;
    const at = toMs(sample.at ?? sample.observedAt);
    if (!Number.isFinite(at) || at < fromMs || at > limitMs) continue;
    const value = tokenSampleTotal(sample, group.harness);
    if (value == null) continue;
    total += value;
    counted = true;
  }
  return counted ? total : null;
}

/**
 * How trustworthy a computed forecast is: `none` when no forecast exists,
 * `high` only with enough points spread over enough time, otherwise `low`.
 *
 * @param {{ observedMs: number }[]} points
 * @param {number} observedMs
 * @returns {'none'|'low'|'high'}
 */
function confidenceFor(points, observedMs) {
  const usable = points.filter((point) => point.observedMs <= observedMs);
  if (usable.length < 2) return 'none';
  const span = observedMs - usable[0].observedMs;
  return usable.length >= PLAN_WINDOW_HIGH_CONFIDENCE_POINTS
    && span >= PLAN_WINDOW_HIGH_CONFIDENCE_SPAN_MS
    ? 'high'
    : 'low';
}

/**
 * Linear estimate from measured utilization growth. The window must be live,
 * the latest reading must be present and not stale, utilization must grow
 * monotonically, and a baseline at least `PLAN_WINDOW_MIN_BASELINE_MS` old is
 * required. Any of those failing yields null rather than an invented number.
 *
 * @param {{
 *   points: { utilization: number, observedMs: number }[],
 *   utilization: number|null,
 *   observedMs: number,
 *   resetMs: number,
 *   stale: boolean,
 *   expired: boolean,
 *   now: number,
 * }} input
 * @returns {{ exhaustsAt: string, beforeReset: boolean, percentPerHour: number, remainingMs: number }|null}
 */
function computeForecast(input) {
  const { points, utilization, observedMs, resetMs, stale, expired, now } = input;
  if (utilization == null || stale || expired) return null;
  if (!Number.isFinite(resetMs) || resetMs <= now) return null;
  if (!Number.isFinite(observedMs) || observedMs > now) return null;
  for (let i = 1; i < points.length; i += 1) {
    // A drop means the provider reset or re-measured the window; a rate across
    // that boundary would be fabricated.
    if (points[i].utilization < points[i - 1].utilization) return null;
  }
  const baseline = points.find((point) =>
    observedMs - point.observedMs >= PLAN_WINDOW_MIN_BASELINE_MS
    && observedMs - point.observedMs <= PLAN_WINDOW_STALE_MS
    && point.utilization < utilization);
  if (!baseline) return null;
  const elapsed = observedMs - baseline.observedMs;
  const rate = (utilization - baseline.utilization) / elapsed;
  if (!(rate > 0)) return null;
  const exhaustionMs = observedMs + Math.max(0, 100 - utilization) / rate;
  if (!Number.isFinite(exhaustionMs) || Math.abs(exhaustionMs) > 8.64e15) return null;
  return {
    exhaustsAt: new Date(exhaustionMs).toISOString(),
    beforeReset: exhaustionMs < resetMs,
    percentPerHour: rate * 3_600_000,
    remainingMs: Math.max(0, exhaustionMs - now),
  };
}

/**
 * @param {object} group
 * @param {object[]} tokenSamples
 * @param {number} now
 * @returns {object}
 */
function buildWindow(group, tokenSamples, now) {
  const readings = group.readings.slice().sort((a, b) => a.observedMs - b.observedMs);
  const latest = readings[readings.length - 1] || null;
  const observedMs = latest ? latest.observedMs : NaN;
  const resetMs = group.resetsMs;
  const expired = Number.isFinite(resetMs) && resetMs <= now;
  const stale = !Number.isFinite(observedMs) || now - observedMs > PLAN_WINDOW_STALE_MS;
  const utilization = latest ? latest.utilization : null;
  // Distinct timestamps only; the latest reading for a timestamp wins.
  const byTime = new Map();
  for (const reading of readings) {
    if (reading.utilization == null) continue;
    byTime.set(reading.observedMs, reading.utilization);
  }
  const points = [...byTime.entries()]
    .map(([at, value]) => ({ observedMs: at, utilization: value }))
    .sort((a, b) => a.observedMs - b.observedMs);
  const forecast = computeForecast({ points, utilization, observedMs, resetMs, stale, expired, now });
  return {
    harness: group.harness,
    rateLimitType: group.rateLimitType,
    status: latest ? latest.status : '',
    resetsAt: group.resetsAt,
    observedAt: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : '',
    utilization,
    remainingPercent: !expired && utilization != null ? Math.max(0, 100 - utilization) : null,
    stale,
    expired,
    resetInMs: Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : null,
    tokensInWindow: tokensInWindow(group, tokenSamples, now),
    forecast,
    confidence: forecast ? confidenceFor(points, observedMs) : 'none',
  };
}

/**
 * Forecasts every plan window present in a series of readings.
 *
 * @param {{
 *   readings?: object[],
 *   tokenSamples?: object[],
 *   now?: number,
 * }} [input]
 * @returns {object[]} one row per `{harness, rateLimitType, resetsAt}` window
 */
export function forecastPlanWindows(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const groups = new Map();
  for (const reading of Array.isArray(input.readings) ? input.readings : []) {
    if (!reading || typeof reading !== 'object') continue;
    const harness = text(reading.harness).toLowerCase();
    if (!harness) continue;
    const observedMs = toMs(reading.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const rateLimitType = text(reading.rateLimitType);
    const resetsMs = toMs(reading.resetsAt);
    const key = `${harness}\u0000${rateLimitType}\u0000${toIso(resetsMs)}`;
    let group = groups.get(key);
    if (!group) {
      group = { harness, rateLimitType, resetsAt: toIso(resetsMs), resetsMs, readings: [] };
      groups.set(key, group);
    }
    group.readings.push({
      utilization: toUtilization(reading.utilization),
      observedMs,
      status: text(reading.status),
    });
  }
  const tokenSamples = Array.isArray(input.tokenSamples) ? input.tokenSamples : [];
  return [...groups.values()]
    .map((group) => buildWindow(group, tokenSamples, now))
    .sort((a, b) =>
      a.harness.localeCompare(b.harness)
      || a.rateLimitType.localeCompare(b.rateLimitType)
      || a.resetsAt.localeCompare(b.resetsAt));
}
