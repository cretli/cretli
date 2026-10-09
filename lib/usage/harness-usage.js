/**
 * Maps harness run/usage payloads onto canonical usage-ledger events.
 *
 * Keep this module free of harness-specific transports: room-kernel and the
 * Cursor SDK WS both call it with their own `record` function so telemetry can
 * be captured (or faked in tests) without double-counting tokens.
 */

import { beginUsageRun, safeRecordUsage } from './usage-ledger.js';
import { emptyUsageTokens } from './usage-event.js';
import {
  deltaTokens,
  fromClaudeUsage,
  fromCodexUsage,
  fromDeepSeekUsage,
  fromOpenCodeUsage,
  fromOpenRouterUsage,
  fromQwenUsage,
  fromSdkUsage,
} from './usage-normalize.js';
import { resolveClaudeResultUsage } from '../agent-harness/claude-event-normalizer.js';
import { getClaudeAuthMode } from '../claude/claude-auth-mode.js';
import { isUsageLimitMessage } from '../harness-usage-limits.js';
import { decodeModelValue } from '../model-catalog.js';
import { resolveChildUsageModel, resolveUsageContract } from './usage-contract.js';

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
 * Durable snapshot baseline key from the granularity matrix: harness +
 * run + attempt + source session + turn + context epoch. A new run (or an
 * explicit epoch/reset) produces a new key, so a reconnect never subtracts the
 * previous run's totals; an out-of-order snapshot keeps the committed baseline.
 *
 * @param {object} [room]
 * @param {string} harness
 * @returns {string}
 */
export function buildHarnessBaselineKey(room, harness) {
  const runId = String(room?._runId || '').trim();
  const attemptId = String(room?.delegationAttemptId || '').trim();
  const sessionId = String(resolveHarnessSourceSessionId(room) || '').trim();
  const turnId = String(room?._currentTurnId || '').trim();
  const epoch = room?._contextEpoch == null ? '' : String(room._contextEpoch);
  return JSON.stringify(['baseline', harness, runId, attemptId, sessionId, turnId, epoch]);
}

/**
 * @param {object} room
 * @param {Record<string, unknown>} [payload] `sdkPromptStarted` payload with a durable `runId`.
 * @param {{ dataDir?: string, persistRunStart?: boolean, harness?: string }} [ctx]
 */
export function beginHarnessRun(room, payload = {}, ctx = {}) {
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
  // Logical identity + coverage: the run id is durable only when the transport
  // supplies it; `_runHadMeasurement` starts false so an ended run with no
  // usage is reported as `missing`, not silently complete.
  let runId = payload && typeof payload.runId === 'string' && payload.runId.trim()
    ? payload.runId.trim()
    : null;
  // Must match `resolveHarnessSourceSessionId` exactly, otherwise run-start and
  // the measurements would derive different run keys and double count the run.
  const sourceSessionId = payload && typeof payload.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : (resolveHarnessSourceSessionId(room) || null);
  // Persist the run-start (and mint a durable runId when the transport has
  // none) BEFORE the harness launch records any measurement. The persistence
  // seam is opt-in so pure unit callers stay side-effect free.
  if (ctx.persistRunStart === true) {
    try {
      const persisted = beginUsageRun(
        {
          harness: ctx.harness || room.transport || '',
          runId,
          attemptId: room.delegationAttemptId,
          sourceSessionId,
          chatId: room.chatId,
          role: resolveHarnessRole(room),
          model: resolveTelemetryModel(room),
        },
        { dataDir: ctx.dataDir }
      );
      if (persisted?.runId) runId = persisted.runId;
    } catch (error) {
      // Telemetry must never break a harness run.
      console.error('[usage] run-start persist failed', error instanceof Error ? error.message : error);
    }
  }
  room._runId = runId;
  room._runHadMeasurement = false;
  // Coverage state for the run event. `proof` only becomes true when the
  // transport explicitly marks a usage report as the final run summary
  // (`event.final === true`, e.g. a Claude `result`), so a lone delta never
  // turns a run into `complete`.
  room._runUsageReports = 0;
  room._runCoveredRequests = 0;
  room._runCoverageProof = false;
  room._runConsolidated = false;
  room._runCoveredChildSessions = new Set();
  room._runExpectedChildren = 0;
  room._runSourceSessionId = sourceSessionId;
  // OpenCode tracks cumulative tokens per assistant message across a run.
  room._openCodeTokensByMessageId = null;
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
 * Durable harness session id used for logical event identity and resume/reset.
 *
 * @param {object} [room]
 * @returns {string|undefined}
 */
export function resolveHarnessSourceSessionId(room) {
  const candidate = String(
    room?._runSourceSessionId
      || room?.sourceSessionId
      || room?.opencodeSessionId
      || room?.codebuddySessionId
      || room?.sessionId
      || room?.sessionKey
      || ''
  ).trim();
  return candidate || undefined;
}

/**
 * Contract descriptor for a harness at the adapter boundary (shape, granularity,
 * cache/reasoning semantics). Adapters should read this instead of assuming.
 *
 * @param {string} harness
 * @returns {object}
 */
export function resolveHarnessUsageContract(harness) {
  return resolveUsageContract(harness);
}

/**
 * @param {object} [room]
 * @param {string} harness
 * @param {'delta'|'run'} eventType
 * @returns {object}
 */
function baseUsagePartial(room, harness, eventType) {
  const contract = resolveUsageContract(harness);
  return {
    provider: resolveHarnessProvider(harness),
    harness,
    role: resolveHarnessRole(room),
    eventType,
    feature: 'chat',
    model: resolveTelemetryModel(room),
    chatId: room?.chatId ? String(room.chatId) : undefined,
    // The watcher stamps the cycle on its orchestrator room; a plain chat or a
    // delegated child has no cycle id (children are linked by delegation ids).
    cycleId: room?.watcherCycleId ? String(room.watcherCycleId) : undefined,
    delegationId: room?.delegationId ? String(room.delegationId) : undefined,
    attemptId: room?.delegationAttemptId ? String(room.delegationAttemptId) : undefined,
    // Durable identity inputs are only present when the transport supplied them.
    runId: room?._runId ? String(room._runId) : undefined,
    sourceSessionId: resolveHarnessSourceSessionId(room),
    // Contract descriptor carried across the adapter boundary so consumers do
    // not have to re-resolve the harness shape from the payload.
    usageShape: contract.usageShape ?? undefined,
    measurementKind: contract.measurementKind ?? undefined,
    granularity: contract.granularity ?? undefined,
    inputIncludesCache: contract.payloadInputIncludesCache ?? null,
    reasoningRelation: contract.reasoningRelation,
    // Harness usage is provider-reported; the contract records it so the
    // reported/estimated/unknown distinction is explicit on the event.
    provenance: contract.supported ? 'reported' : 'unknown',
    accountingScope: room?.delegationAccountingScope === 'consolidated'
      ? 'consolidated'
      : 'own',
    source: 'server',
  };
}

/**
 * True when a usage payload is already the resolved Claude camelCase bag
 * (`inputTokens`/`cacheReadTokens`/...), as opposed to raw provider snake_case.
 *
 * @param {unknown} usage
 * @returns {boolean}
 */
export function isResolvedClaudeUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  return usage.inputTokens != null
    || usage.outputTokens != null
    || usage.cacheReadTokens != null
    || usage.cacheWriteTokens != null;
}

/**
 * Token bag for one usage event, or null when the harness streams no tokens.
 *
 * The Claude adapter boundary is explicitly `resolved` camelCase (the room sees
 * the output of `claude-event-normalizer.js#resolveClaudeResultUsage`); CodeBuddy
 * stays `raw` snake_case. Branching on the declared contract shape keeps the two
 * from being normalized twice.
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
    // Resolved camelCase is used as-is; the raw resolver would add cache back
    // and then lose it because the resolved payload has no snake_case keys.
    if (isResolvedClaudeUsage(usage)) return fromClaudeUsage(usage);
    const resolved = resolveClaudeResultUsage(event);
    return resolved ? fromClaudeUsage(resolved) : null;
  }
  if (harness === 'codex') return fromCodexUsage(usage);
  if (harness === 'deepseek') return fromDeepSeekUsage(usage);
  if (harness === 'openrouter') return fromOpenRouterUsage(usage);
  if (harness === 'sdk') return fromSdkUsage(usage);
  if (harness === 'qwen') return fromQwenUsage(usage);
  if (harness === 'opencode') return fromOpenCodeUsage(usage?.tokens);
  if (harness === 'codebuddy') {
    // CodeBuddy delivers raw snake_case at this boundary; keep resolving it.
    const resolved = resolveClaudeResultUsage(event);
    return resolved ? fromClaudeUsage(resolved) : null;
  }
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
 * Extracts the source ids a harness attaches to one usage measurement. Only
 * ids actually present in the payload are used; token counts, timestamps and
 * token hashes are never identity.
 *
 * @param {string} harness
 * @param {Record<string, any>} event
 * @returns {{ requestId?: string, messageId?: string, turnId?: string, eventId?: string, providerEventId?: string }}
 */
export function resolveHarnessEventIdentity(harness, event) {
  if (!event || typeof event !== 'object') return {};
  const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
  const source = event.identity && typeof event.identity === 'object' ? event.identity : {};
  const pick = (...values) => {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return undefined;
  };
  const identity = {
    requestId: pick(source.requestId, event.requestId, event.request_id, usage.requestId),
    messageId: pick(source.messageId, event.messageId, event.message_id, usage.messageId),
    turnId: pick(source.turnId, event.turnId, event.turn_id, usage.turnId),
    eventId: pick(source.eventId, event.eventId, event.event_id),
  };
  if (harness === 'openrouter') {
    identity.providerEventId = pick(source.providerEventId, event.providerEventId, event.providerId);
  }
  return Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined));
}

/**
 * @param {object} [room]
 * @param {string} harness
 * @param {ReturnType<typeof emptyUsageTokens>|null} tokens
 * @param {object} [identity]
 * @returns {object|null}
 */
export function buildHarnessDeltaUsage(room, harness, tokens, identity = {}) {
  if (!hasUsageTokens(tokens)) return null;
  return { ...baseUsagePartial(room, harness, 'delta'), ...identity, tokens };
}

/**
 * Records one observed usage report against the current run. Coverage counts
 * only real reports; a `final` report additionally proves the run's coverage.
 * Consolidated (child) reports are tracked per child session so an incomplete
 * child set stays visible in the run coverage.
 *
 * Late-measurement handling (stage 3 / `2d05fded`): this updates the run's
 * in-memory coverage. When a credible measurement arrives **after**
 * `recordHarnessRunFinished` already persisted the run event, the durable ledger
 * records the token delta and, inside the 24 h `canAwaitFinalUsage` window,
 * corrects the ended run's coverage with `applyUsageCoverageCorrection` —
 * without ever adding a second run event. Past the window the measurement is
 * kept as a `stale` diagnostic instead of being counted again.
 *
 * @param {object} [room]
 * @param {{ final?: boolean, consolidated?: boolean, childSessionId?: string }} [options]
 * @returns {void}
 */
export function noteHarnessRunMeasurement(room, options = {}) {
  if (!room || typeof room !== 'object') return;
  room._runHadMeasurement = true;
  room._runUsageReports = (Number(room._runUsageReports) || 0) + 1;
  room._runCoveredRequests = room._runUsageReports;
  if (options.final === true) room._runCoverageProof = true;
  if (options.consolidated === true) {
    room._runConsolidated = true;
    if (!(room._runCoveredChildSessions instanceof Set)) room._runCoveredChildSessions = new Set();
    const childId = String(options.childSessionId || '').trim();
    if (childId) room._runCoveredChildSessions.add(childId);
  }
}

/**
 * Coverage block for the current run, or null when no usage was reported.
 * `proof` requires the transport's final-usage marker; consolidated runs also
 * require every known child session to have reported usage.
 *
 * @param {object} [room]
 * @returns {object|null}
 */
export function resolveHarnessRunCoverage(room) {
  if (!room || typeof room !== 'object' || room._runHadMeasurement !== true) return null;
  const consolidated = room._runConsolidated === true;
  const expectedRequests = Math.max(0, Number(room._runUsageReports) || 0);
  const coveredRequests = Math.max(0, Number(room._runCoveredRequests) || expectedRequests);
  const expectedChildren = consolidated
    ? Math.max(0, Number(room._runExpectedChildren) || 0)
    : undefined;
  const coveredChildren = consolidated
    ? (room._runCoveredChildSessions instanceof Set ? room._runCoveredChildSessions.size : 0)
    : undefined;
  const childrenComplete = !consolidated || coveredChildren >= expectedChildren;
  return {
    proof: room._runCoverageProof === true && childrenComplete,
    expectedRequests,
    coveredRequests,
    scope: consolidated ? 'consolidated' : 'own',
    ...(consolidated ? { expectedChildren, coveredChildren } : {}),
  };
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
  const base = baseUsagePartial(room, harness, 'run');
  const payloadRunId = String(payload?.runId ?? '').trim();
  const measurementPresent = room?._runHadMeasurement === true;
  const coverage = resolveHarnessRunCoverage(room);
  return {
    ...base,
    ...(payloadRunId ? { runId: payloadRunId } : {}),
    outcome,
    errorCode: resolveHarnessErrorCode(payload, outcome),
    latencyMs,
    ttftMs,
    // A run event only proves token coverage when a usage report was actually
    // seen during the run. Without it the run is `missing`, never `complete`.
    measurementPresent,
    ...(coverage ? { coverage } : {}),
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
  // A reported usage payload counts as a measurement even when every counter is
  // zero; `buildHarnessDeltaUsage` may still drop the all-zero event, but the
  // run's coverage must remember that usage was reported.
  if (room && typeof room === 'object' && tokens) {
    noteHarnessRunMeasurement(room, {
      final: event?.final === true,
      consolidated: event?.consolidated === true,
      childSessionId: event?.childSessionId || event?.sessionId,
    });
  }
  const partial = buildHarnessDeltaUsage(
    room,
    harness,
    tokens,
    {
      ...resolveHarnessEventIdentity(harness, event),
      // A `final` report is the run's coverage proof. It reaches the durable
      // ledger as a store hint (it is not a canonical event field), so a late
      // final measurement can still correct the ended run's coverage.
      ...(event?.final === true ? { final: true } : {}),
      // A child measurement carries its own model in the payload; never inherit
      // the parent's room model for someone else's tokens.
      ...(resolveChildUsageModel({ model: event?.model }) ? { model: resolveChildUsageModel({ model: event?.model }) } : {}),
      ...(event?.consolidated === true ? { accountingScope: 'consolidated' } : {}),
    }
  );
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
  if (room && typeof room === 'object') noteHarnessRunMeasurement(room);
  const current = fromSdkUsage(usage);
  const previous = room?._lastRecordedUsageTokens || emptyUsageTokens();
  const tokens = deltaTokens(current, previous);
  if (room && typeof room === 'object') room._lastRecordedUsageTokens = current;
  // The in-memory delta keeps the stream fast; the durable `baselineKey` +
  // `snapshotTokens` let the ledger recompute the same delta against the
  // committed baseline, so a restart or an out-of-order snapshot never counts
  // the cumulative value twice.
  const partial = buildHarnessDeltaUsage(room, harness, tokens, {
    baselineKey: buildHarnessBaselineKey(room, harness),
    snapshotTokens: current,
  });
  if (!partial) return null;
  return record(partial);
}
