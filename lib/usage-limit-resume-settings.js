/**
 * `usageLimitResume` settings block in `data/config.json`. A missing or
 * malformed block means the feature is off; every number is clamped to its
 * bounds. Detection hooks read `enabled` only through this module.
 */

import { loadSettings } from './persist/settings.js';

/** @type {Readonly<Record<string, any>>} */
export const USAGE_LIMIT_RESUME_DEFAULTS = Object.freeze({
  enabled: false,
  marginMs: 120_000,
  jitterMs: 90_000,
  maxChain: 2,
  maxPerTick: 3,
  catchUpMs: 900_000,
  allowPremium: false,
  resumeDelegations: true,
});

/** @type {Readonly<Record<string, [number, number]>>} */
const BOUNDS = Object.freeze({
  marginMs: [0, 900_000],
  jitterMs: [0, 600_000],
  maxChain: [0, 5],
  maxPerTick: [1, 10],
  catchUpMs: [0, 86_400_000],
});

/**
 * Field descriptors the generic wake-up UI renders and validates against; the
 * numeric bounds are the same ones the normalizer clamps to.
 */
export const USAGE_LIMIT_RESUME_SETTINGS_SCHEMA = Object.freeze({
  enabled: Object.freeze({ type: 'boolean', default: USAGE_LIMIT_RESUME_DEFAULTS.enabled }),
  allowPremium: Object.freeze({ type: 'boolean', default: USAGE_LIMIT_RESUME_DEFAULTS.allowPremium }),
  resumeDelegations: Object.freeze({ type: 'boolean', default: USAGE_LIMIT_RESUME_DEFAULTS.resumeDelegations }),
  ...Object.fromEntries(Object.entries(BOUNDS).map(([key, [min, max]]) => [
    key, Object.freeze({ type: 'integer', min, max, default: USAGE_LIMIT_RESUME_DEFAULTS[key] }),
  ])),
});

/**
 * @param {unknown} value
 * @param {readonly number[]} bounds [min, max]
 * @param {number} fallback
 */
function clampInt(value, [min, max], fallback) {
  const n = Math.round(Number(value));
  if (value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {any} raw
 * @returns {typeof USAGE_LIMIT_RESUME_DEFAULTS}
 */
export function normalizeUsageLimitResumeSettings(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = USAGE_LIMIT_RESUME_DEFAULTS;
  const bool = (key) => (typeof cfg[key] === 'boolean' ? cfg[key] : d[key]);
  return {
    enabled: bool('enabled'),
    marginMs: clampInt(cfg.marginMs, BOUNDS.marginMs, d.marginMs),
    jitterMs: clampInt(cfg.jitterMs, BOUNDS.jitterMs, d.jitterMs),
    maxChain: clampInt(cfg.maxChain, BOUNDS.maxChain, d.maxChain),
    maxPerTick: clampInt(cfg.maxPerTick, BOUNDS.maxPerTick, d.maxPerTick),
    catchUpMs: clampInt(cfg.catchUpMs, BOUNDS.catchUpMs, d.catchUpMs),
    allowPremium: bool('allowPremium'),
    resumeDelegations: bool('resumeDelegations'),
  };
}

/**
 * @param {Record<string, any>|null} [settings] pre-loaded `config.json` (tests/callers)
 * @returns {typeof USAGE_LIMIT_RESUME_DEFAULTS}
 */
export function readUsageLimitResumeSettings(settings = null) {
  let source = settings;
  if (!source) {
    try { source = loadSettings(); } catch { source = {}; }
  }
  return normalizeUsageLimitResumeSettings(source?.usageLimitResume);
}
