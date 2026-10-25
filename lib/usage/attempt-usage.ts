/**
 * Per-attempt usage metrics derived from the existing usage ledger.
 *
 * No second aggregator: events are attributed with the TODO-usage exact join
 * (`todo-usage.js`) and summed by `aggregateTodoUsageRows`. This module only
 * (a) scopes the ledger events to one attempt of one delegation and (b) maps
 * the aggregate onto the nullable `metrics` keys stored on the attempt record.
 *
 * Why the ledger and not the room: the ledger is deduplicated by logical event
 * key, keyed by attempt, and already splits cache from ordinary tokens and
 * reported from estimated USD. A retry, a same-session resume, a new session
 * or a replayed event therefore cannot count twice, and cumulative counters
 * were already turned into deltas at the real run boundary by the recorder.
 */

import { readUsageEvents } from '../persist/usage-persist.js';
import {
  aggregateTodoUsageRows,
  buildDelegationJoinIndex,
  joinTodoUsageEvents,
} from './todo-usage.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Pure mapping from ledger events to the attempt metric keys. Every key stays
 * `null` when the ledger holds no measurement for the attempt.
 *
 * Events of one attempt are matched on `delegationId + attemptId` only: a
 * same-session resume inside one attempt may mint a new run id, and its usage
 * still belongs to that attempt. Duplicate logical events are dropped by the
 * shared join.
 *
 * @param {{ delegation: Record<string, any>, attemptId?: string, events?: Record<string, any>[] }} input
 * @returns {Record<string, number | string | null>}
 */
export function buildAttemptUsageMetrics(input: Partial<{ delegation: Record<string, any>, attemptId?: string, events?: Record<string, any>[] }> = {}) {
  const delegation = input.delegation && typeof input.delegation === 'object' ? input.delegation : null;
  const delegationId = text(delegation?.id);
  const attemptId = text(input.attemptId) || text(delegation?.attemptId);
  const empty = {
    tokens_in: null,
    tokens_out: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reported_usd: null,
    estimated_usd: null,
    billing_mode: null,
    usage_coverage: 'none',
  };
  if (!delegationId || !attemptId) return empty;
  // The TODO join drops attempts without a leaf; the label only groups rows
  // here, so the delegation id stands in when the job has no leaf binding.
  const joinable = { ...delegation, leafId: text(delegation.leafId) || delegationId };
  const index = buildDelegationJoinIndex([joinable]);
  const attempt = [...index.byKey.values()].map((hit) => hit.attempt)
    .find((row) => text(row.attemptId) === attemptId);
  if (!attempt) return empty;
  const scoped = (Array.isArray(input.events) ? input.events : [])
    .filter((event) => event && text(event.delegationId) === delegationId && text(event.attemptId) === attemptId);
  if (scoped.length === 0) return empty;
  // Distinct runs the ledger saw for this attempt (before the run id is
  // aligned below); coverage is only complete when every one of them has proof.
  const runIds = new Set(scoped.map((event) => text(event.runId)).filter(Boolean));
  const provenRunIds = new Set(scoped
    .filter((event) => event.eventType === 'run' && event.coverage?.proof === true)
    .map((event) => text(event.runId)));
  // Deliberate divergence from the TODO-usage exact join: the run id of every
  // event is aligned with the attempt's, because a same-session resume or a new
  // session mints new run ids under one attempt and their usage still belongs to
  // it. TODO-level views keep the strict join (see the per-attempt metrics docs).
  const aligned = scoped.map((event) => ({ ...event, runId: attempt.runId }));
  const { matched } = joinTodoUsageEvents(aligned, index);
  if (matched.length === 0) return empty;
  const aggregate = aggregateTodoUsageRows(matched, [attempt]);
  if (!aggregate.tokens || aggregate.measurementEvents === 0) {
    return { ...empty, usage_coverage: 'none' };
  }
  const isSubscription = aggregate.coverage.subscriptionEvents > 0;
  const hasMoney = aggregate.reportedUsd != null || aggregate.usd != null;
  const runProof = runIds.size > 0 && [...runIds].every((id) => provenRunIds.has(id));
  // `usd` is the non-estimated total: provider-reported cost, or a rate-table
  // price that carries no estimated flag. The latter is our own pricing, so it
  // is surfaced as an estimate instead of being dropped.
  const unflaggedUsd = aggregate.reportedUsd == null && aggregate.usd != null ? aggregate.usd : 0;
  const estimatedTotal = aggregate.estimatedUsd == null && unflaggedUsd === 0
    ? null
    : (aggregate.estimatedUsd || 0) + unflaggedUsd;
  const tokens = aggregate.tokens;
  return {
    tokens_in: tokens.textInput,
    tokens_out: tokens.textOutput + tokens.reasoning,
    cache_read_tokens: tokens.cachedInput,
    cache_write_tokens: tokens.cacheWrite,
    reported_usd: aggregate.reportedUsd,
    // A subscription estimate is an equivalent price, never an extra charge.
    estimated_usd: isSubscription ? null : estimatedTotal,
    billing_mode: isSubscription ? 'subscription' : hasMoney ? 'metered' : null,
    usage_coverage: runProof ? 'complete' : 'partial',
  };
}

/**
 * Reads the ledger window of one attempt and maps it to metric keys. Failure
 * to read the ledger is "no data": metrics are observational and must never
 * break a delegation finish.
 *
 * @param {{ delegation: Record<string, any>, attemptId?: string, dataDir?: string, now?: number, readEvents?: (query: Record<string, any>) => Record<string, any>[] }} input
 * @returns {Record<string, number | string | null> | null} `null` when the ledger is unreadable
 */
export function readAttemptUsageMetrics(input: Partial<{ delegation: Record<string, any>, attemptId?: string, dataDir?: string, now?: number, readEvents?: (query: Record<string, any>) => Record<string, any>[] }> = {}) {
  const delegation = input.delegation && typeof input.delegation === 'object' ? input.delegation : null;
  if (!delegation) return null;
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const startMs = Date.parse(text(delegation.createdAt) || text(delegation.queuedAt) || text(delegation.startedAt));
  const fromMs = Number.isFinite(startMs) ? startMs - DAY_MS : now - 2 * DAY_MS;
  try {
    const read = input.readEvents || readUsageEvents;
    const events = read({
      dataDir: input.dataDir,
      from: new Date(fromMs).toISOString(),
      to: new Date(now + DAY_MS).toISOString(),
    });
    return buildAttemptUsageMetrics({ delegation, attemptId: input.attemptId, events });
  } catch {
    return null;
  }
}
