/**
 * Periodic usage telemetry maintenance.
 *
 * Runs at server startup and then on fixed intervals:
 *   1. journal retention (`pruneUsageJournal` + ledger key pruning),
 *   2. optional usage alerts (plan window / lockout / budget).
 *
 * Alerts are polled more often than retention so a plan window crossing or a
 * fresh lockout is surfaced promptly, while the alert state file still makes
 * each crossing notify at most once per period. Both steps are best effort: a
 * failure is logged and never breaks the server.
 */

import { getUsageSettings, normalizeUsageSettings } from './usage-settings.js';
import { runUsageRetention } from './usage-retention.js';
import { dispatchUsageAlerts } from './usage-alerts.js';

/** Journal/key retention changes slowly; six hours is plenty. */
export const USAGE_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Alert polling cadence; the per-period throttle prevents spam. */
export const USAGE_ALERT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @param {{ dataDir?: unknown, settings?: unknown }} [input]
 * @returns {object|null}
 */
export function runUsageRetentionMaintenance(input = {}) {
  const settings = input.settings ? normalizeUsageSettings(input.settings) : getUsageSettings();
  try {
    return runUsageRetention({ dataDir: input.dataDir, settings });
  } catch (error) {
    console.warn('[usage-maintenance] retention failed:', error?.message || error);
    return null;
  }
}

/**
 * @param {{ dataDir?: unknown, settings?: unknown, now?: unknown }} [input]
 * @returns {Promise<object|null>}
 */
export async function runUsageAlertsMaintenance(input = {}) {
  const settings = input.settings ? normalizeUsageSettings(input.settings) : getUsageSettings();
  try {
    return await dispatchUsageAlerts({ dataDir: input.dataDir, now: input.now, settings });
  } catch (error) {
    console.warn('[usage-maintenance] alerts failed:', error?.message || error);
    return null;
  }
}

/**
 * Run both maintenance steps once (startup / tests).
 *
 * @param {{ dataDir?: unknown, now?: unknown, settings?: unknown }} [input]
 * @returns {Promise<{ retention: object|null, alerts: object|null }>}
 */
export async function runUsageMaintenance(input = {}) {
  const settings = input.settings ? normalizeUsageSettings(input.settings) : getUsageSettings();
  return {
    retention: runUsageRetentionMaintenance({ dataDir: input.dataDir, settings }),
    alerts: await runUsageAlertsMaintenance({ dataDir: input.dataDir, now: input.now, settings }),
  };
}

/**
 * Start the maintenance loops. Returns a stop function (also used by tests).
 * The first run of each loop is deferred so startup never blocks on the ledger
 * lock or the journal scan.
 *
 * @param {{ dataDir?: unknown, retentionIntervalMs?: number, alertIntervalMs?: number }} [input]
 * @returns {() => void}
 */
export function startUsageMaintenance(input = {}) {
  const retentionIntervalMs = Number.isFinite(Number(input.retentionIntervalMs)) && Number(input.retentionIntervalMs) > 0
    ? Number(input.retentionIntervalMs)
    : USAGE_RETENTION_INTERVAL_MS;
  const alertIntervalMs = Number.isFinite(Number(input.alertIntervalMs)) && Number(input.alertIntervalMs) > 0
    ? Number(input.alertIntervalMs)
    : USAGE_ALERT_INTERVAL_MS;
  const timers = [];
  const schedule = (fn, delayMs) => {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    timers.push(timer);
    return timer;
  };
  const startLoop = (fn, intervalMs) => {
    schedule(fn, 0);
    const timer = setInterval(fn, intervalMs);
    timer.unref?.();
    timers.push(timer);
  };
  startLoop(() => {
    runUsageRetentionMaintenance({ dataDir: input.dataDir });
  }, retentionIntervalMs);
  startLoop(() => {
    void runUsageAlertsMaintenance({ dataDir: input.dataDir });
  }, alertIntervalMs);
  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
