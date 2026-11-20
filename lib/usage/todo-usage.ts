/**
 * TODO usage statistics read from the *existing* usage ledger.
 *
 * This module is a read model, not a writer: it never records usage, never
 * re-prices an event and never changes the delegation or todo tree. Cost comes
 * from the ledger only (`event.usd`, already priced when the event was
 * committed) — a historical event without `usd` stays unpriced instead of being
 * recomputed from the rate table, and the omission is reported in `coverage`.
 *
 * Join model
 * ----------
 * A usage event is attributed to a TODO through its delegation:
 *   delegation (leafId = todo id) -> attempt (attemptId + runId) -> usage event.
 * The join key is `delegationId + attemptId + runId`, so a retry of the same
 * delegation (a new attempt/run) is a *separate* measurement while a repeated
 * record of the same attempt can never double the numbers: every event is
 * consumed at most once.
 *
 * Tree model
 * ----------
 * `own` = usage of the delegations bound to this very TODO.
 * `consolidated` = usage of the delegations bound to its descendants.
 * Both are reported separately and must never be added together (the response
 * carries `mixed` so a caller can tell it holds both). Because every event is
 * attributed to exactly one TODO, a tree roll-up can never double count.
 *
 * Missing data is `null` with a `coverage` explanation, never `0`.
 */

import { listDelegationAttempts } from '../delegation-attempt.js';
import { createHash } from 'crypto';
import { collectTodoSubtreeIds } from '../todo-tree.js';
import { partitionUsageTokens } from './usage-contract.js';
import { resolveUsageHarness, summarizeUsage } from './usage-ledger.ts';
import { resolveUsageWindow } from './usage-window.ts';

/** Default rolling window for the TODO usage endpoints. */
export const TODO_USAGE_DEFAULT_WINDOW_DAYS = 30;
/** Hard upper bound of a request window (matches the ledger API). */
export const TODO_USAGE_MAX_WINDOW_DAYS = 92;
/** Default page size for the workspace view. */
export const TODO_USAGE_DEFAULT_LIMIT = 50;
/** Hard upper bound of `limit`. */
export const TODO_USAGE_MAX_LIMIT = 200;
/** Which side(s) of the TODO tree attribution a caller wants. */
export const TODO_USAGE_SCOPES = Object.freeze(['own', 'consolidated', 'both']);
/**
 * Which per-event ledger accounting scope a caller selects. `both` is **not**
 * allowed: own and consolidated are alternative scopes, so summing them would
 * double count child-harness usage. Callers get both as separate subtotals in
 * `accountingScopes` instead.
 */
export const TODO_USAGE_ACCOUNTING_SCOPES = Object.freeze(['own', 'consolidated']);
/** Which rows the workspace view returns. */
export const TODO_USAGE_INCLUDES = Object.freeze(['all', 'usage']);
/**
 * Label of the ledger events that carry no workspace key. They can never be
 * claimed by a workspace, so they are a diagnostic count and nothing else.
 */
export const TODO_USAGE_UNATTRIBUTED_LABEL = 'unscoped (no workspace key, excluded from sums)';

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function instantMs(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The identity of one delegation attempt/run. Every join, dedup and "counted
 * once" guarantee in this module keys off this string.
 *
 * @param {unknown} delegationId
 * @param {unknown} attemptId
 * @param {unknown} runId
 * @returns {string}
 */
export function todoUsageJoinKey(delegationId, attemptId, runId) {
  return `${text(delegationId)}|${text(attemptId)}|${text(runId)}`;
}

/**
 * @param {Record<string, any>} event
 * @returns {string}
 */
function eventJoinKey(event) {
  return todoUsageJoinKey(event?.delegationId, event?.attemptId, event?.runId);
}

/**
 * @returns {{ textInput: number, textOutput: number, cachedInput: number, cacheWrite: number, reasoning: number, audioInput: number, audioOutput: number }}
 */
function emptyTodoUsageTokens() {
  return {
    textInput: 0,
    textOutput: 0,
    cachedInput: 0,
    cacheWrite: 0,
    reasoning: 0,
    audioInput: 0,
    audioOutput: 0,
  };
}

/**
 * Indexes delegations by their attempt identity and by delegation id.
 *
 * A retry archives the previous attempt on the *same* delegation row, so the
 * attempt list is the only place where "one delegation, several runs" lives.
 * Duplicate keys inside one row are collapsed here: the same attempt must never
 * be counted twice.
 *
 * @param {Record<string, any>[] | null | undefined} delegations
 * @returns {{ byKey: Map<string, Record<string, any>>, byDelegationId: Map<string, Record<string, any>> }}
 */
export function buildDelegationJoinIndex(delegations) {
  const byKey = new Map();
  const byDelegationId = new Map();
  for (const record of Array.isArray(delegations) ? delegations : []) {
    if (!record || typeof record !== 'object') continue;
    const delegationId = text(record.id);
    if (!delegationId) continue;
    const attempts = listDelegationAttempts(record).map((attempt: Record<string, any>): Record<string, any> => ({ ...attempt, leafId: text(attempt.leafId) || text(record.leafId) }));
    const entry = { delegationId, todoId: text(record.leafId), delegation: record, attempts };
    if (!byDelegationId.has(delegationId)) byDelegationId.set(delegationId, entry);
    const seen = new Set();
    for (const attempt of attempts) {
      if (!attempt || typeof attempt !== 'object') continue;
      const key = todoUsageJoinKey(delegationId, attempt.attemptId, attempt.runId);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = byKey.get(key);
      if (existing) existing.ambiguous = true;
      else byKey.set(key, { delegationId, todoId: text(attempt.leafId), attempt });
    }
  }
  return { byKey, byDelegationId };
}

/**
 * Attributes usage events to TODOs through the delegation join.
 *
 * Two passes, and an event is consumed by at most one of them:
 *   1. exact `delegationId + attemptId + runId` match (the canonical join);
 *   2. No fallback: partial and ambiguous identities remain unmatched.
 * An event without a `delegationId` cannot be attributed to a TODO and stays
 * `unmatched`.
 *
 * A repeated delivery of the *same* logical event (identical
 * `logicalEventKey`, e.g. a snapshot flushed twice for one attempt) is counted
 * once and recorded as `duplicates`: a retry must never double the numbers.
 *
 * @param {Record<string, any>[] | null | undefined} events
 * @param {ReturnType<typeof buildDelegationJoinIndex>} index
 * @returns {{ matched: Array<{ event: Record<string, any>, todoId: string, delegationId: string, joinKey: string, join: 'exact'|'delegation' }>, unmatched: Record<string, any>[], duplicates: number }}
 */
export function joinTodoUsageEvents(events, index) {
  const list = Array.isArray(events) ? events : [];
  const matched = [];
  const unmatched = [];
  const consumed = new Set();
  const seenIdentity = new Set();
  let duplicates = 0;
  for (let i = 0; i < list.length; i += 1) {
    const event = list[i];
    if (!event || typeof event !== 'object') continue;
    const identity = text(event.logicalEventKey);
    if (identity) {
      if (seenIdentity.has(identity)) {
        duplicates += 1;
        consumed.add(i);
        continue;
      }
      seenIdentity.add(identity);
    }
    const delegationId = text(event.delegationId);
    if (!delegationId) {
      unmatched.push(event);
      consumed.add(i);
      continue;
    }
    const hit = index.byKey.get(eventJoinKey(event));
    if (!hit || hit.ambiguous || !hit.todoId) continue;
    consumed.add(i);
    matched.push({
      event,
      todoId: hit.todoId,
      delegationId,
      joinKey: eventJoinKey(event),
      join: 'exact',
    });
  }
  for (let i = 0; i < list.length; i += 1) {
    if (consumed.has(i)) continue;
    const event = list[i];
    if (!event || typeof event !== 'object') continue;
    unmatched.push(event);
  }
  return { matched, unmatched, duplicates };
}

/**
 * Attempt timelines per TODO, keyed by the same deduped join key that the
 * usage join uses, so durations and counts always agree.
 *
 * @param {ReturnType<typeof buildDelegationJoinIndex>} index
 * @returns {Map<string, Record<string, any>[]>}
 */
export function buildTodoAttemptTimeline(index) {
  const byTodo = new Map();
  for (const hit of index.byKey.values()) {
    if (!hit.todoId) continue;
    const list = byTodo.get(hit.todoId);
    if (list) list.push(hit.attempt);
    else byTodo.set(hit.todoId, [hit.attempt]);
  }
  return byTodo;
}

/**
 * Builds the reusable read model for one workspace.
 *
 * @param {{ items?: Record<string, any>[], delegations?: Record<string, any>[], events?: Record<string, any>[] }} input
 * @returns {{ index: ReturnType<typeof buildDelegationJoinIndex>, byTodo: Map<string, Record<string, any>[]>, unmatched: Record<string, any>[], duplicates: number, timeline: Map<string, Record<string, any>[]> }}
 */
export function buildTodoUsageModel(input: Partial<{ items?: object[], delegations?: object[], events?: object[] }> = {}) {
  const index = buildDelegationJoinIndex(input.delegations);
  const { matched, unmatched, duplicates } = joinTodoUsageEvents(input.events, index);
  const byTodo = new Map();
  for (const row of matched) {
    const list = byTodo.get(row.todoId);
    if (list) list.push(row);
    else byTodo.set(row.todoId, [row]);
  }
  return { index, byTodo, unmatched, duplicates, timeline: buildTodoAttemptTimeline(index) };
}

/**
 * Sum of per-attempt wall time. Parallel attempts legitimately exceed the
 * elapsed span, so this is deliberately *not* the elapsed time.
 *
 * @param {Record<string, any>[] | null | undefined} attempts
 * @returns {number|null}
 */
export function sumAttemptDurationsMs(attempts) {
  let total = 0;
  let counted = 0;
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const startedAt = instantMs(attempt?.startedAt);
    const finishedAt = instantMs(attempt?.finishedAt);
    if (startedAt == null || finishedAt == null || finishedAt < startedAt) continue;
    total += finishedAt - startedAt;
    counted += 1;
  }
  return counted > 0 ? total : null;
}

/**
 * Wall-clock span from the earliest queue/start to the latest finish.
 * `null` while nothing has finished yet — an open span is not a zero.
 *
 * @param {Record<string, any>[] | null | undefined} attempts
 * @returns {number|null}
 */
export function todoElapsedMs(attempts) {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const list = Array.isArray(attempts) ? attempts : [];
  for (const attempt of list) {
    if (!instantMs(attempt?.finishedAt)) return null;
    const start = instantMs(attempt?.queuedAt) ?? instantMs(attempt?.startedAt);
    const end = instantMs(attempt?.finishedAt);
    if (start != null) from = Math.min(from, start);
    if (end != null) to = Math.max(to, end);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
}

/**
 * @param {number} value
 * @returns {number}
 */
function roundUsd(value) {
  return Number(Number(value).toFixed(6));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sha16(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * The attempts the delegation lifecycle promises for a set of TODOs, in the
 * same deduped `delegationId|attemptId|runId` identity the usage join uses.
 *
 * @param {ReturnType<typeof buildDelegationJoinIndex>} index
 * @param {Iterable<string>} todoIds
 * @returns {Array<{ delegationId: string, attemptId: string, runId: string }>}
 */
export function todoUsageExpectedAttempts(index, todoIds) {
  const allowed = new Set([...(todoIds || [])].map((id) => text(id)));
  const seen = new Set();
  const out = [];
  for (const entry of index?.byDelegationId?.values ? index.byDelegationId.values() : []) {
    for (const attempt of entry?.attempts || []) {
      if (!allowed.has(text(attempt?.leafId))) continue;
      const key = todoUsageJoinKey(entry.delegationId, attempt?.attemptId, attempt?.runId);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        delegationId: text(entry.delegationId),
        attemptId: text(attempt?.attemptId),
        runId: text(attempt?.runId),
      });
    }
  }
  return out;
}

/**
 * Aggregates one set of joined rows (one TODO, or one side of it).
 *
 * Every sum is computed from the *scoped* rows only: an event the caller
 * filtered out (model, accounting scope) can never contribute tokens, cost or
 * coverage, so the numbers always describe exactly what the caller asked for.
 *
 * Cost rules:
 * - `usd` counts only events the ledger already priced; it is `null` when no
 *   event carries a cost (never `0`). An estimate is not a measurement, so an
 *   estimated-only set leaves `usd` null and reports `estimatedUsd`;
 * - estimated (rate-table) USD is kept apart from reported/metered USD;
 * - `billingMode: 'subscription'` has no marginal USD and is *not* zero cost —
 *   it is reported through `coverage.subscriptionEvents`;
 * - run events carry no tokens and no cost, so they never reach the sums.
 *
 * @param {Array<{ event: Record<string, any>, delegationId: string, joinKey: string, join: string }>} rows
 * @param {Record<string, any>[]} [attempts]
 * @param {{ model?: string, accountingScope?: string, diagnostics?: Record<string, any>|null, expectedAttempts?: Array<{ delegationId: string, attemptId: string, runId: string }>|null }} [options]
 * @returns {Record<string, any>}
 */
export function aggregateTodoUsageRows(rows, attempts = [], options: Partial<{ model?: string, accountingScope?: string, diagnostics?: Record<string, any>|null, expectedAttempts?: Array<{ delegationId: string, attemptId: string, runId: string }>|null }> = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const modelFilter = text(options.model);
  // `both` is not a scope: own and consolidated are alternatives, never a sum.
  const accountingScope = TODO_USAGE_ACCOUNTING_SCOPES.includes(text(options.accountingScope))
    ? text(options.accountingScope)
    : 'own';
  const isScoped = (row) => {
    const event = row?.event;
    if (!event || typeof event !== 'object') return false;
    if (modelFilter && text(event.model) !== modelFilter) return false;
    return true;
  };
  // Model-filtered rows: the axis both accounting subtotals are reported on.
  const modelRows = list.filter(isScoped);
  const scoped = modelRows.filter(
    (row) => (text(row.event.accountingScope) || 'own') === accountingScope
  );
  const scopedEvents = scoped.map((row) => row.event);
  const joinKeys = new Set();
  const delegationIds = new Set();
  let measurementEvents = 0;
  let runEvents = 0;
  let pricedEvents = 0;
  let unpricedEvents = 0;
  let subscriptionEvents = 0;
  let estimatedEvents = 0;
  let reportedUsdEvents = 0;
  let joinFallbackEvents = 0;
  let estimatedUsd = 0;
  let reportedUsd = 0;
  const tokens = emptyTodoUsageTokens();
  for (const row of scoped) {
    if (row?.join === 'delegation') joinFallbackEvents += 1;
    joinKeys.add(row?.joinKey);
    delegationIds.add(row?.delegationId);
    const event = row?.event;
    if (event.eventType === 'run') {
      runEvents += 1;
      continue;
    }
    measurementEvents += 1;
    const harness = resolveUsageHarness(event);
    const buckets = partitionUsageTokens(event.tokens || {}, harness);
    tokens.textInput += buckets.inputWithoutCache;
    tokens.textOutput += buckets.outputWithoutReasoning;
    tokens.cachedInput += buckets.cacheRead;
    tokens.cacheWrite += buckets.cacheWrite;
    // Diagnostic reasoning is a subcounter already inside textOutput.
    if (!buckets.reasoningDiagnostic) tokens.reasoning += buckets.reasoning;
    tokens.audioInput += buckets.audioInput;
    tokens.audioOutput += buckets.audioOutput;
    // `Number(null)` is 0, so an absent cost must be rejected before parsing:
    // an unpriced event is not a zero-cost event.
    const cost = event.usd == null ? Number.NaN : Number(event.usd);
    if (Number.isFinite(cost)) {
      pricedEvents += 1;
      if (event.estimated === true) {
        estimatedUsd += cost;
        estimatedEvents += 1;
      }
    } else {
      unpricedEvents += 1;
      if (event.billingMode === 'subscription') subscriptionEvents += 1;
    }
    const reported = event.reportedUsd == null ? Number.NaN : Number(event.reportedUsd);
    if (Number.isFinite(reported) && reported >= 0) {
      reportedUsd += reported;
      reportedUsdEvents += 1;
    }
  }

  const hasEvents = scopedEvents.length > 0;
  // An estimate is not a ledger measurement: coverage and source only count
  // events that carry a measured (non-estimated) cost.
  const measuredPricedEvents = pricedEvents - estimatedEvents;
  const costCoverage = measuredPricedEvents === 0
    ? 'none'
    : unpricedEvents === 0 && estimatedEvents === 0 ? 'complete' : 'partial';
  const notes = [];
  if (!hasEvents) notes.push('no_usage_events');
  if (unpricedEvents > 0) {
    notes.push(`cost_missing_for_${unpricedEvents}_events`);
    notes.push('cost_is_not_recomputed_from_the_rate_table');
  }
  if (subscriptionEvents > 0 && pricedEvents === 0) {
    notes.push('subscription_usage_is_not_zero_cost');
  }
  if (joinFallbackEvents > 0) notes.push('matched_by_delegation_id_without_attempt_join');
  if (estimatedEvents > 0 && pricedEvents === estimatedEvents) {
    notes.push('estimated_only_no_priced_measurement');
  }

  const scopedEstimated = scopedEvents.filter((event) => event.eventType !== 'run' && event.estimated === true && event.usd != null && Number.isFinite(Number(event.usd)));
  const scopedActual = scopedEvents.filter((event) => event.eventType !== 'run' && event.estimated !== true && event.usd != null && Number.isFinite(Number(event.usd)));

  // Contractual completeness: every attempt the delegation lifecycle promises
  // must be attested by a joined event. `missing` is null while the expected
  // set is unknown — an unknown contract is not an empty contract.
  const expectedAttempts = Array.isArray(options.expectedAttempts) ? options.expectedAttempts : null;
  const expectedKeys = new Set(
    (expectedAttempts || []).map((attempt) => todoUsageJoinKey(attempt?.delegationId, attempt?.attemptId, attempt?.runId))
  );
  const missing = expectedAttempts
    ? [...expectedKeys].filter((key) => !joinKeys.has(key)).length
    : null;
  const diagnostics = options.diagnostics && typeof options.diagnostics === 'object' ? options.diagnostics : null;
  const corrupt = Number.isFinite(Number(diagnostics?.corrupt)) ? Number(diagnostics.corrupt) : null;
  const retainedOut = Number.isFinite(Number(diagnostics?.retainedOut)) ? Number(diagnostics.retainedOut) : null;
  const ledger = { corrupt, missing, retainedOut };
  // Completeness needs real ledger evidence plus a closed contract, never
  // `missing === 0` on its own (an unknown contract would look complete).
  const complete = Boolean(
    corrupt === 0 && retainedOut === 0 && missing === 0 && expectedKeys.size > 0
  );
  if (expectedAttempts && !complete) notes.push('attempt_contract_incomplete');

  const hasMeasurement = measurementEvents > 0;
  return {
    delegations: expectedAttempts ? new Set(expectedAttempts.map((attempt) => attempt.delegationId)).size : delegationIds.size,
    attempts: expectedAttempts ? expectedAttempts.length : joinKeys.size,
    events: scopedEvents.length,
    measurementEvents,
    runEvents,
    // `null` = no priced measurement at all; `0` = the ledger really measured
    // zero. An estimate alone is not a measurement, so it stays `null`.
    usd: scopedActual.length === 0 ? null : roundUsd(scopedActual.reduce((sum, event) => sum + Number(event.usd), 0)),
    estimatedUsd: scopedEstimated.length > 0 ? roundUsd(scopedEstimated.reduce((sum, event) => sum + Number(event.usd), 0)) : null,
    reportedUsd: reportedUsdEvents > 0 ? roundUsd(reportedUsd) : null,
    tokens: hasMeasurement ? tokens : null,
    billedTokens: hasMeasurement
      ? tokens.textInput
        + tokens.textOutput
        + tokens.cachedInput
        + tokens.cacheWrite
        + tokens.reasoning
        + tokens.audioInput
        + tokens.audioOutput
      : null,
    attemptsDurationMs: sumAttemptDurationsMs(attempts),
    elapsedMs: todoElapsedMs(attempts),
    coverage: {
      state: !hasEvents ? 'no_data' : unpricedEvents === 0 ? 'complete' : 'partial',
      hasDelegations: delegationIds.size > 0,
      events: scopedEvents.length,
      measurementEvents,
      runEvents,
      pricedEvents,
      unpricedEvents,
      subscriptionEvents,
      estimatedEvents,
      reportedUsdEvents,
      joinFallbackEvents,
      costCoverage,
      costSource: measuredPricedEvents > 0 ? 'ledger' : 'none',
      notes,
      expectedAttempts: expectedAttempts ? expectedAttempts.length : null,
      ledger,
      contractual: {
        expectedAttempts: expectedAttempts ? expectedAttempts.length : null,
        observedAttempts: joinKeys.size,
        missing,
        complete,
      },
    },
    // Standard ledger roll-up of the same events. Its own `own`/`consolidated`
    // split is the *event accounting scope* (child-harness usage folded into a
    // parent event), which is a different axis from the TODO tree attribution
    // above — the two must not be confused.
    summary: summarizeUsage(scopedEvents),
    byModelRole: Object.fromEntries([...new Set(scopedEvents.map((event) => `${text(event.model) || 'unknown'}|${text(event.role) || 'unknown'}`))].map((key) => {
      const [model, role] = key.split('|');
      return [key, { model, role, ...summarizeUsage(scopedEvents.filter((event) => (text(event.model) || 'unknown') === model && (text(event.role) || 'unknown') === role)) }];
    })),
    // Both accounting subtotals side by side, on the model-filtered rows and
    // independent of the selected scope. They are alternatives: never add them.
    accountingScopes: {
      own: summarizeUsage(modelRows.filter((row) => (text(row.event.accountingScope) || 'own') === 'own').map((row) => row.event)),
      consolidated: summarizeUsage(modelRows.filter((row) => text(row.event.accountingScope) === 'consolidated').map((row) => row.event)),
    },
  };
}

type Aggregate = Record<string, any>;

/** Options of {@link buildTodoUsageStats}. */
export type TodoUsageStatsOptions = {
  scope?: string;
  model?: string;
  accountingScope?: string;
  diagnostics?: Record<string, any> | null;
  consolidatedModel?: Record<string, any>;
};
type TodoUsageStatsBase = {
  todoId: string;
  subtreeSize: number;
  descendantCount: number;
  duplicationGuard: string;
};
/** Result split by `scope`: only the requested side(s) are present. */
export type TodoUsageStatsOwn = TodoUsageStatsBase & { own: Aggregate };
export type TodoUsageStatsConsolidated = TodoUsageStatsBase & { consolidated: Aggregate };
export type TodoUsageStatsBoth = TodoUsageStatsBase & { own: Aggregate, consolidated: Aggregate, mixed: boolean };
export type TodoUsageStats = TodoUsageStatsOwn | TodoUsageStatsConsolidated | TodoUsageStatsBoth;

/**
 * Usage of one TODO, split into `own` and `consolidated`.
 *
 * Descendant attribution is read from `options.consolidatedModel` when given:
 * a row filter (status/root) selects which TODO *rows* are returned, it must
 * never drop a descendant from the `consolidated` side of its parent.
 *
 * @param {ReturnType<typeof buildTodoUsageModel>} model
 * @param {Record<string, any>[]} items
 * @param {string} todoId
 * @param {{ scope?: 'own'|'consolidated'|'both', model?: string, accountingScope?: string, diagnostics?: Record<string, any>|null, consolidatedModel?: Record<string, any> }} [options]
 * @returns {Record<string, any>|null}
 */
export function buildTodoUsageStats(model, items, todoId, options: TodoUsageStatsOptions & { scope: 'own' }): TodoUsageStatsOwn | null;
export function buildTodoUsageStats(model, items, todoId, options: TodoUsageStatsOptions & { scope: 'consolidated' }): TodoUsageStatsConsolidated | null;
export function buildTodoUsageStats(model, items, todoId, options?: TodoUsageStatsOptions): TodoUsageStatsBoth | null;
export function buildTodoUsageStats(model, items, todoId, options: TodoUsageStatsOptions = {}): TodoUsageStats | null {
  const id = text(todoId);
  const subtree = collectTodoSubtreeIds(items, id);
  if (subtree.length === 0) return null;
  const descendants = subtree.slice(1);
  const scope = TODO_USAGE_SCOPES.includes(String(options.scope || ''))
    ? String(options.scope)
    : 'both';
  const source = options.consolidatedModel && options.consolidatedModel.byTodo
    ? options.consolidatedModel
    : model;
  const ownRows = model.byTodo.get(id) || [];
  const consolidatedRows = descendants.flatMap((childId) => source.byTodo.get(childId) || []);
  const ownAttempts = model.timeline.get(id) || [];
  const consolidatedAttempts = descendants.flatMap(
    (childId) => source.timeline?.get(childId) || []
  );
  const out: TodoUsageStatsBase & { own?: Aggregate, consolidated?: Aggregate, mixed?: boolean } = {
    todoId: id,
    subtreeSize: subtree.length,
    descendantCount: descendants.length,
    // Every event belongs to exactly one TODO, so a parent roll-up can never
    // double count its children.
    duplicationGuard: 'each_event_attributed_to_exactly_one_todo',
  };
  if (scope !== 'consolidated') {
    out.own = aggregateTodoUsageRows(ownRows, ownAttempts, {
      ...options,
      expectedAttempts: todoUsageExpectedAttempts(model.index, [id]),
    });
  }
  if (scope !== 'own') {
    out.consolidated = aggregateTodoUsageRows(consolidatedRows, consolidatedAttempts, {
      ...options,
      expectedAttempts: todoUsageExpectedAttempts(model.index, descendants),
    });
  }
  if (out.own && out.consolidated) {
    out.mixed = out.own.events > 0 && out.consolidated.events > 0;
  }
  return out as TodoUsageStats;
}

/** Input of {@link todoUsageRevision}. */
export type TodoUsageRevisionInput = {
  items?: Record<string, any>[];
  delegations?: Record<string, any>[];
  events?: Record<string, any>[];
};

/**
 * Data revision of the read model, from stable fields only.
 *
 * Window instants are deliberately excluded: a rolling `30d` window moves on
 * every request, so binding a cursor to it would make every second page
 * "stale". What invalidates a page is a change in the TODO ids/updatedAt/status,
 * the delegation ids and attempt keys, or the number of ledger events.
 *
 * @param {{ items?: Record<string, any>[], delegations?: Record<string, any>[], events?: Record<string, any>[] }} input
 * @returns {string}
 */
export function todoUsageRevision(input: TodoUsageRevisionInput = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const delegations = Array.isArray(input.delegations) ? input.delegations : [];
  const events = Array.isArray(input.events) ? input.events : [];
  const payload = {
    todos: items
      .map((row) => [text(row?.id), text(row?.updatedAt)])
      .sort((a, b) => a[0].localeCompare(b[0])),
    delegations: delegations
      .map((row): [string, string, string[]] => [
        text(row?.id),
        text(row?.leafId),
        listDelegationAttempts(row)
          .map((attempt) => todoUsageJoinKey(row?.id, attempt?.attemptId, attempt?.runId))
          .sort(),
      ])
      .sort((a, b) => a[0].localeCompare(b[0])),
    events: events.length,
  };
  return sha16(JSON.stringify(payload));
}

/**
 * The filter binding carried inside a cursor. Only stable, caller-supplied
 * values: the normalized day of the window bounds, never the instants.
 *
 * @param {{ window?: Record<string, any>, root?: string, statuses?: string[], include?: string, scope?: string, model?: string, accountingScope?: string }} input
 * @returns {{ f: string }}
 */
export function todoUsageCursorBinding(input: Partial<{ window?: Record<string, any>, root?: string, statuses?: string[], include?: string, scope?: string, model?: string, accountingScope?: string }> = {}) {
  const statuses = Array.isArray(input.statuses) ? [...input.statuses].sort() : [];
  return {
    f: sha16(JSON.stringify({
      from: String(input.window?.from || '').slice(0, 10),
      to: String(input.window?.to || '').slice(0, 10),
      root: text(input.root),
      statuses,
      include: text(input.include) || 'all',
      scope: text(input.scope) || 'both',
      model: text(input.model),
      accountingScope: text(input.accountingScope) || 'own',
    })),
  };
}

/**
 * @param {number} offset
 * @returns {string}
 */
export function encodeTodoUsageCursor(offset, binding: any = {}) {
  return Buffer.from(JSON.stringify({ o: offset, ...binding }), 'utf8').toString('base64url');
}

/**
 * @param {unknown} cursor
 * @returns {{ ok: true, offset: number } | { ok: false, error: string }}
 */
export function decodeTodoUsageCursor(cursor, binding: any = {}) {
  const raw = text(cursor);
  if (!raw) return { ok: true, offset: 0 };
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Invalid cursor' };
  }
  const offset = Number(parsed?.o);
  if (!Number.isInteger(offset) || offset < 0) return { ok: false, error: 'Invalid cursor' };
  if (Object.keys(binding).length > 0) for (const [key, value] of Object.entries(binding)) if (parsed?.[key] !== value) return { ok: false, error: 'Cursor conflicts with filters or data revision', code: 'CONFLICT' };
  return { ok: true, offset };
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, limit: number } | { ok: false, error: string }}
 */
export function resolveTodoUsageLimit(value) {
  const raw = text(value);
  if (!raw) return { ok: true, limit: TODO_USAGE_DEFAULT_LIMIT };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > TODO_USAGE_MAX_LIMIT) {
    return { ok: false, error: `Invalid limit (1..${TODO_USAGE_MAX_LIMIT})` };
  }
  return { ok: true, limit: parsed };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseStatusFilter(value) {
  return text(value)
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
}

/**
 * Validates a caller query into a window + pagination + filters.
 *
 * @param {Record<string, any>} [query]
 * @param {{ now?: number, defaultTz?: string }} [options]
 * @returns {{ ok: true, window: Record<string, any>, limit: number, offset: number, cursor: string, scope: string, include: string, status: string[], root: string, model: string } | { ok: false, error: string, code: 'VALIDATION' }}
 */
export function resolveTodoUsageQuery(query: Record<string, any> = {}, options: Partial<{ now?: number, defaultTz?: string }> = {}) {
  const source = query && typeof query === 'object' ? query : {};
  const hasRangeInput = Boolean(text(source.range) || text(source.from) || text(source.to));
  const windowInput = hasRangeInput
    ? { ...source }
    : { ...source, range: `${TODO_USAGE_DEFAULT_WINDOW_DAYS}d` };
  const window = resolveUsageWindow({
    ...windowInput,
    maxDays: TODO_USAGE_MAX_WINDOW_DAYS,
    now: options.now,
    defaultTz: options.defaultTz,
  });
  if (!window.ok) return { ok: false, error: window.error, code: 'VALIDATION' };

  const limit = resolveTodoUsageLimit(source.limit);
  if (!limit.ok) return { ok: false, error: limit.error, code: 'VALIDATION' };
  const cursor = decodeTodoUsageCursor(source.cursor);
  if (!cursor.ok) return { ok: false, error: cursor.error, code: cursor.code || 'VALIDATION' };

  const scopeRaw = text(source.scope) || 'both';
  if (!TODO_USAGE_SCOPES.includes(scopeRaw)) {
    return { ok: false, error: `Invalid scope (${TODO_USAGE_SCOPES.join('|')})`, code: 'VALIDATION' };
  }
  const includeRaw = text(source.include) || 'all';
  if (!TODO_USAGE_INCLUDES.includes(includeRaw)) {
    return { ok: false, error: `Invalid include (${TODO_USAGE_INCLUDES.join('|')})`, code: 'VALIDATION' };
  }
  // `own` and `consolidated` are alternative accounting scopes; `both` would
  // sum them and double count child-harness usage, so it is rejected.
  const accountingRaw = text(source.accountingScope) || 'own';
  if (!TODO_USAGE_ACCOUNTING_SCOPES.includes(accountingRaw)) {
    return {
      ok: false,
      error: `Invalid accountingScope (${TODO_USAGE_ACCOUNTING_SCOPES.join('|')})`,
      code: 'VALIDATION',
    };
  }

  return {
    ok: true,
    window,
    limit: limit.limit,
    offset: cursor.offset,
    cursor: text(source.cursor),
    scope: scopeRaw,
    include: includeRaw,
    status: parseStatusFilter(source.status),
    root: text(source.root),
    model: text(source.model),
    accountingScope: accountingRaw,
  };
}

/**
 * The unjoinable events of one workspace view.
 *
 * The ledger schema stamps `workspaceFile` on an event only when the writer
 * knew it; there is no `workspaceFolder` field. An event without any workspace
 * key can never be claimed by a workspace, so it is reported as a separate
 * `unscopedEvents` diagnostic and is never summed into `events`. Only events
 * keyed to this workspace count as its own unattributed events.
 *
 * @param {{ unmatched?: Record<string, any>[], duplicates?: number }} model
 * @param {unknown} cwd
 * @returns {{ events: number, duplicateEvents: number, unscopedEvents: number }}
 */
function unattributedSummary(model, cwd) {
  const unmatched = Array.isArray(model?.unmatched) ? model.unmatched : [];
  const key = text(cwd);
  const keyOf = (event) => text(event?.workspaceFile);
  return {
    // No delegation id, an unknown delegation, or a delegation without leafId,
    // and stamped with this workspace.
    events: key ? unmatched.filter((event) => keyOf(event) === key).length : 0,
    // Repeated deliveries of one logical event, dropped so a retry never
    // doubles the numbers.
    duplicateEvents: Number(model?.duplicates) || 0,
    // Unjoined events with no workspace key: not summed anywhere.
    unscopedEvents: unmatched.filter((event) => !keyOf(event)).length,
  };
}

/** Input of {@link buildWorkspaceTodoUsage}. */
export type WorkspaceTodoUsageInput = {
  items?: Record<string, any>[];
  delegations?: Record<string, any>[];
  events?: Record<string, any>[];
  window?: Record<string, any>;
  limit?: number;
  offset?: number;
  cursor?: string;
  cwd?: string;
  diagnostics?: Record<string, any> | null;
  scope?: string;
  include?: string;
  status?: string[];
  root?: string;
  model?: string;
  accountingScope?: string;
};

/**
 * Workspace-wide TODO usage view: one row per TODO plus a workspace roll-up
 * that counts every joined event exactly once.
 *
 * Row order is deterministic (TODO id ascending) so a cursor page never
 * repeats or skips a row.
 *
 * @param {{
 *   items?: Record<string, any>[],
 *   delegations?: Record<string, any>[],
 *   events?: Record<string, any>[],
 *   window?: Record<string, any>,
 *   limit?: number,
 *   offset?: number,
 *   cursor?: string,
 *   cwd?: string,
 *   diagnostics?: Record<string, any>|null,
 *   scope?: string,
 *   include?: string,
 *   status?: string[],
 *   root?: string,
 *   model?: string,
 *   accountingScope?: string,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildWorkspaceTodoUsage(input: WorkspaceTodoUsageInput = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const delegations = Array.isArray(input.delegations) ? input.delegations : [];
  const model = buildTodoUsageModel(input);
  const scope = TODO_USAGE_SCOPES.includes(String(input.scope || '')) ? String(input.scope) : 'both';
  const accountingScope = TODO_USAGE_ACCOUNTING_SCOPES.includes(text(input.accountingScope))
    ? text(input.accountingScope)
    : 'own';
  const modelFilter = text(input.model);

  let candidates = items;
  const root = text(input.root);
  if (root) {
    const subtree = new Set(collectTodoSubtreeIds(items, root));
    candidates = items.filter((row) => subtree.has(String(row?.id || '')));
  }
  const statuses = Array.isArray(input.status) ? input.status.filter(Boolean) : [];
  if (statuses.length > 0) {
    const allowed = new Set(statuses);
    candidates = candidates.filter((row) => allowed.has(String(row?.status || '')));
  }

  const selectedLeafIds = new Set(candidates.map((row) => String(row?.id || '')));
  // Event-level filters (model) apply everywhere; the accounting scope is
  // applied per aggregate so both subtotals stay reportable side by side.
  const eventModel = { ...model, byTodo: new Map() };
  for (const [todoId, rows] of model.byTodo) {
    const filtered = rows.filter(
      ({ event }) => !modelFilter || text(event.model) === modelFilter
    );
    if (filtered.length) eventModel.byTodo.set(todoId, filtered);
  }
  // Row-level filters (status/root) select which rows are returned. They must
  // not remove a descendant from the `consolidated` side of its parent, so the
  // row view narrows by id while attribution still reads `eventModel`.
  const rowModel = {
    ...eventModel,
    byTodo: new Map([...eventModel.byTodo].filter(([todoId]) => selectedLeafIds.has(todoId))),
  };
  const rows = candidates
    .map((item) => ({
      item,
      stats: buildTodoUsageStats(rowModel, items, String(item?.id || ''), {
        scope,
        model: modelFilter,
        accountingScope,
        diagnostics: input.diagnostics || null,
        consolidatedModel: eventModel,
      }),
    }))
    .filter((row) => row.stats !== null);

  const visible = String(input.include || 'all') === 'usage'
    ? rows.filter(
      (row) =>
        (row.stats.own && row.stats.own.events > 0)
        || (row.stats.consolidated && row.stats.consolidated.events > 0)
    )
    : rows;

  const ordered = [...visible].sort((a, b) => {
    return String(a.item?.id || '').localeCompare(String(b.item?.id || ''));
  });

  const limit = Number.isInteger(input.limit) ? Number(input.limit) : TODO_USAGE_DEFAULT_LIMIT;
  // Workspace roll-up: the union of every event attributed to a TODO of this
  // workspace. Each event belongs to exactly one TODO, so this is not the sum
  // of the `consolidated` columns (those overlap by design).
  const workspaceIds = selectedLeafIds;
  const workspaceRows = [];
  for (const [todoId, list] of eventModel.byTodo.entries()) {
    if (!workspaceIds.has(todoId)) continue;
    workspaceRows.push(...list.filter(
      ({ event }) => (text(event.accountingScope) || 'own') === accountingScope
    ));
  }
  const allAttempts = [];
  for (const [todoId, list] of model.timeline.entries()) {
    if (!workspaceIds.has(todoId)) continue;
    allAttempts.push(...list);
  }

  const revision = todoUsageRevision({ items, delegations, events: input.events || [] });
  const cursorBinding = {
    ...todoUsageCursorBinding({
      window: input.window,
      root,
      statuses,
      include: input.include || 'all',
      scope,
      model: modelFilter,
      accountingScope,
    }),
    r: revision,
  };
  const cursor = input.cursor ? decodeTodoUsageCursor(input.cursor, cursorBinding) : { ok: true, offset: Number.isInteger(input.offset) ? input.offset : 0 };
  if (!cursor.ok) { throw Object.assign(new Error('Usage cursor is stale; restart pagination'), { code: 'CONFLICT' }); }
  const offset = cursor.offset;
  const page = ordered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const workspace = aggregateTodoUsageRows(workspaceRows, allAttempts, {
    model: modelFilter,
    accountingScope,
    diagnostics: input.diagnostics || null,
    expectedAttempts: todoUsageExpectedAttempts(model.index, [...workspaceIds]),
  });
  const unattributed = unattributedSummary(model, input.cwd);
  return {
    asOf: new Date().toISOString(),
    appliedFilters: { root: root || null, status: statuses, model: modelFilter || null, scope, include: input.include || 'all', accountingScope },
    currency: 'USD',
    scope,
    limit,
    offset,
    total: ordered.length,
    returned: page.length,
    nextCursor: nextOffset < ordered.length ? encodeTodoUsageCursor(nextOffset, cursorBinding) : null,
    todos: page.map((row) => ({
      todoId: row.stats.todoId,
      title: String(row.item?.title || '').trim(),
      status: String(row.item?.status || '').trim(),
      parentId: String(row.item?.parentId || '').trim(),
      subtreeSize: row.stats.subtreeSize,
      ...(row.stats.own ? { own: row.stats.own } : {}),
      ...(row.stats.consolidated ? { consolidated: row.stats.consolidated } : {}),
      ...(row.stats.mixed !== undefined ? { mixed: row.stats.mixed } : {}),
    })),
    workspace,
    unattributed,
    diagnostics: {
      unscopedEvents: unattributed.unscopedEvents,
      unscopedLabel: TODO_USAGE_UNATTRIBUTED_LABEL,
      ledger: workspace.coverage.ledger,
    },
  };
}
