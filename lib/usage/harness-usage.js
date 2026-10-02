/**
 * Maps harness run/usage payloads onto canonical usage-ledger events.
 *
 * Keep this module free of harness-specific transports: room-kernel and the
 * Cursor SDK WS both call it with their own `record` function so telemetry can
 * be captured (or faked in tests) without double-counting tokens.
 */

import { safeRecordUsage } from './usage-ledger.js';
import { emptyUsageTokens } from './usage-event.js';
import {
  deltaTokens,
  fromClaudeUsage,
  fromCodexUsage,
  fromOpenRouterUsage,
  fromSdkUsage,
} from './usage-normalize.js';
import { resolveClaudeResultUsage } from '../agent-harness/claude-event-normalizer.js';
import { getClaudeAuthMode } from '../claude/claude-auth-mode.js';
import { isUsageLimitMessage } from '../harness-usage-limits.js';
import { decodeModelValue } from '../model-catalog.js';

export const HARNESS_PROVIDERS = Object.freeze({
  sdk: 'cursor',
  openrouter: 'openrouter',
});

const DELEGATION_ROLES = new Set(['plan', 'implement', 'review', 'fix']);

/**
 * @param {string} harness
 * @returns {string}
 */
export function resolveHarnessProvider(harness) {
  return HARNESS_PROVIDERS[harness] || 'other';
}

/**
 * @param {object} [room]
 * @returns {string}
 */
export function resolveHarnessRole(room) {
  const assignment = String(room?.delegationAssignment || '').trim().toLowerCase();
  return DELEGATION_ROLES.has(assignment) ? assignment : 'chat';
}

/**
 * Strips encoded model parameters (`model::param=value`) for stable grouping.
 *
 * @param {object} [room]
 * @returns {string}
 */
export function resolveTelemetryModel(room) {
  const raw = String(room?.modelId || room?.model || room?._lastRequestedModelId || '').trim();
  if (!raw) return '';
  try {
    const decoded = decodeModelValue(raw);
    return String(decoded?.modelId || raw).trim();
  } catch {
    return raw;
  }
}

/**
 * @param {object} room
 */
export function beginHarnessRun(room) {
  if (!room || typeof room !== 'object') return;
  room._runStartedAt = Date.now();
  room._firstOutputAt = null;
  // A fresh run: no finish recorded yet and no inherited token snapshot.
  // Cursor SDK usage messages are per-turn, so subtracting the previous run's
  // totals would under-count the first snapshot of this run.
  room._runFinishedRecorded = false;
  // A fresh run may send one "agent finished" push again (see agent-finished-push.js).
  room._agentFinishedPushNotified = false;
  room._lastRecordedUsageTokens = null;
  room._lastUsagePayload = null;
}

/**
 * @param {object} room
 * @param {Record<string, unknown>} payload
 */
export function noteHarnessFirstOutput(room, payload) {
  if (!room || !payload || typeof payload !== 'object') return;
  if (!room._runStartedAt || room._firstOutputAt) return;
  if (payload.type !== 'sdkEvent') return;
  const event = payload.event;
  if (!event || typeof event !== 'object') return;
  if (event.type === 'assistant' || event.type === 'thinking') {
    room._firstOutputAt = Date.now();
  }
}

/**
 * @param {unknown} room
 */
function resetHarnessRun(room) {
  if (!room || typeof room !== 'object') return;
  room._runStartedAt = null;
  room._firstOutputAt = null;
}

/**
 * @param {unknown} status
 * @param {unknown} errorMessage
 * @returns {'ok'|'error'|'limit'|'aborted'}
 */
export function resolveHarnessRunOutcome(status, errorMessage) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'success' || normalized === 'ok' || normalized === 'finished') {
    return 'ok';
  }
  if (
    normalized.includes('cancel')
    || normalized === 'aborted'
    || normalized === 'interrupted'
    || normalized === 'stopped'
  ) {
    return 'aborted';
  }
  if (normalized === 'limit' || isUsageLimitMessage(errorMessage)) return 'limit';
  return 'error';
}

/**
 * @param {object} payload
 * @param {string} outcome
 * @returns {string|undefined}
 */
function resolveHarnessErrorCode(payload, outcome) {
  const explicit = String(payload?.lastErrorCode || '').trim();
  if (explicit) return explicit;
  if (outcome === 'limit') return 'usage_limit';
  if (outcome === 'error') return 'run_error';
  return undefined;
}

/**
 * @param {object} [room]
 * @param {string} harness
 * @param {'delta'|'run'} eventType
 * @returns {object}
 */
function baseUsagePartial(room, harness, eventType) {
  return {
    provider: resolveHarnessProvider(harness),
    harness,
    role: resolveHarnessRole(room),
    eventType,
    feature: 'chat',
    model: resolveTelemetryModel(room),
    chatId: room?.chatId ? String(room.chatId) : undefined,
    delegationId: room?.delegationId ? String(room.delegationId) : undefined,
    attemptId: room?.delegationAttemptId ? String(room.delegationAttemptId) : undefined,
    source: 'server',
  };
}

/**
 * Token bag for one usage event, or null when the harness streams no tokens.
 *
 * @param {string} harness
 * @param {Record<string, any>} event
 * @returns {ReturnType<typeof emptyUsageTokens>|null}
 */
export function resolveHarnessUsageTokens(harness, event) {
  if (!event || typeof event !== 'object') return null;
  const usage = event.usage;
  if (!usage || typeof usage !== 'object') return null;
  if (harness === 'claude') {
    const resolved = resolveClaudeResultUsage(event);
    return resolved ? fromClaudeUsage(resolved) : null;
  }
  if (harness === 'codex') return fromCodexUsage(usage);
  if (harness === 'openrouter') return fromOpenRouterUsage(usage);
  if (harness === 'sdk') return fromSdkUsage(usage);
  return null;
}

/**
 * @param {ReturnType<typeof emptyUsageTokens>|null} tokens
 * @returns {boolean}
 */
export function hasUsageTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return false;
  return Object.values(tokens).some((count) => Number(count) > 0);
}

/**
 * @param {object} [room]
 * @param {string} harness
 * @param {ReturnType<typeof emptyUsageTokens>|null} tokens
 * @returns {object|null}
 */
export function buildHarnessDeltaUsage(room, harness, tokens) {
  if (!hasUsageTokens(tokens)) return null;
  return { ...baseUsagePartial(room, harness, 'delta'), tokens };
}

/**
 * Run events never carry tokens; token deltas already went to their own events.
 *
 * @param {object} [room]
 * @param {string} harness
 * @param {object} payload
 * @returns {object}
 */
export function buildHarnessRunUsage(room, harness, payload) {
  const startedAt = Number(room?._runStartedAt);
  const firstOutputAt = Number(room?._firstOutputAt);
  const hasStart = Number.isFinite(startedAt) && startedAt > 0;
  const latencyMs = hasStart ? Math.max(0, Date.now() - startedAt) : undefined;
  const ttftMs = hasStart && Number.isFinite(firstOutputAt) && firstOutputAt >= startedAt
    ? Math.max(0, firstOutputAt - startedAt)
    : undefined;
  const outcome = resolveHarnessRunOutcome(payload?.status, payload?.lastErrorMessage);
  return {
    ...baseUsagePartial(room, harness, 'run'),
    outcome,
    errorCode: resolveHarnessErrorCode(payload, outcome),
    latencyMs,
    ttftMs,
  };
}

/**
 * Attaches Claude cost metadata to a delta event.
 *
 * - subscription/plan login: the run is prepaid, so `usd` stays null;
 * - API key: use the provider-reported `total_cost_usd` when present, otherwise
 *   fall back to the static rate table in `usage-rates.js`.
 *
 * @param {object} partial
 * @param {string} harness
 * @param {Record<string, any>} event
 * @returns {object}
 */
export function applyHarnessPricing(partial, harness, event) {
  if (!partial || harness !== 'claude') return partial;
  if (getClaudeAuthMode() === 'subscription') {
    return { ...partial, billingMode: 'subscription' };
  }
  const reported = Number(event?.totalCostUsd);
  if (Number.isFinite(reported) && reported >= 0) {
    return { ...partial, reportedUsd: reported };
  }
  return partial;
}

/**
 * @param {object} [room]
 * @param {string} harness
 * @param {Record<string, any>} event
 * @param {(partial: object) => unknown} [record]
 * @returns {object|null}
 */
export function recordHarnessUsageDelta(room, harness, event, record = safeRecordUsage) {
  const tokens = resolveHarnessUsageTokens(harness, event);
  const partial = buildHarnessDeltaUsage(room, harness, tokens);
  if (!partial) return null;
  return record(applyHarnessPricing(partial, harness, event));
}

/**
 * Records exactly one run event per started run. Some transports broadcast a
 * synthetic `sdkRunFinished` after an abort/recovery, so a second finish for
 * the same run is ignored. The flag resets in `beginHarnessRun`, which also
 * lets a finish with no matching `sdkPromptStarted` be recorded once.
 *
 * @param {object} [room]
 * @param {string} harness
 * @param {object} payload
 * @param {(partial: object) => unknown} [record]
 * @returns {object|null}
 */
export function recordHarnessRunFinished(room, harness, payload, record = safeRecordUsage) {
  if (room && typeof room === 'object' && room._runFinishedRecorded === true) return null;
  const partial = buildHarnessRunUsage(room, harness, payload);
  if (room && typeof room === 'object') room._runFinishedRecorded = true;
  resetHarnessRun(room);
  return record(partial);
}

/**
 * Accepts epoch seconds, epoch milliseconds, or an ISO-ish string.
 *
 * @param {unknown} value
 * @returns {string} ISO timestamp or ''
 */
function normalizePlanResetsAt(value) {
  if (value == null || value === '') return '';
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const parsed = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/**
 * Extracts the plan rate-limit snapshot carried by a harness event, if any.
 *
 * Claude SDK `rate_limit_event` / its normalized `rate_limit` notice is the
 * current source. Harnesses that emit no analogous payload return null, so the
 * caller stores "no data" rather than guessing a percentage.
 *
 * @param {string} harness
 * @param {Record<string, any>} payload
 * @returns {{ harness: string, status?: string, utilization?: number, resetsAt?: string, rateLimitType?: string } | null}
 */
export function resolveHarnessPlanLimitSnapshot(harness, payload) {
  const id = String(harness || '').trim().toLowerCase();
  if (!id || !payload || typeof payload !== 'object') return null;
  const event = payload.event && typeof payload.event === 'object' ? payload.event : payload;
  const info = event.rate_limit_info && typeof event.rate_limit_info === 'object'
    ? event.rate_limit_info
    : null;
  const isRateLimitEvent = event.type === 'rate_limit_event'
    || event.noticeType === 'rate_limit'
    || payload.noticeType === 'rate_limit';
  if (!isRateLimitEvent) return null;
  const source = info || event;
  const status = String(source.status ?? '').trim();
  const rateLimitType = String(source.rateLimitType ?? source.rate_limit_type ?? '').trim();
  const utilizationValue = source.utilization == null || source.utilization === '' ? NaN : Number(source.utilization);
  const utilization = Number.isFinite(utilizationValue)
    ? utilizationValue * (id === 'claude' && info ? 100 : 1) : undefined;
  const resetsAt = normalizePlanResetsAt(source.resetsAt);
  if (!status && !rateLimitType && utilization === undefined && !resetsAt) return null;
  return {
    harness: id,
    ...(status ? { status } : {}),
    ...(utilization === undefined ? {} : { utilization }),
    ...(resetsAt ? { resetsAt } : {}),
    ...(rateLimitType ? { rateLimitType } : {}),
  };
}

/**
 * Cursor SDK usage snapshots are recorded as a delta against the last snapshot
 * within the same run; `beginHarnessRun` resets that baseline, so consecutive
 * runs never subtract each other's totals.
 *
 * @param {object} [room]
 * @param {string} [harness]
 * @param {Record<string, any>} usage
 * @param {(partial: object) => unknown} [record]
 * @returns {object|null}
 */
export function recordHarnessUsageSnapshot(room, harness = 'sdk', usage, record = safeRecordUsage) {
  if (!usage || typeof usage !== 'object') return null;
  const current = fromSdkUsage(usage);
  const previous = room?._lastRecordedUsageTokens || emptyUsageTokens();
  const tokens = deltaTokens(current, previous);
  if (room && typeof room === 'object') room._lastRecordedUsageTokens = current;
  const partial = buildHarnessDeltaUsage(room, harness, tokens);
  if (!partial) return null;
  return record(partial);
}
