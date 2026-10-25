/**
 * Maps harness run/usage payloads onto canonical usage-ledger events.
 *
 * Keep this module free of harness-specific transports: room-kernel and the
 * Cursor SDK WS both call it with their own `record` function so telemetry can
 * be captured (or faked in tests) without double-counting tokens.
 */

import { beginUsageRun, safeRecordUsage } from './usage-ledger.ts';
import { emptyUsageTokens } from './usage-event.js';
import {
  deltaTokens,
  fromClaudeUsage,
  fromCodexUsage,
  fromDeepSeekUsage,
  fromOpenCodeUsage,
  fromMistralUsage,
  fromOpenRouterUsage,
  fromQwenUsage,
  fromSdkUsage,
} from './usage-normalize.js';
import { resolveClaudeResultUsage } from '../agent-harness/claude-event-normalizer.ts';
import { getClaudeAuthMode } from '../claude/claude-auth-mode.ts';
import { isUsageLimitMessage } from '../harness-usage-limits.js';
import { decodeModelValue } from '../model-catalog.js';
import { resolveChildUsageModel, resolveUsageContract } from './usage-contract.js';
import { noteHarnessCacheState } from './cache-state.ts';
import { beginRunEndSnapshot } from './run-end-snapshot.js';

export const HARNESS_PROVIDERS = Object.freeze({
  sdk: 'cursor',
  openrouter: 'openrouter',
  mistral: 'mistral',
  zai: 'other',
  mimo: 'other',
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
 * @param {Record<string, any>} [room]
 * @returns {string}
 */
export function resolveHarnessRole(room) {
  const assignment = String(room?.delegationAssignment || '').trim().toLowerCase();
  return DELEGATION_ROLES.has(assignment) ? assignment : 'chat';
}

/**
 * Strips encoded model parameters (`model::param=value`) for stable grouping.
 *
 * @param {Record<string, any>} [room]
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
 * @param {Record<string, any>} [room]
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
 * @param {Record<string, any>} room
 * @param {Record<string, unknown>} [payload] `sdkPromptStarted` payload with a durable `runId`.
 * @param {{ dataDir?: string, persistRunStart?: boolean, harness?: string }} [ctx]
 */
export function beginHarnessRun(room, payload: Record<string, unknown> = {}, ctx: Partial<{ dataDir?: string, persistRunStart?: boolean, harness?: string }> = {}) {
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
  // The first API call's per-call usage is a property of the run, not of the
  // room; a fresh run must not inherit the previous run's first call.
  room._firstApiCallUsage = null;
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
  room._runOutputTokens = 0;
  room._runOutputSeen = false;
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
  // Codex per-call usage seen on this run (fallback when `turn.completed` never arrives).
  room._codexCallUsage = null;
  // OpenCode tracks cumulative tokens per assistant message across a run.
  room._openCodeTokensByMessageId = null;
  beginRunEndSnapshot(room, {
    runId,
    sessionId: sourceSessionId,
    startedAt: room._runStartedAt,
  });
}

const FIRST_OUTPUT_EVENT_TYPES = new Set(['assistant', 'thinking', 'text', 'tool_call']);

function hasAssistantText(value) {
  if (typeof value === 'string') return value.length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((block) => (
    typeof block === 'string'
      ? block.length > 0
      : block && typeof block === 'object'
        && (block.type == null || block.type === 'text')
        && typeof block.text === 'string'
        && block.text.length > 0
  ));
}

/**
 * @param {Record<string, any>} room
 * @param {Record<string, unknown>} payload
 */
export function noteHarnessFirstOutput(room, payload) {
  if (!room || !payload || typeof payload !== 'object') return;
  if (!room._runStartedAt) return;
  if (payload.type !== 'sdkEvent') return;
  const event = payload.event;
  if (!event || typeof event !== 'object') return;
  // Any model-produced output counts (message, reasoning, text delta, tool call);
  // bookkeeping events such as status or usage must not.
  if (!room._firstOutputAt && FIRST_OUTPUT_EVENT_TYPES.has(event.type)) {
    room._firstOutputAt = Date.now();
  }
  if (event.type === 'assistant' || event.type === 'text') {
    const content = event.content ?? event.text ?? event.message?.content ?? event.message?.text;
    if (hasAssistantText(content)) {
      room._runOutputSeen = true;
    }
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
 * @param {Record<string, any>} payload
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
 * @param {Record<string, any>} [room]
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
 * @returns {Record<string, any>}
 */
export function resolveHarnessUsageContract(harness) {
  return resolveUsageContract(harness);
}

/**
 * @param {Record<string, any>} [room]
 * @param {string} harness
 * @param {'delta'|'run'} eventType
 * @returns {Record<string, any>}
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
    // A compaction (or any prefix-destroying reset) advances the room's context
    // epoch. Persisting it lets the ledger split cache epochs instead of mixing
    // a cold post-compaction measurement with the warm pre-compaction one.
    ...(room?._contextEpoch == null ? {} : { contextEpoch: room._contextEpoch }),
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
    ...(harness === 'mistral' && ['vibe_code', 'api'].includes(room?._mistralBillingSource)
      ? { billingSource: room._mistralBillingSource }
      : {}),
    ...(harness === 'mistral' && room?._mistralBillingSource === 'vibe_code'
      ? { billingMode: 'subscription', billingClass: 'subscription_quota' }
      : {}),
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
  if (harness === 'mistral') return fromMistralUsage(usage);
  if (harness === 'zai') return fromOpenRouterUsage(usage);
  if (harness === 'mimo') return fromOpenRouterUsage(usage);
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
  const identity: Record<string, string | undefined> = {
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
 * @param {Record<string, any>} [room]
 * @param {string} harness
 * @param {ReturnType<typeof emptyUsageTokens>|null} tokens
 * @param {Record<string, any>} [identity]
 * @returns {Record<string, any>|null}
 */
export function buildHarnessDeltaUsage(room, harness, tokens, identity: Record<string, any> = {}) {
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
 * @param {Record<string, any>} [room]
 * @param {{ final?: boolean, consolidated?: boolean, childSessionId?: string }} [options]
 * @returns {void}
 */
export function noteHarnessRunMeasurement(room, options: Partial<{ final?: boolean, consolidated?: boolean, childSessionId?: string }> = {}) {
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
 * @param {Record<string, any>} [room]
 * @returns {Record<string, any>|null}
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
 * @param {Record<string, any>} [room]
 * @param {string} harness
 * @param {Record<string, any>} payload
 * @returns {Record<string, any>}
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
    ...((harness === 'codex' || harness === 'claude') && payload?.harnessRunPressure && typeof payload.harnessRunPressure === 'object'
      ? { harnessRunPressure: payload.harnessRunPressure }
      : {}),
    latencyMs,
    ttftMs,
    // A run event only proves token coverage when a usage report was actually
    // seen during the run. Without it the run is `missing`, never `complete`.
    measurementPresent,
    ...(coverage ? { coverage } : {}),
    // Qwen only: a run that produced output but never saw provider usage is
    // flagged with the reason, so a missing measurement is explicit, not silent.
    ...((harness === 'qwen' || harness === 'sdk') && !measurementPresent && hasStart && Number.isFinite(firstOutputAt) && firstOutputAt >= startedAt
      ? { usageMissingReason: outcome === 'ok' ? 'provider_reported_no_usage' : `${outcome}_before_usage` }
      : {}),
  };
}

/**
 * Attaches Claude cost metadata to a delta event.
 *
 * - subscription/plan login: the run is prepaid, so `usd` stays null;
 * - API key: use the provider-reported `total_cost_usd` when present, otherwise
 *   fall back to the static rate table in `usage-rates.js`.
 *
 * @param {Record<string, any>} partial
 * @param {string} harness
 * @param {Record<string, any>} event
 * @returns {Record<string, any>}
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
 * Feeds one turn's cache observation into the per-chat cache state. Pure
 * side-channel: it never changes the usage event, and a room without a chatId
 * (or a consolidated child report) is ignored so a child session cannot
 * overwrite the chat's own cache state.
 *
 * @param {Record<string, any>} [room]
 * @param {string} harness
 * @param {ReturnType<typeof emptyUsageTokens>|null} tokens
 * @param {string} [modelOverride]
 * @returns {void}
 */
function noteHarnessCacheObservation(room, harness, tokens, modelOverride = '') {
  if (!room || typeof room !== 'object' || !tokens) return;
  const chatId = String(room.chatId || '').trim();
  if (!chatId) return;
  noteHarnessCacheState({
    chatId,
    harness,
    model: String(modelOverride || resolveTelemetryModel(room) || ''),
    tokens,
    contextEpoch: room._contextEpoch,
  });
}

/**
 * @param {Record<string, any>} [room]
 * @param {string} harness
 * @param {Record<string, any>} event
 * @param {(partial: Record<string, any>) => unknown} [record]
 * @returns {Record<string, any>|null}
 */
export function recordHarnessUsageDelta(room, harness, event, record: (partial: object) => unknown = safeRecordUsage) {
  const tokens = resolveHarnessUsageTokens(harness, event);
  // The cache state mirrors the chat's own turn; a consolidated child report
  // belongs to another session and must not overwrite it.
  if (event?.consolidated !== true) {
    noteHarnessCacheObservation(
      room,
      harness,
      tokens,
      resolveChildUsageModel({ model: event?.model }) || ''
    );
  }
  // A reported usage payload counts as a measurement even when every counter is
  // zero; `buildHarnessDeltaUsage` may still drop the all-zero event, but the
  // run's coverage must remember that usage was reported.
  if (room && typeof room === 'object' && tokens) {
    noteHarnessRunMeasurement(room, {
      final: event?.final === true,
      consolidated: event?.consolidated === true,
      childSessionId: event?.childSessionId || event?.sessionId,
    });
    room._runOutputTokens = Math.max(0, Number(room._runOutputTokens) || 0) + toTokenCount(tokens.textOutput);
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
 * Remembers one Codex API call from a rollout `context_usage` event.
 *
 * Codex reports tokens in the SDK only at `turn.completed`; a run that is
 * stopped earlier (for example right after the final `delegation_reply`) would
 * end with no usage. The rollout watcher still emits one idempotent
 * `context_usage` per call (`measurementId`), kept here as a fallback source.
 *
 * @param {Record<string, any>} room
 * @param {string} harness
 * @param {Record<string, unknown>} event sdkEvent payload
 * @returns {void}
 */
export function noteHarnessCallUsage(room, harness, event) {
  if (harness !== 'codex' || !room || typeof room !== 'object') return;
  if (event?.type !== 'context_usage' || event.reset) return;
  const measurementId = typeof event.measurementId === 'string' ? event.measurementId.trim() : '';
  const usage = event.usage && typeof event.usage === 'object' ? event.usage : null;
  if (!measurementId || !usage) return;
  // A resumed session first replays the preceding call; it belongs to an earlier run.
  const observedMs = Date.parse(String(event.observedAt || ''));
  if (Number.isFinite(room._runStartedAt) && Number.isFinite(observedMs) && observedMs < room._runStartedAt) return;
  if (!(room._codexCallUsage instanceof Map)) room._codexCallUsage = new Map();
  room._codexCallUsage.set(measurementId, {
    usage,
    turnId: typeof event.turnId === 'string' ? event.turnId.trim() : '',
    model: typeof event.model === 'string' ? event.model : '',
  });
}

/**
 * Records the summed per-call Codex usage of a run that reported no usage of
 * its own. No-op when the SDK already delivered a measurement, so a normal run
 * is never counted twice.
 *
 * @param {Record<string, any>} room
 * @param {string} harness
 * @param {(partial: Record<string, any>) => unknown} [record]
 * @returns {Record<string, any>|null}
 */
export function recordHarnessFallbackUsage(room, harness, record: (partial: object) => unknown = safeRecordUsage) {
  if (harness !== 'codex' || !room || typeof room !== 'object') return null;
  if (room._runHadMeasurement === true) return null;
  const calls = room._codexCallUsage instanceof Map ? [...room._codexCallUsage.values()] : [];
  room._codexCallUsage = null;
  if (calls.length === 0) return null;
  const tokens = emptyUsageTokens();
  for (const { usage } of calls) {
    const cached = toTokenCount(usage.cacheReadTokens);
    const written = toTokenCount(usage.cacheWriteTokens);
    tokens.cachedInput += cached;
    tokens.cacheWrite += written;
    tokens.textInput += Math.max(0, toTokenCount(usage.inputTokens) - cached - written);
    tokens.textOutput += toTokenCount(usage.outputTokens);
    tokens.reasoning += toTokenCount(usage.reasoningTokens);
  }
  const last = calls[calls.length - 1];
  // Counts as a partial measurement: covered requests, but no final-usage proof.
  noteHarnessRunMeasurement(room, { final: false });
  room._runOutputTokens = Math.max(0, Number(room._runOutputTokens) || 0) + tokens.textOutput;
  const partial = buildHarnessDeltaUsage(room, harness, tokens, {
    ...(last.turnId ? { turnId: last.turnId } : {}),
    ...(resolveChildUsageModel({ model: last.model }) ? { model: resolveChildUsageModel({ model: last.model }) } : {}),
  });
  if (!partial) return null;
  return record(applyHarnessPricing(partial, harness, { usage: {}, model: last.model }));
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/**
 * Records exactly one run event per started run. Some transports broadcast a
 * synthetic `sdkRunFinished` after an abort/recovery, so a second finish for
 * the same run is ignored. The flag resets in `beginHarnessRun`, which also
 * lets a finish with no matching `sdkPromptStarted` be recorded once.
 *
 * @param {Record<string, any>} [room]
 * @param {string} harness
 * @param {Record<string, any>} payload
 * @param {(partial: Record<string, any>) => unknown} [record]
 * @returns {Record<string, any>|null}
 */
export function recordHarnessRunFinished(room, harness, payload, record: (partial: object) => unknown = safeRecordUsage): any {
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
 * @param {{ authMode?: string }} [options]
 * @returns {{ harness: string, status?: string, utilization?: number, resetsAt?: string, rateLimitType?: string, authMode?: string, source?: string } | null}
 */
export function resolveHarnessPlanLimitSnapshot(harness, payload, options: Partial<{ authMode?: string }> = {}) {
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
  // Claude plan limits exist only under subscription (OAuth) auth. API-key and
  // provider sessions must never be stored or read as a Team/Pro/Max limit.
  let authMode = '';
  if (id === 'claude') {
    authMode = String(options?.authMode || payload.authMode || event.authMode || getClaudeAuthMode())
      .trim().toLowerCase();
    if (authMode !== 'subscription') return null;
  }
  const source = info || event;
  const status = String(source.status ?? '').trim();
  const rateLimitType = String(source.rateLimitType ?? source.rate_limit_type ?? '').trim();
  const utilizationValue = readPlanUtilization(source.utilization);
  // Exactly one conversion per event: only a raw SDK `rate_limit_info` is
  // converted here. A normalized notice (`noticeType: 'rate_limit'`) already
  // went through `buildClaudeRateLimitNotice` and carries percent.
  const isNormalizedNotice = event.noticeType === 'rate_limit' || payload.noticeType === 'rate_limit';
  const utilization = Number.isFinite(utilizationValue)
    ? utilizationValue * (id === 'claude' && info && !isNormalizedNotice ? 100 : 1) : undefined;
  const resetsAt = normalizePlanResetsAt(source.resetsAt);
  if (!status && !rateLimitType && utilization === undefined && !resetsAt) return null;
  return {
    harness: id,
    ...(status ? { status } : {}),
    ...(utilization === undefined ? {} : { utilization }),
    ...(resetsAt ? { resetsAt } : {}),
    ...(rateLimitType ? { rateLimitType } : {}),
    ...(id === 'claude' ? { authMode, source: CLAUDE_PLAN_LIMIT_SOURCE } : {}),
  };
}

/** Provenance label stored on every Claude plan-limit row. */
export const CLAUDE_PLAN_LIMIT_SOURCE = 'claude-sdk-rate-limit-event';

/**
 * @param {unknown} value
 * @returns {number} finite number, or NaN when the reading is absent/invalid
 */
function readPlanUtilization(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * True when a plan-limit snapshot must create a lockout: only an explicit
 * `rejected` on a plan window. `allowed`, `allowed_warning`, a missing status
 * and the `overage` lane (a different meter) stay advisory.
 *
 * @param {{ status?: string, rateLimitType?: string } | null | undefined} snapshot
 * @returns {boolean}
 */
export function isPlanLimitLockout(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (String(snapshot.status || '').trim() !== 'rejected') return false;
  return String(snapshot.rateLimitType || '').trim() !== 'overage';
}

/**
 * Cursor SDK usage snapshots are recorded as a delta against the last snapshot
 * within the same run; `beginHarnessRun` resets that baseline, so consecutive
 * runs never subtract each other's totals.
 *
 * @param {Record<string, any>} [room]
 * @param {string} [harness]
 * @param {Record<string, any>} usage
 * @param {(partial: Record<string, any>) => unknown} [record]
 * @returns {Record<string, any>|null}
 */
export function recordHarnessUsageSnapshot(room, harness = 'sdk', usage, record: (partial: object) => unknown = safeRecordUsage) {
  if (!usage || typeof usage !== 'object') return null;
  if (room && typeof room === 'object') noteHarnessRunMeasurement(room);
  const current = fromSdkUsage(usage);
  if (room && typeof room === 'object') room._runOutputTokens = toTokenCount(current.textOutput);
  const previous = room?._lastRecordedUsageTokens || emptyUsageTokens();
  const tokens = deltaTokens(current, previous);
  if (room && typeof room === 'object') room._lastRecordedUsageTokens = current;
  // Cursor snapshots are cumulative within a run, so the per-turn cache read is
  // the diff (`tokens`), not the cumulative `current`.
  noteHarnessCacheObservation(room, harness, tokens);
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
