/**
 * Claude subscription plan quotas in the same payload shape as Codex plan limits.
 * A live session is asked through the SDK usage request; otherwise the stored
 * rate-limit snapshots (from `rate_limit_event`) are returned.
 */
import { getClaudeAuthMode } from './claude-auth-mode.ts';
import { loadClaudeSdk } from './claude-sdk.ts';
import { noteHarnessPlanLimit, readHarnessPlanLimits } from '../usage/harness-health.ts';

const READ_TIMEOUT_MS = 6000;
const WINDOW_TYPES = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];

interface UsageWindowRaw { utilization?: unknown; resets_at?: unknown }
/** Loose view of `SDKControlGetUsageResponse` (only the fields read here). */
export interface ClaudeUsageResponse {
  rate_limits_available?: unknown;
  rate_limits?: Record<string, UsageWindowRaw | null | undefined> | null;
  subscription_type?: unknown;
}

interface ClaudeLimitWindow {
  harness: string;
  authMode: string;
  source: string;
  observedAt: string;
  rateLimitType: string;
  utilization?: number;
  resetsAt?: string;
}

export interface ClaudeUsageLimits {
  available: true;
  observedAt: string;
  windows: ClaudeLimitWindow[];
  planType: string | null;
}

/** Live query handle: only the experimental usage request is read here. */
interface ClaudeUsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: unknown;
}

function validPercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

/**
 * @param response `SDKControlGetUsageResponse`
 */
export function normalizeClaudeUsageLimits(
  response: ClaudeUsageResponse | null | undefined,
  observedAt: string = new Date().toISOString(),
): ClaudeUsageLimits | null {
  if (!response || response.rate_limits_available !== true || !response.rate_limits) return null;
  const windows: ClaudeLimitWindow[] = [];
  for (const type of WINDOW_TYPES) {
    const window = response.rate_limits[type];
    if (!window || typeof window !== 'object') continue;
    const utilization = validPercent(window.utilization);
    const reset = Date.parse(window.resets_at as string);
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
 * Resolves `reason` to explain a null result.
 */
async function readQueryUsageLimits(query: ClaudeUsageQuery | null | undefined): Promise<{ limits: ClaudeUsageLimits | null; reason: string }> {
  if (!query) return { limits: null, reason: 'no-session' };
  const read = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof read !== 'function') return { limits: null, reason: 'unsupported' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (read as (this: ClaudeUsageQuery, options: { skipBehaviors: boolean }) => unknown).call(query, { skipBehaviors: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), READ_TIMEOUT_MS); }),
    ]);
    const limits = normalizeClaudeUsageLimits(response as ClaudeUsageResponse | null | undefined);
    return { limits, reason: limits ? 'ok' : 'unavailable' };
  } catch (error) {
    return { limits: null, reason: (error as { message?: unknown } | null)?.message === 'timeout' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Stored snapshots reshaped like a live read; marked as not freshly observed. */
export function buildStoredClaudePlanLimits({ dataDir }: { dataDir?: string } = {}) {
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

/** Successful ephemeral reads are reused briefly so repeated panel opens do not spawn the CLI each time. */
const EPHEMERAL_CACHE_MS = 30_000;
let ephemeralCache: { at: number; limits: ClaudeUsageLimits } | null = null;

/**
 * Reads plan limits without a chat session: starts a throwaway SDK query whose
 * prompt never yields (so no model call or tokens), asks it for usage and
 * closes it. Typically ~1 s.
 */
async function readEphemeralUsageLimits(): Promise<{ limits: ClaudeUsageLimits | null; reason: string }> {
  if (ephemeralCache && Date.now() - ephemeralCache.at < EPHEMERAL_CACHE_MS) {
    return { limits: ephemeralCache.limits, reason: 'ok' };
  }
  let release: () => void = () => {};
  const idle = new Promise<void>((resolve) => { release = resolve; });
  let query: (ClaudeUsageQuery & { close?: () => void }) | null = null;
  try {
    const sdk = await loadClaudeSdk();
    query = sdk.query({
      // eslint-disable-next-line require-yield -- keeps the prompt stream open until the usage read is released
      prompt: (async function* () { await idle; })(),
      options: { cwd: process.cwd() },
    });
    const result = await readQueryUsageLimits(query);
    if (result.limits) ephemeralCache = { at: Date.now(), limits: result.limits };
    return result;
  } catch {
    return { limits: null, reason: 'error' };
  } finally {
    release();
    try { query?.close?.(); } catch { /* already closed */ }
  }
}

export async function getClaudePlanLimits(
  { dataDir, query, allowEphemeral = false }: { dataDir?: string; query?: ClaudeUsageQuery | null; allowEphemeral?: boolean } = {},
) {
  if (getClaudeAuthMode() !== 'subscription') return { available: false, reason: 'api-key' };
  let { limits, reason } = await readQueryUsageLimits(query);
  if (!limits && !query && allowEphemeral) ({ limits, reason } = await readEphemeralUsageLimits());
  if (limits) {
    for (const row of limits.windows) noteHarnessPlanLimit({ ...row, dataDir });
    return { ...limits, liveStatus: 'ok' };
  }
  // The stored events only carry a percentage near a threshold; say why the live read did not run.
  if (reason !== 'no-session') console.warn(`[claude-plan-limits] live read skipped: ${reason}`);
  return { ...buildStoredClaudePlanLimits({ dataDir }), liveStatus: reason };
}
