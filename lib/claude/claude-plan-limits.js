/**
 * Claude subscription plan quotas in the same payload shape as Codex plan limits.
 * A live session is asked through the SDK usage request; otherwise the stored
 * rate-limit snapshots (from `rate_limit_event`) are returned.
 */
import { getClaudeAuthMode } from './claude-auth-mode.js';
import { noteHarnessPlanLimit, readHarnessPlanLimits } from '../usage/harness-health.js';

const READ_TIMEOUT_MS = 6000;
const WINDOW_TYPES = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];

function validPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

/**
 * @param {object|null|undefined} response `SDKControlGetUsageResponse`
 * @param {string} [observedAt]
 */
export function normalizeClaudeUsageLimits(response, observedAt = new Date().toISOString()) {
  if (!response || response.rate_limits_available !== true || !response.rate_limits) return null;
  const windows = [];
  for (const type of WINDOW_TYPES) {
    const window = response.rate_limits[type];
    if (!window || typeof window !== 'object') continue;
    const utilization = validPercent(window.utilization);
    const reset = Date.parse(window.resets_at);
    windows.push({
      harness: 'claude', authMode: 'subscription', source: 'claude-sdk-usage', observedAt, rateLimitType: type,
      ...(utilization === undefined ? {} : { utilization }),
      ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
    });
  }
  return {
    available: true, observedAt, windows,
    planType: typeof response.subscription_type === 'string' ? response.subscription_type : null,
  };
}

/**
 * Ask a live query for plan limits; never throws and never outlives the timeout.
 * @returns {Promise<{ limits: object|null, reason: string }>} reason explains a null result
 */
async function readQueryUsageLimits(query) {
  if (!query) return { limits: null, reason: 'no-session' };
  const read = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof read !== 'function') return { limits: null, reason: 'unsupported' };
  let timer;
  try {
    const response = await Promise.race([
      read.call(query, { skipBehaviors: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), READ_TIMEOUT_MS); }),
    ]);
    const limits = normalizeClaudeUsageLimits(response);
    return { limits, reason: limits ? 'ok' : 'unavailable' };
  } catch (error) {
    return { limits: null, reason: error?.message === 'timeout' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Stored snapshots reshaped like a live read; marked as not freshly observed. */
export function buildStoredClaudePlanLimits({ dataDir } = {}) {
  const rows = readHarnessPlanLimits('claude', { dataDir }).filter((row) => row.rateLimitType && !row.scopeMismatch);
  if (!rows.length) return { available: false, reason: 'no-data' };
  return {
    available: true, stored: true,
    observedAt: rows.map((row) => row.observedAt).sort().pop() || null,
    planType: null,
    windows: rows.map((row) => ({
      rateLimitType: row.rateLimitType,
      ...(typeof row.utilization === 'number' ? { utilization: row.utilization } : {}),
      ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}),
      ...(row.status ? { status: row.status } : {}),
      observedAt: row.observedAt,
    })),
  };
}

/**
 * @param {{ dataDir?: string, query?: object|null }} [input]
 */
export async function getClaudePlanLimits({ dataDir, query } = {}) {
  if (getClaudeAuthMode() !== 'subscription') return { available: false, reason: 'api-key' };
  const { limits, reason } = await readQueryUsageLimits(query);
  if (limits) {
    for (const row of limits.windows) noteHarnessPlanLimit({ ...row, dataDir });
    return { ...limits, liveStatus: 'ok' };
  }
  // The stored events only carry a percentage near a threshold; say why the live read did not run.
  if (reason !== 'no-session') console.warn(`[claude-plan-limits] live read skipped: ${reason}`);
  return { ...buildStoredClaudePlanLimits({ dataDir }), liveStatus: reason };
}
