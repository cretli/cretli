/**
 * Usage telemetry settings: journal retention and optional alerts.
 *
 * Stored in `data/config.json` under the `usage` key. Every field has a safe
 * default: retention keeps 90 days and every alert is OFF until the operator
 * opts in. This module is pure (it only reads settings when no object is
 * passed) so the routes and tests can inject a plain object.
 */

import { loadSettings } from '../persist/settings.js';

/** Version of the normalized settings document. */
export const USAGE_SETTINGS_SCHEMA_VERSION = 1;

/** Keep three months of `data/usage/YYYY-MM-DD.jsonl` by default. */
export const USAGE_DEFAULT_RETENTION_DAYS = 90;
export const USAGE_MIN_RETENTION_DAYS = 1;
export const USAGE_MAX_RETENTION_DAYS = 3650;

/** Plan windows at/above this utilization trigger the optional alert. */
export const USAGE_DEFAULT_PLAN_LIMIT_THRESHOLD_PERCENT = 80;
export const USAGE_MIN_PLAN_LIMIT_THRESHOLD_PERCENT = 1;
export const USAGE_MAX_PLAN_LIMIT_THRESHOLD_PERCENT = 100;

/** Budget bounds so a typo cannot arm an absurd threshold. */
export const USAGE_MIN_BUDGET_USD = 0.01;
export const USAGE_MAX_BUDGET_USD = 1_000_000;

/**
 * Canonical defaults. Deep-frozen: every normalizer builds fresh nested
 * objects, so no caller can mutate this constant.
 */
export const DEFAULT_USAGE_SETTINGS = Object.freeze({
  schemaVersion: USAGE_SETTINGS_SCHEMA_VERSION,
  retentionDays: USAGE_DEFAULT_RETENTION_DAYS,
  alerts: Object.freeze({
    // All alert channels default off; the operator opts in explicitly.
    planLimit: false,
    lockout: false,
    budget: false,
    planLimitThresholdPercent: USAGE_DEFAULT_PLAN_LIMIT_THRESHOLD_PERCENT,
    dailyBudgetUsd: null,
    monthlyBudgetUsd: null,
  }),
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

/**
 * A budget is either `null` (disabled) or a bounded positive USD amount.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeBudgetUsd(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(USAGE_MAX_BUDGET_USD, Math.max(USAGE_MIN_BUDGET_USD, Number(numeric.toFixed(6))));
}

/**
 * Resolve a budget field from a patch. Omitted, empty and invalid values keep
 * the stored budget (same retention rule as the other fields); only an explicit
 * `null` clears the configured threshold.
 *
 * @param {unknown} value
 * @param {number|null} current
 * @returns {number|null}
 */
function resolveBudgetPatch(value, current) {
  if (value === null) return null;
  const normalized = normalizeBudgetUsd(value);
  return normalized == null ? current : normalized;
}

/**
 * Lenient normalization: always returns a full, fresh, validated object.
 * Missing fields fall back to defaults; wrong types and unknown enum ids are
 * replaced with defaults; unknown keys are ignored.
 *
 * @param {unknown} raw
 * @returns {{
 *   schemaVersion: number,
 *   retentionDays: number,
 *   alerts: {
 *     planLimit: boolean,
 *     lockout: boolean,
 *     budget: boolean,
 *     planLimitThresholdPercent: number,
 *     dailyBudgetUsd: number|null,
 *     monthlyBudgetUsd: number|null,
 *   },
 * }}
 */
export function normalizeUsageSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const rawAlerts = isPlainObject(source.alerts) ? source.alerts : {};
  return {
    schemaVersion: USAGE_SETTINGS_SCHEMA_VERSION,
    retentionDays: clampInt(
      source.retentionDays,
      USAGE_MIN_RETENTION_DAYS,
      USAGE_MAX_RETENTION_DAYS,
      USAGE_DEFAULT_RETENTION_DAYS
    ),
    alerts: {
      planLimit: rawAlerts.planLimit === true,
      lockout: rawAlerts.lockout === true,
      budget: rawAlerts.budget === true,
      planLimitThresholdPercent: clampInt(
        rawAlerts.planLimitThresholdPercent,
        USAGE_MIN_PLAN_LIMIT_THRESHOLD_PERCENT,
        USAGE_MAX_PLAN_LIMIT_THRESHOLD_PERCENT,
        USAGE_DEFAULT_PLAN_LIMIT_THRESHOLD_PERCENT
      ),
      dailyBudgetUsd: normalizeBudgetUsd(rawAlerts.dailyBudgetUsd),
      monthlyBudgetUsd: normalizeBudgetUsd(rawAlerts.monthlyBudgetUsd),
    },
  };
}

/**
 * @param {object|null} [settings] - `loadSettings()` result; loaded when omitted
 * @returns {ReturnType<typeof normalizeUsageSettings>}
 */
export function getUsageSettings(settings = null) {
  const cfg = settings || loadSettings();
  return normalizeUsageSettings(cfg.usage);
}

/**
 * Merge a (possibly partial) settings patch over the current values. Omitted
 * fields keep their value; invalid values fall back to the current value, never
 * to a silent default that would flip an alert on. Budgets additionally accept
 * an explicit `null` to clear the configured threshold (an empty or invalid
 * value keeps it instead).
 *
 * @param {unknown} current
 * @param {unknown} patch
 * @returns {ReturnType<typeof normalizeUsageSettings>}
 */
export function applyUsageSettingsPatch(current, patch) {
  if (!isPlainObject(patch)) return normalizeUsageSettings(current);
  const base = normalizeUsageSettings(current);
  const next = { ...base, alerts: { ...base.alerts } };
  if (Object.prototype.hasOwnProperty.call(patch, 'retentionDays') && patch.retentionDays != null && patch.retentionDays !== '') {
    next.retentionDays = clampInt(
      patch.retentionDays,
      USAGE_MIN_RETENTION_DAYS,
      USAGE_MAX_RETENTION_DAYS,
      base.retentionDays
    );
  }
  if (isPlainObject(patch.alerts)) {
    const alerts = patch.alerts;
    if (typeof alerts.planLimit === 'boolean') next.alerts.planLimit = alerts.planLimit;
    if (typeof alerts.lockout === 'boolean') next.alerts.lockout = alerts.lockout;
    if (typeof alerts.budget === 'boolean') next.alerts.budget = alerts.budget;
    if (
      Object.prototype.hasOwnProperty.call(alerts, 'planLimitThresholdPercent')
      && alerts.planLimitThresholdPercent != null
      && alerts.planLimitThresholdPercent !== ''
    ) {
      next.alerts.planLimitThresholdPercent = clampInt(
        alerts.planLimitThresholdPercent,
        USAGE_MIN_PLAN_LIMIT_THRESHOLD_PERCENT,
        USAGE_MAX_PLAN_LIMIT_THRESHOLD_PERCENT,
        base.alerts.planLimitThresholdPercent
      );
    }
    if (Object.prototype.hasOwnProperty.call(alerts, 'dailyBudgetUsd')) {
      next.alerts.dailyBudgetUsd = resolveBudgetPatch(alerts.dailyBudgetUsd, base.alerts.dailyBudgetUsd);
    }
    if (Object.prototype.hasOwnProperty.call(alerts, 'monthlyBudgetUsd')) {
      next.alerts.monthlyBudgetUsd = resolveBudgetPatch(alerts.monthlyBudgetUsd, base.alerts.monthlyBudgetUsd);
    }
  }
  return normalizeUsageSettings(next);
}
