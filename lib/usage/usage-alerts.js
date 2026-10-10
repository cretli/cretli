/**
 * Optional usage alerts.
 *
 * Three conditions are evaluated server-side and, when the operator enables
 * them, surfaced through the EXISTING channels:
 *   - a plan window crossed the configured utilization threshold,
 *   - a harness entered a lockout,
 *   - the configured daily/monthly USD budget was reached.
 *
 * All alerts default off (`usage-settings.js`). Every alert carries a stable
 * `key` + `period`, and `dispatchUsageAlerts` keeps a small durable state file
 * (`data/usage/alert-state.json`) so a given crossing notifies at most once per
 * period. Nothing here records prompts, report bodies or file paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { readUsageEvents } from '../persist/usage-persist.js';
import { summarizeUsage } from './usage-ledger.js';
import { filterEventsByWindow, resolveUsageWindow } from './usage-window.js';
import { readHarnessPlanLimitHistory } from './plan-limit-history.js';
import { forecastPlanWindows } from './plan-window-forecast.js';
import { listHarnessUsageLimits } from '../harness-usage-limits.js';
import { getUsageSettings, normalizeUsageSettings } from './usage-settings.js';

/** Stable alert kinds used by payloads and the throttle state. */
export const USAGE_ALERT_KINDS = Object.freeze([
  'plan-limit',
  'lockout',
  'budget-daily',
  'budget-monthly',
]);

/** Settings page opened by an alert tap. */
export const USAGE_ALERT_ACTION_URL = '/?panel=settings&tab=usage';

/** Alert state older than this is dropped so the file cannot grow forever. */
export const USAGE_ALERT_STATE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** Upper bound of tracked alert fingerprints. */
export const USAGE_ALERT_STATE_MAX_KEYS = 500;

const ALERT_STATE_FILE = 'alert-state.json';

/**
 * @param {unknown} value
 * @returns {number}
 */
function nowFrom(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Plan windows at/above the threshold. An expired or utilization-less window
 * never alerts; a window without `resetsAt` is keyed to the current observation
 * so it still notifies once instead of forever.
 *
 * @param {object[]} windows
 * @param {{ thresholdPercent?: unknown, now?: unknown }} [options]
 * @returns {object[]}
 */
export function evaluatePlanLimitAlerts(windows, options = {}) {
  const threshold = toFiniteNumber(options.thresholdPercent) ?? 80;
  const alerts = [];
  for (const window of Array.isArray(windows) ? windows : []) {
    if (!window || typeof window !== 'object') continue;
    if (window.expired === true) continue;
    const utilization = toFiniteNumber(window.utilization);
    if (utilization == null || utilization < threshold) continue;
    const harness = text(window.harness).toLowerCase();
    if (!harness) continue;
    const rateLimitType = text(window.rateLimitType);
    const resetsAt = text(window.resetsAt);
    const period = resetsAt || `open:${text(window.observedAt).slice(0, 13)}`;
    alerts.push({
      kind: 'plan-limit',
      key: `plan-limit:${harness}:${rateLimitType || '*'}`,
      period,
      harness,
      rateLimitType,
      utilization,
      thresholdPercent: threshold,
      resetsAt: resetsAt || null,
    });
  }
  return alerts;
}

/**
 * Active lockouts only; an already reset entry is ignored.
 *
 * @param {object[]} lockouts
 * @param {{ now?: unknown }} [options]
 * @returns {object[]}
 */
export function evaluateLockoutAlerts(lockouts, options = {}) {
  const now = nowFrom(options.now);
  const alerts = [];
  for (const row of Array.isArray(lockouts) ? lockouts : []) {
    if (!row || typeof row !== 'object') continue;
    const harness = text(row.harness).toLowerCase();
    if (!harness) continue;
    const resetMs = Date.parse(text(row.resetAt));
    if (Number.isFinite(resetMs) && resetMs <= now) continue;
    const model = text(row.model);
    alerts.push({
      kind: 'lockout',
      key: `lockout:${harness}:${model || '*'}`,
      period: text(row.resetAt) || text(row.code) || 'active',
      harness,
      model: model || null,
      code: text(row.code) || null,
      resetAt: text(row.resetAt) || null,
    });
  }
  return alerts;
}

/**
 * Budget alerts fire at/above the configured threshold, once per calendar
 * period (day or month). A `null` or non-positive budget stays disabled.
 *
 * @param {{
 *   dailySpendUsd?: unknown,
 *   monthlySpendUsd?: unknown,
 *   dailyBudgetUsd?: unknown,
 *   monthlyBudgetUsd?: unknown,
 *   dayKey?: unknown,
 *   monthKey?: unknown,
 * }} [input]
 * @returns {object[]}
 */
export function evaluateBudgetAlerts(input = {}) {
  const alerts = [];
  const dailyBudget = toFiniteNumber(input.dailyBudgetUsd);
  const monthlyBudget = toFiniteNumber(input.monthlyBudgetUsd);
  const dailySpend = toFiniteNumber(input.dailySpendUsd);
  const monthlySpend = toFiniteNumber(input.monthlySpendUsd);
  if (dailyBudget != null && dailyBudget > 0 && dailySpend != null && dailySpend >= dailyBudget) {
    alerts.push({
      kind: 'budget-daily',
      key: 'budget:daily',
      period: text(input.dayKey) || 'unknown',
      budgetUsd: dailyBudget,
      spendUsd: dailySpend,
    });
  }
  if (monthlyBudget != null && monthlyBudget > 0 && monthlySpend != null && monthlySpend >= monthlyBudget) {
    alerts.push({
      kind: 'budget-monthly',
      key: 'budget:monthly',
      period: text(input.monthKey) || 'unknown',
      budgetUsd: monthlyBudget,
      spendUsd: monthlySpend,
    });
  }
  return alerts;
}

/**
 * Evaluate every enabled alert kind for one observation.
 *
 * @param {{
 *   windows?: object[],
 *   lockouts?: object[],
 *   dailySpendUsd?: unknown,
 *   monthlySpendUsd?: unknown,
 *   dayKey?: unknown,
 *   monthKey?: unknown,
 *   settings?: unknown,
 *   now?: unknown,
 * }} [input]
 * @returns {object[]}
 */
export function collectUsageAlerts(input = {}) {
  const settings = normalizeUsageSettings(input.settings);
  const alerts = [];
  if (settings.alerts.planLimit) {
    alerts.push(
      ...evaluatePlanLimitAlerts(input.windows, {
        thresholdPercent: settings.alerts.planLimitThresholdPercent,
        now: input.now,
      })
    );
  }
  if (settings.alerts.lockout) {
    alerts.push(...evaluateLockoutAlerts(input.lockouts, { now: input.now }));
  }
  if (settings.alerts.budget) {
    alerts.push(
      ...evaluateBudgetAlerts({
        dailySpendUsd: input.dailySpendUsd,
        monthlySpendUsd: input.monthlySpendUsd,
        dailyBudgetUsd: settings.alerts.dailyBudgetUsd,
        monthlyBudgetUsd: settings.alerts.monthlyBudgetUsd,
        dayKey: input.dayKey,
        monthKey: input.monthKey,
      })
    );
  }
  return alerts;
}

/**
 * @param {number} value
 * @returns {string}
 */
function usd(value) {
  return `$${Number(value).toFixed(2)}`;
}

/**
 * Pure web-push payload. The body names only the harness/model, the percentage
 * or the USD amount; it never carries conversation content.
 *
 * @param {object} alert
 * @returns {{ title: string, body: string, tag: string, data: object }}
 */
export function buildUsageAlertPushPayload(alert) {
  const kind = text(alert?.kind);
  const harness = text(alert?.harness) || 'harness';
  const model = text(alert?.model);
  const label = model ? `${harness} / ${model}` : harness;
  let title = 'Cretli — usage alert';
  let body = 'A usage threshold was crossed.';
  if (kind === 'plan-limit') {
    title = 'Cretli — plan limit';
    body = `${label} is at ${Math.round(toFiniteNumber(alert.utilization) ?? 0)}% of its plan window (threshold ${Math.round(toFiniteNumber(alert.thresholdPercent) ?? 80)}%).`;
  } else if (kind === 'lockout') {
    title = 'Cretli — harness lockout';
    body = `${label} hit a provider limit and is paused${alert.resetAt ? ` until ${alert.resetAt}` : ''}.`;
  } else if (kind === 'budget-daily') {
    title = 'Cretli — daily budget reached';
    body = `Today's usage (${usd(alert.spendUsd)}) reached the daily budget (${usd(alert.budgetUsd)}).`;
  } else if (kind === 'budget-monthly') {
    title = 'Cretli — monthly budget reached';
    body = `This month's usage (${usd(alert.spendUsd)}) reached the monthly budget (${usd(alert.budgetUsd)}).`;
  }
  return {
    title,
    body,
    tag: `cretli-usage-${kind}-${text(alert?.period) || 'now'}`,
    data: {
      type: 'usage-alert',
      kind,
      key: text(alert?.key),
      period: text(alert?.period),
      url: USAGE_ALERT_ACTION_URL,
      at: Date.now(),
    },
  };
}

/**
 * In-app notification-centre row for an alert. `fingerprint` includes the
 * period so a new crossing is a new occurrence while a replay stays deduped by
 * the notification store itself.
 *
 * @param {object} alert
 * @returns {{ category: string, severity: string, title: string, body: string, actionUrl: string, fingerprint: string }}
 */
export function buildUsageAlertNotification(alert) {
  const payload = buildUsageAlertPushPayload(alert);
  const kind = text(alert?.kind);
  const severity = kind === 'budget-daily' || kind === 'budget-monthly' ? 'warning' : 'important';
  return {
    category: 'system',
    severity,
    title: payload.title.replace(/^Cretli — /, ''),
    body: payload.body,
    actionUrl: USAGE_ALERT_ACTION_URL,
    fingerprint: `usage-alert:${text(alert?.key)}:${text(alert?.period) || 'now'}`,
  };
}

/**
 * @param {unknown} dataDir
 * @returns {string}
 */
export function resolveUsageAlertStatePath(dataDir) {
  const root = text(dataDir) || resolveDataPath();
  return path.join(root, 'usage', ALERT_STATE_FILE);
}

/**
 * Read the throttle state. A missing or corrupt file is an empty state.
 *
 * @param {unknown} dataDir
 * @returns {{ version: number, alerts: Record<string, { period: string, at: string }> }}
 */
export function readUsageAlertState(dataDir) {
  const file = resolveUsageAlertStatePath(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { version: 1, alerts: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    const alerts = parsed && typeof parsed === 'object' && parsed.alerts && typeof parsed.alerts === 'object'
      ? parsed.alerts
      : {};
    return { version: 1, alerts };
  } catch {
    return { version: 1, alerts: {} };
  }
}

/**
 * @param {unknown} dataDir
 * @param {object} state
 * @returns {void}
 */
export function writeUsageAlertState(dataDir, state) {
  const file = resolveUsageAlertStatePath(dataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, state);
  } catch (error) {
    console.warn('[usage-alerts] state write failed:', error?.message || error);
  }
}

/**
 * True when this crossing has not been recorded for its period yet.
 *
 * @param {{ alerts?: Record<string, { period?: string }> }} state
 * @param {object} alert
 * @returns {boolean}
 */
export function shouldNotifyUsageAlert(state, alert) {
  const key = text(alert?.key);
  if (!key) return false;
  const previous = state?.alerts?.[key];
  if (!previous) return true;
  return text(previous.period) !== text(alert?.period);
}

/**
 * @param {{ version?: number, alerts?: Record<string, object> }} state
 * @param {object} alert
 * @param {unknown} now
 * @returns {void}
 */
export function markUsageAlertNotified(state, alert, now) {
  const key = text(alert?.key);
  if (!key) return;
  if (!state.alerts || typeof state.alerts !== 'object') state.alerts = {};
  state.alerts[key] = { period: text(alert?.period), at: new Date(nowFrom(now)).toISOString() };
}

/**
 * Drop stale fingerprints and cap the map size (newest kept).
 *
 * @param {{ alerts?: Record<string, { at?: string }> }} state
 * @param {unknown} now
 * @param {{ maxAgeMs?: number, maxKeys?: number }} [options]
 * @returns {{ version: number, alerts: Record<string, object> }}
 */
export function pruneUsageAlertState(state, now, options = {}) {
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Number(options.maxAgeMs)
    : USAGE_ALERT_STATE_MAX_AGE_MS;
  const maxKeys = Number.isFinite(Number(options.maxKeys))
    ? Number(options.maxKeys)
    : USAGE_ALERT_STATE_MAX_KEYS;
  const reference = nowFrom(now);
  const entries = Object.entries(state?.alerts && typeof state.alerts === 'object' ? state.alerts : {});
  const fresh = entries
    .filter(([, row]) => {
      const at = Date.parse(text(row?.at));
      return !Number.isFinite(at) || reference - at <= maxAgeMs;
    })
    .sort((left, right) => Date.parse(text(left[1]?.at)) - Date.parse(text(right[1]?.at)));
  const capped = fresh.length > maxKeys ? fresh.slice(fresh.length - maxKeys) : fresh;
  return { version: 1, alerts: Object.fromEntries(capped) };
}

/**
 * Read the current plan windows, active lockouts and today/month spend.
 *
 * @param {{ dataDir?: unknown, now?: unknown }} [input]
 * @returns {object}
 */
export function collectUsageAlertSignals(input = {}) {
  const now = nowFrom(input.now);
  let windows = [];
  try {
    windows = forecastPlanWindows({ readings: readHarnessPlanLimitHistory({ dataDir: input.dataDir }), now });
  } catch (error) {
    console.warn('[usage-alerts] plan windows failed:', error?.message || error);
  }
  let lockouts = [];
  try {
    lockouts = listHarnessUsageLimits(input.dataDir);
  } catch (error) {
    console.warn('[usage-alerts] lockouts failed:', error?.message || error);
  }
  const spend = readBudgetSpend({ dataDir: input.dataDir, now });
  return { windows, lockouts, ...spend };
}

/**
 * Own-scope spend (metered + estimated) for the current zone calendar day and
 * month. Consolidated child cost is not counted twice here.
 *
 * @param {{ dataDir?: unknown, now?: unknown }} [input]
 * @returns {{ dailySpendUsd: number, monthlySpendUsd: number, dayKey: string, monthKey: string }}
 */
export function readBudgetSpend(input = {}) {
  const now = nowFrom(input.now);
  const result = { dailySpendUsd: 0, monthlySpendUsd: 0, dayKey: '', monthKey: '' };
  for (const range of ['today', 'month']) {
    const window = resolveUsageWindow({ range, now });
    if (!window.ok) continue;
    let events = [];
    try {
      events = filterEventsByWindow(
        readUsageEvents({ from: window.readFrom, to: window.readTo, dataDir: input.dataDir }),
        window
      );
    } catch {
      events = [];
    }
    const summary = summarizeUsage(events);
    const total = Number((summary.totalUsd + summary.estimatedUsd).toFixed(6));
    if (range === 'today') {
      result.dailySpendUsd = total;
      result.dayKey = window.labelFrom;
    } else {
      result.monthlySpendUsd = total;
      result.monthKey = window.labelFrom.slice(0, 7);
    }
  }
  return result;
}

/**
 * Default web push via the existing VAPID broadcaster. Imported lazily so this
 * module (and its tests) never touch `push.js` or the real data directory.
 *
 * @param {object} payload
 * @returns {Promise<unknown>}
 */
async function defaultBroadcastPush(payload) {
  const { broadcastPush } = await import('../push.js');
  return broadcastPush(payload);
}

/**
 * Default in-app notification via the existing notification centre.
 *
 * @param {object} notification
 * @param {unknown} dataDir
 * @returns {Promise<unknown>}
 */
async function defaultPublishNotification(notification, dataDir) {
  const { publishNotification } = await import('../notifications/notification-store.js');
  const root = text(dataDir);
  const options = root ? { storePath: path.join(root, 'notification-center.json') } : {};
  return publishNotification(notification, options);
}

/**
 * Evaluate enabled alerts, apply the per-period throttle, and deliver the new
 * ones through push + notification centre. Never throws for a provider error.
 *
 * @param {{
 *   dataDir?: unknown,
 *   now?: unknown,
 *   settings?: unknown,
 *   signals?: object,
 *   notify?: (payload: object) => Promise<unknown>|unknown,
 *   publishNotification?: (notification: object, dataDir?: unknown) => Promise<unknown>|unknown,
 * }} [input]
 * @returns {Promise<{ evaluated: number, notified: string[], skipped: number, alerts: object[] }>}
 */
export async function dispatchUsageAlerts(input = {}) {
  const now = nowFrom(input.now);
  const settings = input.settings ? normalizeUsageSettings(input.settings) : getUsageSettings();
  const signals = input.signals || collectUsageAlertSignals({ dataDir: input.dataDir, now });
  const alerts = collectUsageAlerts({ ...signals, settings, now });
  const state = readUsageAlertState(input.dataDir);
  const notify = typeof input.notify === 'function' ? input.notify : defaultBroadcastPush;
  const publish = typeof input.publishNotification === 'function'
    ? input.publishNotification
    : defaultPublishNotification;
  const notified = [];
  for (const alert of alerts) {
    if (!shouldNotifyUsageAlert(state, alert)) continue;
    let delivered = false;
    try {
      await notify(buildUsageAlertPushPayload(alert));
      delivered = true;
    } catch (error) {
      console.warn('[usage-alerts] push failed:', error?.message || error);
    }
    try {
      await publish(buildUsageAlertNotification(alert), input.dataDir);
      delivered = true;
    } catch (error) {
      console.warn('[usage-alerts] notification failed:', error?.message || error);
    }
    // Mark after a successful channel only. A single accepted channel is enough
    // to avoid spamming the operator, while a total failure leaves the period
    // unrecorded so the next maintenance tick retries delivery.
    if (!delivered) continue;
    markUsageAlertNotified(state, alert, now);
    notified.push(alert.kind);
  }
  writeUsageAlertState(input.dataDir, pruneUsageAlertState(state, now));
  return { evaluated: alerts.length, notified, skipped: alerts.length - notified.length, alerts };
}
