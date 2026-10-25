/**
 * Contract metadata for usage events that travel through the room (WS) into chat
 * history. The ledger path already carries provenance, scope, completeness and
 * epoch through `createUsageEvent`; this module gives the *history* path the same
 * facts so `summarizeChatHistoryUsage` and the diagnostics read model never have
 * to guess them from raw numbers.
 *
 * The block is additive (`event.usageMeta`) and computed once, at observation
 * time. It never rewrites the raw payload, so billed totals are untouched.
 */
import {
  USAGE_CONTRACT_REVISION,
  assessContextOccupancy,
  buildLogicalUsageIdentity,
  hasTokenMeasurement,
  promptTokensForWindow,
  resolveUsageContract,
  resolveWindowSemantics,
} from './usage-contract.js';
import { resolveHarnessEventIdentity, resolveHarnessSourceSessionId, resolveHarnessUsageTokens } from './harness-usage.ts';

/** Version of the `usageMeta` block persisted on history events. */
export const USAGE_HISTORY_META_VERSION = 1;

type Room = Record<string, any>;
type Rec = Record<string, any>;

const CURRENT_PROMPT_GRANULARITIES = new Set(['request', 'message', 'turn']);

function finiteCount(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

function isoOrNow(value: unknown, now: number): string {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(ms) ? ms : now).toISOString();
}

/**
 * Maps a raw `context_usage` payload onto the canonical token bag so the single
 * `promptTokensForWindow` derivation decides the prompt size. A payload whose
 * input already includes cache is stored cache-exclusive when the bag is
 * disjoint, so the bag relation always matches the contract.
 */
function contextUsageBag(harness: string, usage: Rec): Rec | null {
  const input = finiteCount(usage?.inputTokens);
  if (input == null) return null;
  const contract: Rec = resolveUsageContract(harness);
  const payloadInclusive = contract.payloadInputIncludesCache === true;
  const bagInclusive = contract.bagInputIncludesCache == null
    ? payloadInclusive
    : contract.bagInputIncludesCache === true;
  // An inclusive payload can never hold more cache than its own input.
  const cacheRead = Math.min(finiteCount(usage.cacheReadTokens) ?? 0, payloadInclusive ? input : Infinity);
  const cacheWrite = Math.min(finiteCount(usage.cacheWriteTokens) ?? 0, payloadInclusive ? input - cacheRead : Infinity);
  const textInput = payloadInclusive && !bagInclusive ? input - cacheRead - cacheWrite : input;
  return { textInput, cachedInput: cacheRead, cacheWrite };
}

/** Epoch ms of an adapter-supplied source timestamp, or null when absent/unparseable. */
function sourceTimeMs(event: Rec): number | null {
  for (const raw of [event.sourceObservedAt, event.sourceAt, event.sourceTimestamp]) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Builds the `usageMeta` block for one `usage` / `context_usage` sdk event.
 *
 * - `usage` events are billing-shaped: a single event is never `complete`, and a
 *   run/session granularity or `cumulative` kind is never a current prompt.
 * - `context_usage` events are one call's prompt snapshot (`request`, `snapshot`).
 *   Their session/total counters (`sessionUsage`) are deliberately ignored here.
 *
 * @param room room state (epoch, run and session identity)
 * @param harness transport id
 * @param event raw sdk event (`usage` or `context_usage`)
 * @param now clock override for tests
 */
export function buildUsageHistoryMeta(room: Room | null | undefined, harness: string, event: Rec, now: number = Date.now()): Rec | null {
  if (!event || typeof event !== 'object') return null;
  const isContext = event.type === 'context_usage';
  if (event.type !== 'usage' && !isContext) return null;
  const contract: Rec = resolveUsageContract(harness);
  const supported = contract.supported === true;
  const observedAt = isoOrNow(event.observedAt, now);
  // Epoch precedence: an epoch carried by the event/adapter is authoritative (it
  // can prove an event is late). Otherwise the room epoch at observation time is
  // stamped and labelled as such: it says nothing about when the provider
  // measured, so lateness cannot be detected from it.
  const eventEpoch = event.contextEpoch == null || event.contextEpoch === ''
    ? null
    : (finiteCount(event.contextEpoch) ?? String(event.contextEpoch));
  const epochRaw = room?._contextEpoch;
  const roomEpochKnown = epochRaw != null && epochRaw !== '';
  // A room that never advanced its epoch is implicitly at epoch 0 (the value
  // `advanceRoomContextEpoch` counts from); the source keeps that distinguishable.
  const roomEpoch = roomEpochKnown ? (finiteCount(epochRaw) ?? String(epochRaw)) : 0;
  const contextEpoch = eventEpoch ?? roomEpoch;
  const contextEpochSource = eventEpoch != null ? 'event' : roomEpochKnown ? 'room_at_observation' : 'room_implicit_zero';
  const contextEpochImplicit = contextEpochSource === 'room_implicit_zero';
  const accountingScope = event.consolidated === true ? 'consolidated' : 'own';
  const tokens = isContext ? null : resolveHarnessUsageTokens(harness, event);
  const identity: Rec = { ...resolveHarnessEventIdentity(harness, event) };
  // A bare turn id is a usage identity only where the harness reports one usage per
  // turn; elsewhere several distinct usage events share it and would collapse.
  if (!isContext && contract.granularity !== 'turn') delete identity.turnId;
  const sourceSessionId = resolveHarnessSourceSessionId(room) || null;
  const logical = buildLogicalUsageIdentity({
    harness,
    runId: room?._runId,
    attemptId: room?.delegationAttemptId,
    sourceSessionId,
    measurementType: isContext ? 'context_usage' : 'delta',
    // A call snapshot is identified by its own measurement id; the turn id is
    // shared by every call of the turn and would collapse distinct calls.
    ...(isContext && typeof event.measurementId === 'string' && event.measurementId
      ? { eventId: event.measurementId }
      : identity),
  });

  const granularity = isContext ? 'request' : (contract.granularity ?? null);
  const measurementKind = isContext ? 'snapshot' : (contract.measurementKind ?? null);
  const provenance = supported ? 'reported' : 'unknown';
  // A reported all-zero bag is a measurement; no bag at all is "missing".
  const tokensPresent = isContext ? finiteCount(event.usage?.inputTokens) != null : hasTokenMeasurement(tokens);
  const completeness = !supported ? 'unsupported' : !tokensPresent ? 'missing' : isContext ? 'complete' : 'partial';

  const limitTokens = isContext ? finiteCount(event.contextWindowTokens) : null;
  const contextBag = isContext ? contextUsageBag(harness, event.usage || {}) : null;
  const promptTokens = contextBag ? promptTokensForWindow(contextBag, harness) : null;
  const sourceMs = sourceTimeMs(event);
  const model = typeof (isContext ? event.model : event.lastCallModel ?? event.model) === 'string'
    ? String(isContext ? event.model : event.lastCallModel ?? event.model)
    : null;
  const occupancy = assessContextOccupancy({
    tokens: tokens || undefined,
    promptTokens: isContext ? promptTokens : null,
    contract: harness,
    scope: CURRENT_PROMPT_GRANULARITIES.has(String(granularity)) && measurementKind !== 'cumulative'
      ? 'current_prompt' : 'run_billing',
    granularity,
    measurementKind,
    provenance,
    accountingScope,
    completeness,
    observedAt,
    now: observedAt,
    transport: 'live',
    contextEpoch,
    currentContextEpoch: roomEpoch,
    limitTokens,
  });
  // Freshness is re-evaluated at read time; only structural reasons are stored.
  const reasons = occupancy.reasons.filter((reason: string) => reason !== 'stale_or_unknown_time');

  // Only a per-call prompt snapshot is occupancy. A billing `usage` event is an
  // estimate at best (and nothing at all without a token bag), never a measurement.
  const occupancySource = isContext && promptTokens != null ? 'snapshot' : 'estimated';
  // Where the limit came from: a window carried by the event is the provider's
  // (or an explicit manual/catalog override named by the adapter); none is unknown.
  const declaredLimitSource = String(event.contextWindowSource || '');
  const limitSource = occupancy.limitTokens == null
    ? 'unknown'
    : ['manual', 'catalog'].includes(declaredLimitSource) ? declaredLimitSource : 'provider';
  return {
    metaVersion: USAGE_HISTORY_META_VERSION,
    contractRevision: USAGE_CONTRACT_REVISION,
    harness,
    model,
    provenance,
    accountingScope,
    measurementKind,
    granularity,
    completeness,
    final: event.final === true,
    tokensPresent,
    contextEpoch,
    contextEpochImplicit,
    contextEpochSource,
    observedAt,
    sourceObservedAt: sourceMs == null ? null : new Date(sourceMs).toISOString(),
    runId: room?._runId ? String(room._runId) : null,
    sourceSessionId,
    identityClass: logical.identityClass,
    logicalEventKey: logical.logicalEventKey,
    occupancy: {
      source: occupancySource,
      eligible: reasons.length === 0 && occupancySource === 'snapshot',
      reasons,
      promptTokens: occupancy.promptTokens,
      limitTokens: occupancy.limitTokens,
      limitSource,
    },
  };
}

/**
 * Returns a copy of a usage-shaped sdk event with `usageMeta` attached (idempotent:
 * an event that already carries the block, e.g. a replay, is returned as-is).
 * Other event types pass through untouched.
 */
export function stampUsageHistoryEvent(room: Room | null | undefined, harness: string, event: Rec, now: number = Date.now()): Rec {
  if (!event || typeof event !== 'object') return event;
  if (event.type !== 'usage' && event.type !== 'context_usage') return event;
  if (event.usageMeta && typeof event.usageMeta === 'object') return event;
  const usageMeta = buildUsageHistoryMeta(room, harness, event, now);
  return usageMeta ? { ...event, usageMeta } : event;
}
