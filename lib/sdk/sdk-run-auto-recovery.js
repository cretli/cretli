import { readEnvAlias } from '../env-alias.js';

/**
 * Auto-recovery for SDK runs stuck in setup or waiting for stream events.
 * Enabled by default; disable with CRETLI_SDK_RUN_AUTO_RECOVERY=0.
 */

export const SDK_RUN_AUTO_RECOVERY_GRACE_MS = 60000;
export const SDK_RUN_AUTO_RECOVERY_MAX_RETRIES = 1;
/** Max idle wait before auto-recovery, regardless of sdkRunIdleTimeoutSeconds. */
export const SDK_RUN_STUCK_RECOVERY_CAP_MS = 120000;

/**
 * @returns {boolean}
 */
export function isSdkRunAutoRecoveryEnabled() {
  return resolveSdkRunAutoRecoveryEnabled(null);
}

/**
 * @param {{ sdkRunAutoRecovery?: boolean } | null | undefined} settings
 * @returns {boolean}
 */
export function resolveSdkRunAutoRecoveryEnabled(settings) {
  const env = readEnvAlias({ current: 'CRETLI_SDK_RUN_AUTO_RECOVERY', legacy: 'CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY' });
  if (env === '0' || env === 'false') return false;
  if (env === '1' || env === 'true') return true;
  if (settings && settings.sdkRunAutoRecovery === false) return false;
  return true;
}

/**
 * @returns {boolean}
 */
export function isSdkRunAutoRecoveryForcedByEnv() {
  const env = readEnvAlias({ current: 'CRETLI_SDK_RUN_AUTO_RECOVERY', legacy: 'CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY' });
  return env === '0' || env === 'false' || env === '1' || env === 'true';
}

/**
 * @param {unknown} rawValue
 * @returns {number}
 */
export function resolveSdkRunAutoRecoveryGraceMs(rawValue) {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return SDK_RUN_AUTO_RECOVERY_GRACE_MS;
  }
  return parsed;
}

/**
 * @param {unknown} rawValue
 * @param {{ sdkRunStuckRecoveryCapSeconds?: number } | null | undefined} [settings]
 * @returns {number}
 */
export function resolveSdkRunStuckRecoveryCapMs(rawValue, settings = null) {
  const fromSettings = Number.parseInt(String(settings?.sdkRunStuckRecoveryCapSeconds ?? ''), 10);
  if (Number.isFinite(fromSettings) && fromSettings > 0) {
    return fromSettings * 1000;
  }
  const fromEnv = Number.parseInt(String(rawValue ?? readEnvAlias({ current: 'CRETLI_SDK_RUN_STUCK_RECOVERY_CAP_MS', legacy: 'CURSOR_REMOTE_SDK_RUN_STUCK_RECOVERY_CAP_MS' }) ?? ''), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return SDK_RUN_STUCK_RECOVERY_CAP_MS;
}

/**
 * @param {number} idleForMs
 * @param {number} budgetMs
 * @param {number} [graceMs]
 * @returns {boolean}
 */
export function shouldTriggerStuckRunRecovery(idleForMs, budgetMs, graceMs = SDK_RUN_AUTO_RECOVERY_GRACE_MS, settings = null) {
  if (!resolveSdkRunAutoRecoveryEnabled(settings)) return false;
  if (!Number.isFinite(idleForMs) || idleForMs <= 0) return false;
  const safeGrace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : SDK_RUN_AUTO_RECOVERY_GRACE_MS;
  const capMs = resolveSdkRunStuckRecoveryCapMs(null, settings);
  const safeBudget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : capMs;
  const effectiveBudget = Math.min(safeBudget, capMs);
  if (effectiveBudget <= 0) return false;
  return idleForMs >= effectiveBudget + safeGrace;
}

/**
 * @param {number} idleForMs
 * @param {number} budgetMs
 * @returns {string}
 */
export function buildStuckRunRecoveryMessage(idleForMs, budgetMs) {
  const idleSeconds = Math.max(1, Math.round(idleForMs / 1000));
  const budgetSeconds = Math.max(1, Math.round(budgetMs / 1000));
  return `Run exceeded idle budget (${idleSeconds}s / ${budgetSeconds}s). Auto-recovery triggered.`;
}

/**
 * @param {number} retryCount
 * @returns {boolean}
 */
export function shouldRetryStuckRunRecovery(retryCount) {
  return Number(retryCount) < SDK_RUN_AUTO_RECOVERY_MAX_RETRIES;
}

/**
 * @param {number} retryAttempt
 * @returns {string}
 */
export function buildStuckRunRecoveryRetryMessage(retryAttempt) {
  return `Stuck run detected — retrying (${retryAttempt}/${SDK_RUN_AUTO_RECOVERY_MAX_RETRIES})…`;
}
