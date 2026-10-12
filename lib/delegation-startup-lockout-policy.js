/**
 * Timing policy for harness/model startup-failure lockouts and delegated
 * OpenCode first-event timeouts. Kept free of harness-usage-limits imports so
 * the lockout store can import these resolvers without a cycle.
 */

import { loadSettings } from './persist/settings.js';

/** Lockout reason code stored in the shared harness usage-limit row. */
export const STARTUP_FAILURE_LOCKOUT_CODE = 'startup_failure';

const DEFAULT_LOCKOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_EXTENDED_LOCKOUT_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DELEGATED_FIRST_EVENT_MS = 2 * 60 * 1000;
const MIN_FIRST_EVENT_MS = 30 * 1000;
const MAX_FIRST_EVENT_MS = 30 * 60 * 1000;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function readPositiveMs(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed === 0) return 0;
  return parsed > 0 ? parsed : fallback;
}

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isStartupFailureLockoutCode(code) {
  return String(code || '').trim().toLowerCase() === STARTUP_FAILURE_LOCKOUT_CODE;
}

/**
 * @param {object} row
 * @returns {boolean}
 */
export function isStartupFailureLockoutRow(row) {
  return isStartupFailureLockoutCode(row?.code);
}

/**
 * Base startup lockout duration. `0` disables new lockouts.
 *
 * @returns {number}
 */
export function resolveStartupFailureLockoutMs() {
  const fromEnv = readPositiveMs(process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS, DEFAULT_LOCKOUT_MS);
  if (fromEnv === 0) return 0;
  const settings = loadSettings();
  const fromSettings = readPositiveMs(settings.startupFailureLockoutMs, fromEnv);
  return fromSettings === 0 ? 0 : fromSettings;
}

/**
 * @returns {number}
 */
export function resolveStartupFailureExtendedLockoutMs() {
  const fromEnv = readPositiveMs(
    process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_EXTENDED_MS,
    DEFAULT_EXTENDED_LOCKOUT_MS,
  );
  const settings = loadSettings();
  const fromSettings = readPositiveMs(settings.startupFailureLockoutExtendedMs, fromEnv);
  return fromSettings > 0 ? fromSettings : DEFAULT_EXTENDED_LOCKOUT_MS;
}

/**
 * @returns {number}
 */
export function resolveStartupFailureEscalationWindowMs() {
  const fromEnv = readPositiveMs(
    process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_ESCALATION_MS,
    DEFAULT_ESCALATION_WINDOW_MS,
  );
  const settings = loadSettings();
  const fromSettings = readPositiveMs(settings.startupFailureLockoutEscalationMs, fromEnv);
  return fromSettings > 0 ? fromSettings : DEFAULT_ESCALATION_WINDOW_MS;
}

/**
 * @param {object} [input]
 * @param {boolean} [input.repeatedWithinWindow]
 * @returns {number}
 */
export function resolveStartupFailureLockoutDurationMs(input = {}) {
  const baseMs = resolveStartupFailureLockoutMs();
  if (baseMs === 0) return 0;
  if (input.repeatedWithinWindow === true) {
    return resolveStartupFailureExtendedLockoutMs();
  }
  return baseMs;
}

/**
 * OpenCode first-event timeout for delegated runs only.
 *
 * @returns {number}
 */
export function resolveOpenCodeDelegatedFirstEventTimeoutMs() {
  const fromEnv = readPositiveMs(
    process.env.OPENCODE_DELEGATED_FIRST_EVENT_TIMEOUT_MS,
    DEFAULT_DELEGATED_FIRST_EVENT_MS,
  );
  const settings = loadSettings();
  const fromSettingsSec = readPositiveMs(settings.delegatedSdkRunFirstEventTimeoutSeconds, 0);
  const fromSettingsMs = fromSettingsSec > 0 ? fromSettingsSec * 1000 : fromEnv;
  return Math.min(MAX_FIRST_EVENT_MS, Math.max(MIN_FIRST_EVENT_MS, fromSettingsMs));
}
