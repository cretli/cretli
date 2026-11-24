/**
 * Settings of the internal operator (`operatorInternal` section of settings.json).
 *
 * Only the owner changes these; no agent tool writes them. Everything is
 * clamped on read so a hand-edited file can never produce a negative or absurd
 * limit. The token numbers are first estimates and are to be confirmed by the
 * owner after a week of real usage (`docs/operator-internal.md`).
 */

import { loadSettings } from '../persist/settings.js';

/**
 * @typedef {object} OperatorSettings
 * @property {boolean} enabled
 * @property {number} runsPerHour
 * @property {number} runsPerHourPerWorkspace
 * @property {{ triage: number, diagnosis: number }} perRunTokens
 * @property {number} dailyTokenBudget
 * @property {number} triageOnlyAt
 * @property {number} reserveFraction
 * @property {number} coalesceMs
 * @property {number} maxPending
 * @property {number} circuitBreakerFailures
 * @property {number} runDeadlineMs
 */

export const OPERATOR_SETTINGS_DEFAULTS = Object.freeze({
  /** Off by default: the owner switches the internal operator on. */
  enabled: false,
  runsPerHour: 12,
  runsPerHourPerWorkspace: 6,
  perRunTokens: Object.freeze({ triage: 60_000, diagnosis: 250_000 }),
  dailyTokenBudget: 1_500_000,
  /** Fraction of the daily budget at which every run becomes triage-only. */
  triageOnlyAt: 0.8,
  /** Extra fraction of the daily budget kept for priority 0-1 events once the budget is spent. */
  reserveFraction: 0.1,
  coalesceMs: 60_000,
  maxPending: 200,
  circuitBreakerFailures: 3,
  runDeadlineMs: 15 * 60_000,
});

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {Record<string, any> | null | undefined} raw the `operatorInternal` object
 * @returns {OperatorSettings}
 */
export function normalizeOperatorSettings(raw) {
  const d = OPERATOR_SETTINGS_DEFAULTS;
  const src = raw && typeof raw === 'object' ? raw : {};
  const tokens = src.perRunTokens && typeof src.perRunTokens === 'object' ? src.perRunTokens : {};
  return {
    enabled: src.enabled === true,
    runsPerHour: Math.floor(clampNumber(src.runsPerHour, d.runsPerHour, 1, 120)),
    runsPerHourPerWorkspace: Math.floor(clampNumber(src.runsPerHourPerWorkspace, d.runsPerHourPerWorkspace, 1, 120)),
    perRunTokens: {
      triage: Math.floor(clampNumber(tokens.triage, d.perRunTokens.triage, 1_000, 5_000_000)),
      diagnosis: Math.floor(clampNumber(tokens.diagnosis, d.perRunTokens.diagnosis, 1_000, 20_000_000)),
    },
    dailyTokenBudget: Math.floor(clampNumber(src.dailyTokenBudget, d.dailyTokenBudget, 10_000, 1_000_000_000)),
    triageOnlyAt: clampNumber(src.triageOnlyAt, d.triageOnlyAt, 0.1, 1),
    reserveFraction: clampNumber(src.reserveFraction, d.reserveFraction, 0, 1),
    coalesceMs: Math.floor(clampNumber(src.coalesceMs, d.coalesceMs, 0, 3_600_000)),
    maxPending: Math.floor(clampNumber(src.maxPending, d.maxPending, 1, 5000)),
    circuitBreakerFailures: Math.floor(clampNumber(src.circuitBreakerFailures, d.circuitBreakerFailures, 1, 50)),
    runDeadlineMs: Math.floor(clampNumber(src.runDeadlineMs, d.runDeadlineMs, 60_000, 6 * 3_600_000)),
  };
}

/**
 * @param {{ settings?: Record<string, any> | null }} [options] `settings` injects the whole settings object (tests)
 * @returns {OperatorSettings}
 */
export function readOperatorSettings(options = {}) {
  let settings = options.settings;
  if (!settings) {
    try { settings = loadSettings(); } catch { settings = null; }
  }
  return normalizeOperatorSettings(settings?.operatorInternal);
}
