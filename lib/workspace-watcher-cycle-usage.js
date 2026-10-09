/**
 * Workspace Watcher cycle usage correlation — pure model.
 *
 * One Watcher cycle owns one orchestrator chat. That chat starts one or more
 * orchestrator runs (a retry after a crash starts a new run in the same chat),
 * and the orchestrator starts one level of delegated children. The instance
 * usage ledger stores events per run with a `chatId`, a `delegationId` and —
 * for new events — the `cycleId` the run belonged to. This module turns the
 * cycle record, those events and the delegation rows into one comparable
 * summary.
 *
 * Correlation rules (acceptance of TODO 1763b52c):
 * - Membership uses `cycleId`/`chatId` plus run/attempt/delegation ids. A time
 *   window is never the join key, so usage that arrives after the cycle closed
 *   is still attributed to its run.
 * - A manual run in the orchestrator chat (no cycle id, a run id outside the
 *   known membership) is an anomaly and never lands in the sums.
 * - `own` and `consolidated` are alternative accounting scopes; they are kept
 *   in separate buckets and never added to each other. When the orchestrator
 *   reports a consolidated aggregate, child measurements are not added on top
 *   of it — the tree is marked `reliable: false` instead.
 * - Events are de-duplicated by their durable logical identity.
 * - Cost keeps `reportedUsd` (provider actual), `estimatedUsd` (rate table),
 *   `subscription` (prepaid, no USD) and `unknown` (no price) as distinct
 *   states. `null` means "unknown"; an explicit `0` is a real zero.
 *
 * The module has no IO: the persist/read orchestration lives beside it.
 */

import {
  USAGE_FINAL_USAGE_GRACE_MS,
  partitionUsageTokens,
  resolveAccountingScope,
} from './usage/usage-contract.js';
import { emptyUsageTokens } from './usage/usage-event.js';

/** Shape of the persisted per-cycle usage summary. */
export const WORKSPACE_WATCHER_CYCLE_USAGE_SCHEMA_VERSION = 1;

/**
 * How long after close a cycle's usage stays provisional. Aligns with the
 * usage-ledger final-usage grace (`USAGE_FINAL_USAGE_GRACE_MS`, 24 h).
 */
export const WORKSPACE_WATCHER_CYCLE_USAGE_GRACE_MS = USAGE_FINAL_USAGE_GRACE_MS;

/**
 * How long the usage ledger keeps the raw events. A cycle that is not finalized
 * before this point can no longer be recomputed from the ledger.
 */
export const WORKSPACE_WATCHER_CYCLE_USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const WORKSPACE_WATCHER_CYCLE_USAGE_PHASES = Object.freeze([
  'open',
  'provisional',
  'final',
  'expired',
]);

/**
 * How an event contributes to the USD buckets.
 * - `reported`  — a provider-reported actual charge (including an explicit 0).
 * - `estimated` — a rate-table estimate.
 * - `subscription` — a prepaid plan; tokens exist but there is no marginal USD.
 * - `unknown`   — no price could be derived.
 */
export const WORKSPACE_WATCHER_CYCLE_USAGE_COST_KINDS = Object.freeze([
  'reported',
  'estimated',
  'subscription',
  'unknown',
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function lower(value) {
  return text(value).toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * An all-`null` cost block. `null` is deliberately not `0`.
 *
 * @returns {object}
 */
function emptyCost() {
  return {
    reportedUsd: null,
    estimatedUsd: null,
    subscriptionEventCount: 0,
    unknownEventCount: 0,
    pricedEventCount: 0,
    totalKnownUsd: null,
    partial: false,
    zero: false,
    provenance: 'unknown',
  };
}

/**
 * A per-scope usage bucket with disjoint token counts and its own cost block.
 *
 * @returns {object}
 */
export function emptyCycleUsageBucket() {
  return {
    eventCount: 0,
    runEventCount: 0,
    runs: [],
    measuredRuns: [],
    pricedRuns: [],
    tokens: emptyUsageTokens(),
    totalTokens: 0,
    cost: emptyCost(),
    firstAt: '',
    lastAt: '',
  };
}

/**
 * Add one event's tokens as disjoint contract buckets. Diagnostic reasoning is
 * already inside `textOutput`, so it is never added twice.
 *
 * @param {Record<string, number>} target
 * @param {Record<string, number>} tokens
 * @param {string} harness
 * @returns {void}
 */
function addDisjointTokens(target, tokens, harness) {
  const buckets = partitionUsageTokens(tokens || {}, harness);
  target.textInput += buckets.inputWithoutCache;
  target.textOutput += buckets.outputWithoutReasoning;
  target.cachedInput += buckets.cacheRead;
  target.cacheWrite += buckets.cacheWrite;
  if (!buckets.reasoningDiagnostic) target.reasoning += buckets.reasoning;
  target.audioInput += buckets.audioInput;
  target.audioOutput += buckets.audioOutput;
}

/**
 * Classify one event's cost without ever inventing a price.
 *
 * @param {object} event
 * @returns {{ kind: 'reported'|'estimated'|'subscription'|'unknown', usd: number|null }}
 */
export function classifyCycleUsageCost(event) {
  const billingMode = lower(event?.billingMode);
  const billingClass = lower(event?.billingClass ?? event?.billing_class);
  if (billingMode === 'subscription' || billingClass === 'subscription_quota') {
    return { kind: 'subscription', usd: null };
  }
  const usd = finiteOrNull(event?.usd);
  if (usd != null) {
    return { kind: event?.estimated === true ? 'estimated' : 'reported', usd };
  }
  // A provider-reported value survives even when the resolved `usd` is absent
  // (e.g. a raw journal row). It is still an actual charge, not an estimate.
  const reported = finiteOrNull(event?.reportedUsd);
  if (reported != null) return { kind: 'reported', usd: reported };
  return { kind: 'unknown', usd: null };
}

/**
 * Recompute the derived cost state after one or more events were added.
 *
 * @param {object} cost
 * @returns {object}
 */
export function finalizeCycleUsageCost(cost) {
  const totalKnownUsd =
    cost.reportedUsd != null || cost.estimatedUsd != null
      ? Number(((cost.reportedUsd || 0) + (cost.estimatedUsd || 0)).toFixed(6))
      : null;
  const partial = cost.unknownEventCount > 0;
  const priced = cost.pricedEventCount > 0;
  let provenance = 'unknown';
  if (priced) {
    if (cost.reportedUsd != null && cost.estimatedUsd != null) provenance = 'mixed';
    else if (cost.estimatedUsd != null) provenance = 'estimated';
    else provenance = 'reported';
  } else if (cost.subscriptionEventCount > 0 && cost.unknownEventCount === 0) {
    provenance = 'subscription';
  }
  return {
    ...cost,
    totalKnownUsd,
    partial,
    zero: priced && totalKnownUsd === 0,
    provenance,
  };
}

/**
 * @param {object} cost
 * @param {{ kind: string, usd: number|null }} priced
 * @returns {void}
 */
function addCostToBucket(cost, priced) {
  if (priced.kind === 'subscription') {
    cost.subscriptionEventCount += 1;
    return;
  }
  if (priced.kind === 'unknown' || priced.usd == null) {
    cost.unknownEventCount += 1;
    return;
  }
  cost.pricedEventCount += 1;
  if (priced.kind === 'estimated') {
    cost.estimatedUsd = Number(((cost.estimatedUsd || 0) + priced.usd).toFixed(6));
  } else {
    cost.reportedUsd = Number(((cost.reportedUsd || 0) + priced.usd).toFixed(6));
  }
}

/**
 * Does one event carry a token measurement? A reported zero is still a
 * measurement; an all-zero delta that the ledger already dropped is not.
 *
 * @param {object} event
 * @returns {boolean}
 */
function hasTokenMeasurement(event) {
  if (event?.measurementPresent === true) return true;
  const tokens = event?.tokens;
  if (!tokens || typeof tokens !== 'object') return false;
  return Object.values(tokens).some((value) => Number(value) > 0);
}

/**
 * Per-run identity key. A durable run/attempt id is preferred; a child falls
 * back to its delegation id, then its chat id. The orchestrator falls back to
 * the chat id only when no run id was reported.
 *
 * @param {'orchestrator'|'child'} scope
 * @param {object} event
 * @param {object} membership
 * @returns {string}
 */
function usageRunKey(scope, event, membership) {
  if (scope === 'orchestrator') {
    const runId = text(event?.runId) || text(event?.attemptId);
    return `o:${runId || `chat:${membership.orchestratorChatId}`}`;
  }
  const delegationId = text(event?.delegationId);
  if (delegationId) return `c:${delegationId}`;
  const chatId = text(event?.chatId);
  return `c:chat:${chatId || 'unknown'}`;
}

/**
 * Add one attributed member event to a bucket.
 *
 * @param {object} bucket
 * @param {object} event
 * @param {object} membership
 * @param {'orchestrator'|'child'} scope
 * @param {object} runStats
 * @returns {void}
 */
function addEventToBucket(bucket, event, membership, scope, runStats) {
  bucket.eventCount += 1;
  const at = text(event?.at);
  if (at) {
    if (!bucket.firstAt || at < bucket.firstAt) bucket.firstAt = at;
    if (!bucket.lastAt || at > bucket.lastAt) bucket.lastAt = at;
  }
  const runKey = usageRunKey(scope, event, membership);
  if (!bucket.runs.includes(runKey)) bucket.runs.push(runKey);
  const stats = runStats.get(runKey) || { identity: false, tokens: false, price: false };
  if (text(event?.identityClass) && text(event.identityClass) !== 'none') stats.identity = true;
  else if (text(event?.runId) || text(event?.attemptId) || text(event?.delegationId)) stats.identity = true;
  runStats.set(runKey, stats);

  if (event?.eventType === 'run') {
    bucket.runEventCount += 1;
    return;
  }
  const harness = text(event?.harness);
  const tokens = event?.tokens && typeof event.tokens === 'object' ? event.tokens : null;
  if (tokens) addDisjointTokens(bucket.tokens, tokens, harness);
  const priced = classifyCycleUsageCost(event);
  addCostToBucket(bucket.cost, priced);

  if (hasTokenMeasurement(event)) {
    stats.tokens = true;
    if (!bucket.measuredRuns.includes(runKey)) bucket.measuredRuns.push(runKey);
  }
  if (priced.kind !== 'unknown') {
    stats.price = true;
    if (!bucket.pricedRuns.includes(runKey)) bucket.pricedRuns.push(runKey);
  }
  runStats.set(runKey, stats);
  bucket.totalTokens = totalBucketTokens(bucket.tokens);
}

/**
 * @param {object} tokens
 * @returns {number}
 */
function totalBucketTokens(tokens) {
  return Object.values(tokens || {}).reduce((sum, value) => sum + toCount(value), 0);
}

/**
 * @param {object} cost
 * @returns {object}
 */
function mergeCost(costA, costB) {
  const a = costA || emptyCost();
  const b = costB || emptyCost();
  const mergeUsd = (left, right) => {
    if (left == null && right == null) return null;
    return Number(((left || 0) + (right || 0)).toFixed(6));
  };
  return finalizeCycleUsageCost({
    reportedUsd: mergeUsd(a.reportedUsd, b.reportedUsd),
    estimatedUsd: mergeUsd(a.estimatedUsd, b.estimatedUsd),
    subscriptionEventCount: toCount(a.subscriptionEventCount) + toCount(b.subscriptionEventCount),
    unknownEventCount: toCount(a.unknownEventCount) + toCount(b.unknownEventCount),
    pricedEventCount: toCount(a.pricedEventCount) + toCount(b.pricedEventCount),
    totalKnownUsd: null,
    partial: false,
    zero: false,
    provenance: 'unknown',
  });
}

/**
 * Merge two buckets without ever adding `own` to `consolidated`: callers merge
 * buckets of the same scope only.
 *
 * @param {object} bucketA
 * @param {object} bucketB
 * @returns {object}
 */
export function mergeCycleUsageBuckets(bucketA, bucketB) {
  const a = bucketA || emptyCycleUsageBucket();
  const b = bucketB || emptyCycleUsageBucket();
  const tokens = emptyUsageTokens();
  for (const key of Object.keys(tokens)) {
    tokens[key] = toCount(a.tokens?.[key]) + toCount(b.tokens?.[key]);
  }
  const runs = [...new Set([...(a.runs || []), ...(b.runs || [])])];
  const measuredRuns = [...new Set([...(a.measuredRuns || []), ...(b.measuredRuns || [])])];
  const pricedRuns = [...new Set([...(a.pricedRuns || []), ...(b.pricedRuns || [])])];
  const firstAt = [a.firstAt, b.firstAt].filter(Boolean).sort()[0] || '';
  const lastAt = [a.lastAt, b.lastAt].filter(Boolean).sort().at(-1) || '';
  return {
    eventCount: toCount(a.eventCount) + toCount(b.eventCount),
    runEventCount: toCount(a.runEventCount) + toCount(b.runEventCount),
    runs,
    measuredRuns,
    pricedRuns,
    tokens,
    totalTokens: totalBucketTokens(tokens),
    cost: mergeCost(a.cost, b.cost),
    firstAt,
    lastAt,
  };
}

/**
 * Resolve the lifecycle phase of a cycle's usage relative to `now`.
 *
 * - `open` — the cycle has no close yet, so usage can still change.
 * - `provisional` — closed, but inside the 24 h final-usage grace.
 * - `final` — closed and past the grace; safe to persist once.
 * - `expired` — closed past the ledger retention without a finalization, so the
 *   raw events may already be gone and the sums cannot be trusted.
 *
 * @param {object} cycle
 * @param {{ now?: number, graceMs?: number, retentionMs?: number }} [options]
 * @returns {object}
 */
export function resolveWorkspaceWatcherCycleUsagePhase(cycle, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const graceMs = Number(options.graceMs) > 0
    ? Number(options.graceMs)
    : WORKSPACE_WATCHER_CYCLE_USAGE_GRACE_MS;
  const retentionMs = Number(options.retentionMs) > 0
    ? Number(options.retentionMs)
    : WORKSPACE_WATCHER_CYCLE_USAGE_RETENTION_MS;
  const closeMs = Date.parse(String(cycle?.closedAt || ''));
  if (!cycle?.closedAt || !Number.isFinite(closeMs)) {
    return {
      phase: 'open',
      provisional: true,
      expired: false,
      closedAt: '',
      finalizeAfter: '',
      retentionUntil: '',
      closeMs: null,
    };
  }
  const finalizeAtMs = closeMs + graceMs;
  const retentionUntilMs = closeMs + retentionMs;
  const finalizeAfter = new Date(finalizeAtMs).toISOString();
  const retentionUntil = new Date(retentionUntilMs).toISOString();
  const closedAt = new Date(closeMs).toISOString();
  if (now < finalizeAtMs) {
    return { phase: 'provisional', provisional: true, expired: false, closedAt, finalizeAfter, retentionUntil, closeMs };
  }
  if (now > retentionUntilMs) {
    return { phase: 'expired', provisional: false, expired: true, closedAt, finalizeAfter, retentionUntil, closeMs };
  }
  return { phase: 'final', provisional: false, expired: false, closedAt, finalizeAfter, retentionUntil, closeMs };
}

/**
 * Build the membership sets for one cycle. Delegations are one level: every
 * delegation whose parent is the orchestrator chat is a child; a delegation
 * whose parent is itself a child is an unexpected grandchild and is reported
 * as an anomaly, never silently summed.
 *
 * @param {object} cycle
 * @param {object[]} delegations
 * @param {{ orchestratorRunIds?: string[] }} [options]
 * @returns {object}
 */
export function buildCycleUsageMembership(cycle, delegations, options = {}) {
  const orchestratorChatId = text(cycle?.orchestratorChatId);
  const orchestratorRunIds = new Set(
    [
      text(cycle?.orchestratorRunId),
      ...(Array.isArray(cycle?.orchestratorRunIds) ? cycle.orchestratorRunIds.map(text) : []),
      ...(Array.isArray(options.orchestratorRunIds) ? options.orchestratorRunIds.map(text) : []),
    ].filter(Boolean)
  );
  const rows = Array.isArray(delegations) ? delegations : [];
  /** @type {object[]} */
  const children = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const parent = text(row.parentChatId) || text(row.sourceChatId);
    if (!orchestratorChatId || parent !== orchestratorChatId) continue;
    children.push(row);
  }
  const childIds = new Set(children.map((row) => text(row.id)).filter(Boolean));
  const childChatIds = new Set(children.map((row) => text(row.childChatId)).filter(Boolean));
  const childRunIds = new Set(children.map((row) => text(row.runId)).filter(Boolean));
  const childAttemptIds = new Set(children.map((row) => text(row.attemptId)).filter(Boolean));
  const childByChatId = new Map();
  const childById = new Map();
  for (const row of children) {
    if (text(row.id)) childById.set(text(row.id), row);
    if (text(row.childChatId)) childByChatId.set(text(row.childChatId), row);
  }
  /** @type {object[]} */
  const grandchildren = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const parent = text(row.parentChatId) || text(row.sourceChatId);
    if (!parent || parent === orchestratorChatId) continue;
    if (childChatIds.has(parent)) {
      grandchildren.push({
        delegationId: text(row.id),
        parentChatId: parent,
        childChatId: text(row.childChatId),
      });
    }
  }
  return {
    cycleId: text(cycle?.cycleId),
    orchestratorChatId,
    orchestratorRunIds,
    children,
    childIds,
    childChatIds,
    childRunIds,
    childAttemptIds,
    childByChatId,
    childById,
    grandchildren,
  };
}

/**
 * Attribute one usage event to the cycle, or explain why it does not belong.
 *
 * The `cycleId` stamp is the strongest proof and covers late usage after close.
 * Without it, membership falls back to the chat id plus the durable run /
 * attempt / delegation ids recorded for the cycle, never to `event.at`.
 *
 * @param {object} event
 * @param {object} cycle
 * @param {object} membership
 * @returns {object}
 */
export function classifyCycleUsageEvent(event, cycle, membership) {
  const cycleId = text(cycle?.cycleId);
  const eventCycleId = text(event?.cycleId);
  if (eventCycleId && cycleId && eventCycleId === cycleId) {
    if (text(event?.delegationId) && membership.childIds.has(text(event.delegationId))) {
      return { scope: 'child', reason: 'cycle_id' };
    }
    if (text(event?.chatId) === membership.orchestratorChatId) {
      return { scope: 'orchestrator', reason: 'cycle_id' };
    }
    if (text(event?.chatId) && membership.childChatIds.has(text(event.chatId))) {
      return { scope: 'child', reason: 'cycle_id' };
    }
    return { scope: 'anomaly', reason: 'cycle_member_unknown_chat' };
  }
  if (text(event?.delegationId) && membership.childIds.has(text(event.delegationId))) {
    return { scope: 'child', reason: 'delegation_id' };
  }
  const chatId = text(event?.chatId);
  const runId = text(event?.runId);
  const attemptId = text(event?.attemptId);
  if (chatId && chatId === membership.orchestratorChatId) {
    if (!runId && !attemptId) {
      return cycle?.closedAt
        ? { scope: 'anomaly', reason: 'unidentified_orchestrator_run_after_close' }
        : { scope: 'orchestrator', reason: 'open_chat' };
    }
    if (membership.orchestratorRunIds.has(runId) || membership.orchestratorRunIds.has(attemptId)) {
      return { scope: 'orchestrator', reason: 'run_membership' };
    }
    return { scope: 'anomaly', reason: 'orchestrator_run_not_in_cycle' };
  }
  if (chatId && membership.childChatIds.has(chatId)) {
    if (!runId && !attemptId) return { scope: 'child', reason: 'child_chat' };
    if (
      membership.childRunIds.has(runId)
      || membership.childAttemptIds.has(attemptId)
      || membership.childByChatId.get(chatId)
    ) {
      return { scope: 'child', reason: 'child_run_membership' };
    }
    return { scope: 'anomaly', reason: 'child_run_not_in_cycle' };
  }
  return { scope: 'foreign', reason: 'not_cycle_member' };
}

/**
 * Durable de-dup key. Only genuine identities are used; an event without one is
 * counted as un-identifiable instead of being merged on a timestamp.
 *
 * @param {object} event
 * @returns {string}
 */
function cycleUsageDedupeKey(event) {
  const logical = text(event?.logicalEventKey);
  if (logical) return `k:${logical}`;
  const id = text(event?.id);
  if (id) return `id:${id}`;
  return '';
}

/**
 * Correlate one cycle with the ledger events and delegation rows.
 *
 * @param {object} cycle Normalized cycle metric record.
 * @param {{
 *   events?: object[],
 *   delegations?: object[],
 *   now?: number,
 *   graceMs?: number,
 *   retentionMs?: number,
 *   orchestratorRunIds?: string[],
 * }} [input]
 * @returns {object}
 */
export function correlateWorkspaceWatcherCycleUsage(cycle, input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const membership = buildCycleUsageMembership(cycle, input.delegations, {
    orchestratorRunIds: input.orchestratorRunIds,
  });
  const phase = resolveWorkspaceWatcherCycleUsagePhase(cycle, input);

  const orchestratorOwn = emptyCycleUsageBucket();
  const orchestratorConsolidated = emptyCycleUsageBucket();
  const childrenOwn = emptyCycleUsageBucket();
  const childrenConsolidated = emptyCycleUsageBucket();
  /** @type {Map<string, object>} */
  const runStats = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  const anomalies = {
    grandchildren: membership.grandchildren,
    orchestratorRunsNotInCycle: 0,
    childRunsNotInCycle: 0,
    unknownCycleChats: 0,
    unidentifiedEvents: 0,
    noIdentityEvents: 0,
  };
  let duplicateEventCount = 0;
  let memberEventCount = 0;

  for (const event of Array.isArray(input.events) ? input.events : []) {
    if (!event || typeof event !== 'object') continue;
    const key = cycleUsageDedupeKey(event);
    if (key) {
      if (seen.has(key)) {
        duplicateEventCount += 1;
        continue;
      }
      seen.add(key);
    }
    const attributed = classifyCycleUsageEvent(event, cycle, membership);
    if (attributed.scope === 'foreign') {
      if (!key) anomalies.unidentifiedEvents += 1;
      continue;
    }
    if (attributed.scope === 'anomaly') {
      if (attributed.reason === 'orchestrator_run_not_in_cycle') anomalies.orchestratorRunsNotInCycle += 1;
      else if (attributed.reason === 'child_run_not_in_cycle') anomalies.childRunsNotInCycle += 1;
      else if (attributed.reason === 'cycle_member_unknown_chat') anomalies.unknownCycleChats += 1;
      else anomalies.unidentifiedEvents += 1;
      if (!key) anomalies.noIdentityEvents += 1;
      continue;
    }
    memberEventCount += 1;
    if (!key) anomalies.noIdentityEvents += 1;
    const consolidated = resolveAccountingScope(event) === 'consolidated';
    const bucket = attributed.scope === 'orchestrator'
      ? (consolidated ? orchestratorConsolidated : orchestratorOwn)
      : (consolidated ? childrenConsolidated : childrenOwn);
    addEventToBucket(bucket, event, membership, attributed.scope, runStats);
  }

  const members = [
    orchestratorOwn,
    orchestratorConsolidated,
    childrenOwn,
    childrenConsolidated,
  ];
  const expectedOrchestratorRuns = membership.orchestratorRunIds.size > 0
    ? membership.orchestratorRunIds.size
    : (membership.orchestratorChatId ? 1 : 0);
  const expectedChildRuns = membership.children.length;
  const expectedTotal = expectedOrchestratorRuns + expectedChildRuns;

  const distinctRuns = new Set(members.flatMap((bucket) => bucket.runs));
  const identifiedRuns = new Set();
  const measuredRuns = new Set(members.flatMap((bucket) => bucket.measuredRuns));
  const pricedRuns = new Set(members.flatMap((bucket) => bucket.pricedRuns));
  for (const [runKey, stats] of runStats.entries()) {
    if (stats.identity) identifiedRuns.add(runKey);
  }
  const ratio = (count) => (expectedTotal > 0 ? Number((count / expectedTotal).toFixed(4)) : null);
  const coverage = {
    expectedRuns: expectedTotal,
    expectedOrchestratorRuns,
    expectedChildRuns,
    observedRuns: distinctRuns.size,
    identity: {
      covered: Math.min(identifiedRuns.size, expectedTotal),
      expected: expectedTotal,
      ratio: ratio(Math.min(identifiedRuns.size, expectedTotal)),
    },
    tokens: {
      covered: Math.min(measuredRuns.size, expectedTotal),
      expected: expectedTotal,
      ratio: ratio(Math.min(measuredRuns.size, expectedTotal)),
    },
    price: {
      covered: Math.min(pricedRuns.size, expectedTotal),
      expected: expectedTotal,
      ratio: ratio(Math.min(pricedRuns.size, expectedTotal)),
    },
  };

  // Whole-tree usage. `own` and `consolidated` are never added together: when
  // the orchestrator reported a consolidated aggregate, the child measurements
  // may already be inside it, so the tree total is marked unreliable instead of
  // being summed twice.
  const orchestratorHasConsolidated = orchestratorConsolidated.eventCount > 0;
  const anyConsolidated = orchestratorHasConsolidated
    || childrenConsolidated.eventCount > 0;
  let treeOwn = null;
  let treeConsolidated = null;
  let treeReliable = false;
  if (orchestratorHasConsolidated) {
    treeConsolidated = orchestratorConsolidated;
    treeReliable = false;
  } else if (anyConsolidated) {
    // A child aggregate is self-contained, but child own + child consolidated
    // must not be combined. Use the aggregate for that child cohort and own for
    // the orchestrator; the delegation attribution is still reliable.
    treeOwn = mergeCycleUsageBuckets(orchestratorOwn, emptyCycleUsageBucket());
    treeConsolidated = childrenConsolidated;
    treeReliable = false;
  } else {
    treeOwn = mergeCycleUsageBuckets(orchestratorOwn, childrenOwn);
    treeReliable = true;
  }
  const treeBucket = treeOwn || treeConsolidated || emptyCycleUsageBucket();
  const treeCost = finalizeCycleUsageCost(treeBucket.cost);
  const treePartial = treeCost.partial
    || coverage.identity.ratio !== 1
    || coverage.tokens.ratio !== 1
    || anomalies.orchestratorRunsNotInCycle > 0
    || anomalies.childRunsNotInCycle > 0;

  return {
    schemaVersion: WORKSPACE_WATCHER_CYCLE_USAGE_SCHEMA_VERSION,
    cycleId: text(cycle?.cycleId),
    phase: phase.phase,
    provisional: phase.provisional,
    expired: phase.expired,
    generatedAt: new Date(now).toISOString(),
    closedAt: phase.closedAt,
    finalizeAfter: phase.finalizeAfter,
    retentionUntil: phase.retentionUntil,
    orchestrator: {
      own: orchestratorOwn,
      consolidated: orchestratorConsolidated,
      chatId: membership.orchestratorChatId,
      runIds: [...membership.orchestratorRunIds],
    },
    children: {
      own: childrenOwn,
      consolidated: childrenConsolidated,
      delegations: membership.children.map((row) => ({
        delegationId: text(row.id),
        childChatId: text(row.childChatId),
        leafId: text(row.leafId),
        runId: text(row.runId),
        attemptId: text(row.attemptId),
        status: text(row.status),
      })),
    },
    tree: {
      reliable: treeReliable,
      own: treeOwn,
      consolidated: treeConsolidated,
      cost: treeCost,
      partial: treePartial,
      totalTokens: treeBucket.totalTokens,
      eventCount: treeBucket.eventCount,
      runEventCount: treeBucket.runEventCount,
    },
    coverage,
    expectedRuns: {
      total: expectedTotal,
      orchestrator: expectedOrchestratorRuns,
      children: expectedChildRuns,
      orchestratorRunIds: [...membership.orchestratorRunIds],
      childDelegationIds: membership.children.map((row) => text(row.id)).filter(Boolean),
    },
    anomalies,
    dedupe: {
      memberEventCount,
      duplicateEventCount,
      unidentifiableEventCount: anomalies.noIdentityEvents,
    },
  };
}

/**
 * Defensive normalizer for a stored summary. A corrupt/partial file must not
 * crash a reader; unknown fields fall back to the empty bucket.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorkspaceWatcherCycleUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const normalizeBucket = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCycleUsageBucket();
    const bucket = /** @type {Record<string, unknown>} */ (value);
    const tokens = emptyUsageTokens();
    const rawTokens = bucket.tokens && typeof bucket.tokens === 'object' ? bucket.tokens : {};
    for (const key of Object.keys(tokens)) tokens[key] = toCount(/** @type {any} */ (rawTokens)[key]);
    const costRaw = bucket.cost && typeof bucket.cost === 'object' ? bucket.cost : {};
    const reported = finiteOrNull(costRaw.reportedUsd);
    const estimated = finiteOrNull(costRaw.estimatedUsd);
    const cost = finalizeCycleUsageCost({
      reportedUsd: reported,
      estimatedUsd: estimated,
      subscriptionEventCount: toCount(costRaw.subscriptionEventCount),
      unknownEventCount: toCount(costRaw.unknownEventCount),
      pricedEventCount: toCount(costRaw.pricedEventCount),
      totalKnownUsd: null,
      partial: false,
      zero: false,
      provenance: 'unknown',
    });
    const runs = Array.isArray(bucket.runs) ? bucket.runs.map(text).filter(Boolean) : [];
    const measuredRuns = Array.isArray(bucket.measuredRuns) ? bucket.measuredRuns.map(text).filter(Boolean) : [];
    const pricedRuns = Array.isArray(bucket.pricedRuns) ? bucket.pricedRuns.map(text).filter(Boolean) : [];
    return {
      eventCount: toCount(bucket.eventCount),
      runEventCount: toCount(bucket.runEventCount),
      runs,
      measuredRuns,
      pricedRuns,
      tokens,
      totalTokens: totalBucketTokens(tokens),
      cost,
      firstAt: text(bucket.firstAt),
      lastAt: text(bucket.lastAt),
    };
  };
  const coverageRaw = source.coverage && typeof source.coverage === 'object' ? source.coverage : {};
  const normalizeCoverageSide = (value) => {
    const side = value && typeof value === 'object' ? value : {};
    return {
      covered: toCount(side.covered),
      expected: toCount(side.expected),
      ratio: finiteOrNull(side.ratio),
    };
  };
  const phaseRaw = text(source.phase);
  const anomaliesRaw = source.anomalies && typeof source.anomalies === 'object' ? source.anomalies : {};
  const dedupeRaw = source.dedupe && typeof source.dedupe === 'object' ? source.dedupe : {};
  const expectedRaw = source.expectedRuns && typeof source.expectedRuns === 'object' ? source.expectedRuns : {};
  return {
    schemaVersion: WORKSPACE_WATCHER_CYCLE_USAGE_SCHEMA_VERSION,
    cycleId: text(source.cycleId),
    phase: WORKSPACE_WATCHER_CYCLE_USAGE_PHASES.includes(phaseRaw) ? phaseRaw : 'open',
    provisional: source.provisional === true,
    expired: source.expired === true,
    generatedAt: text(source.generatedAt),
    closedAt: text(source.closedAt),
    finalizeAfter: text(source.finalizeAfter),
    retentionUntil: text(source.retentionUntil),
    orchestrator: {
      own: normalizeBucket(source.orchestrator?.own),
      consolidated: normalizeBucket(source.orchestrator?.consolidated),
      chatId: text(source.orchestrator?.chatId),
      runIds: Array.isArray(source.orchestrator?.runIds) ? source.orchestrator.runIds.map(text).filter(Boolean) : [],
    },
    children: {
      own: normalizeBucket(source.children?.own),
      consolidated: normalizeBucket(source.children?.consolidated),
      delegations: Array.isArray(source.children?.delegations)
        ? source.children.delegations
          .filter((row) => row && typeof row === 'object')
          .map((row) => ({
            delegationId: text(row.delegationId),
            childChatId: text(row.childChatId),
            leafId: text(row.leafId),
            runId: text(row.runId),
            attemptId: text(row.attemptId),
            status: text(row.status),
          }))
        : [],
    },
    tree: {
      reliable: source.tree?.reliable === true,
      own: source.tree?.own ? normalizeBucket(source.tree.own) : null,
      consolidated: source.tree?.consolidated ? normalizeBucket(source.tree.consolidated) : null,
      cost: normalizeBucket({ cost: source.tree?.cost }).cost,
      partial: source.tree?.partial === true,
      totalTokens: toCount(source.tree?.totalTokens),
      eventCount: toCount(source.tree?.eventCount),
      runEventCount: toCount(source.tree?.runEventCount),
    },
    coverage: {
      expectedRuns: toCount(coverageRaw.expectedRuns),
      expectedOrchestratorRuns: toCount(coverageRaw.expectedOrchestratorRuns),
      expectedChildRuns: toCount(coverageRaw.expectedChildRuns),
      observedRuns: toCount(coverageRaw.observedRuns),
      identity: normalizeCoverageSide(coverageRaw.identity),
      tokens: normalizeCoverageSide(coverageRaw.tokens),
      price: normalizeCoverageSide(coverageRaw.price),
    },
    expectedRuns: {
      total: toCount(expectedRaw.total),
      orchestrator: toCount(expectedRaw.orchestrator),
      children: toCount(expectedRaw.children),
      orchestratorRunIds: Array.isArray(expectedRaw.orchestratorRunIds)
        ? expectedRaw.orchestratorRunIds.map(text).filter(Boolean)
        : [],
      childDelegationIds: Array.isArray(expectedRaw.childDelegationIds)
        ? expectedRaw.childDelegationIds.map(text).filter(Boolean)
        : [],
    },
    anomalies: {
      grandchildren: Array.isArray(anomaliesRaw.grandchildren)
        ? anomaliesRaw.grandchildren
          .filter((row) => row && typeof row === 'object')
          .map((row) => ({
            delegationId: text(row.delegationId),
            parentChatId: text(row.parentChatId),
            childChatId: text(row.childChatId),
          }))
        : [],
      orchestratorRunsNotInCycle: toCount(anomaliesRaw.orchestratorRunsNotInCycle),
      childRunsNotInCycle: toCount(anomaliesRaw.childRunsNotInCycle),
      unknownCycleChats: toCount(anomaliesRaw.unknownCycleChats),
      unidentifiedEvents: toCount(anomaliesRaw.unidentifiedEvents),
      noIdentityEvents: toCount(anomaliesRaw.noIdentityEvents),
    },
    dedupe: {
      memberEventCount: toCount(dedupeRaw.memberEventCount),
      duplicateEventCount: toCount(dedupeRaw.duplicateEventCount),
      unidentifiableEventCount: toCount(dedupeRaw.unidentifiableEventCount),
    },
  };
}
