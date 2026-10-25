/**
 * Pure "top consumers" aggregation over usage events.
 *
 * Cache reads are 95–99% of all tokens, so a raw token total says little about
 * where limits burn. Every row therefore carries `fresh` tokens (input without
 * cache + cache write + output + reasoning) next to the cache-read volume, and
 * rankings default to `fresh`. No I/O: callers pass events and delegations.
 */

import { sumUsageCost, sumUsageTokenBuckets } from './usage-insights.ts';
import { buildDelegationJoinIndex, joinTodoUsageEvents } from './todo-usage.ts';
import { formatZoneDay } from './usage-window.ts';

export const USAGE_TOP_GROUPS = Object.freeze(['chat', 'delegation', 'leaf', 'model', 'harness', 'role', 'cycle', 'day', 'resume']);
export const USAGE_TOP_METRICS = Object.freeze(['fresh', 'total', 'output', 'weighted', 'cacheRead', 'usd', 'events', 'limitHits']);
export const USAGE_EXPLAIN_SUBJECTS = Object.freeze(['chat', 'delegation', 'leaf', 'cycle']);
/** Relative price of a cache read vs a fresh token; used only for the `weighted` comparison metric. */
export const CACHE_READ_PRICE_RATIO = 0.1;
export const USAGE_TOP_DEFAULT_LIMIT = 20;
export const USAGE_TOP_MAX_LIMIT = 200;
/** Resume axis: harness|role|resumed or harness|role|fresh, from the delegation's sessionResume record. */
export const USAGE_TOP_RESUMED = 'resumed';
export const USAGE_TOP_FRESH_SESSION = 'fresh';
/** Fallback bucket for starts refused by the optional resume round cap. */
export const USAGE_TOP_RESUME_CONTEXT_CAP = 'resume_context_cap';
export const USAGE_TOP_UNATTRIBUTED = '(unattributed)';
/** Leaf axis: usage from plain chats and watcher orchestrator chats (no delegation). */
export const USAGE_TOP_NOT_DELEGATED = '(not delegated)';
/** Leaf axis: carries a delegationId but the attempt is missing from the delegation record. */
export const USAGE_TOP_UNJOINED = '(delegation not joined)';

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {Record<string, any>} event
 * @returns {string}
 */
function modelKey(event) {
  return `${text(event.harness) || 'other'}|${text(event.model) || 'unknown'}`;
}

/**
 * @param {string} groupBy
 * @param {string} tz
 * @returns {(event: Record<string, any>) => string}
 */
function groupKeyFn(groupBy, tz) {
  switch (groupBy) {
    case 'chat': return (e) => text(e.chatId) || USAGE_TOP_UNATTRIBUTED;
    case 'delegation': return (e) => text(e.delegationId) || USAGE_TOP_UNATTRIBUTED;
    case 'cycle': return (e) => text(e.cycleId) || USAGE_TOP_UNATTRIBUTED;
    case 'model': return modelKey;
    case 'harness': return (e) => text(e.harness) || 'other';
    case 'role': return (e) => text(e.role) || '-';
    case 'day': return (e) => {
      const ms = Date.parse(text(e.at));
      return Number.isFinite(ms) ? formatZoneDay(ms, tz) : 'unknown';
    };
    default: return () => USAGE_TOP_UNATTRIBUTED;
  }
}

/**
 * @param {Record<string, any>[]} events
 * @returns {Record<string, any>}
 */
export function summarizeUsageGroup(events) {
  const buckets = sumUsageTokenBuckets(events);
  const cost = sumUsageCost(events);
  const fresh = buckets.inputWithoutCache + buckets.cacheWrite + buckets.outputWithoutReasoning + buckets.reasoning;
  const measured = events.filter((e) => e.eventType !== 'run');
  const runEvents = events.filter((e) => e.eventType === 'run');
  const harnesses = new Set();
  const models = new Set();
  const roles = new Set();
  const attempts = new Set();
  const delegationIds = new Set();
  const delegationsSeen = new Set();
  for (const e of events) {
    if (text(e.harness)) harnesses.add(text(e.harness));
    if (text(e.model)) models.add(text(e.model));
    if (text(e.role)) roles.add(text(e.role));
    if (text(e.attemptId)) attempts.add(text(e.attemptId));
    if (text(e.delegationId)) delegationsSeen.add(text(e.delegationId));
    if (text(e.delegationId) && e.eventType !== 'run') delegationIds.add(text(e.delegationId));
  }
  return {
    events: measured.length,
    runs: runEvents.length,
    limitHits: runEvents.filter((e) => e.outcome === 'limit').length,
    errorRuns: runEvents.filter((e) => e.outcome === 'error').length,
    fresh,
    total: buckets.totalTokens,
    output: buckets.outputWithoutReasoning + buckets.reasoning,
    cacheRead: buckets.cacheRead,
    cacheWrite: buckets.cacheWrite,
    inputWithoutCache: buckets.inputWithoutCache,
    // Cost-like index: cache reads priced at CACHE_READ_PRICE_RATIO of a fresh token.
    weighted: Math.round(fresh + buckets.cacheRead * CACHE_READ_PRICE_RATIO),
    cacheShare: buckets.cacheShare,
    // Mean prompt volume per measured event: a context-size proxy for long sessions.
    avgContextPerEvent: measured.length > 0
      ? Math.round((buckets.inputWithoutCache + buckets.cacheRead + buckets.cacheWrite) / measured.length)
      : null,
    usd: Number((cost.actualUsd + cost.estimatedUsd).toFixed(6)),
    costPartial: cost.partial,
    attempts: attempts.size,
    delegations: delegationIds.size,
    // Delegations seen in any event (incl. run markers); `delegations` counts only measured ones.
    delegationsSeen: delegationsSeen.size,
    harnesses: [...harnesses].sort(),
    models: [...models].sort(),
    roles: [...roles].sort(),
  };
}

/**
 * @param {Record<string, any>} row
 * @param {string} metric
 * @returns {number}
 */
function metricValue(row, metric) {
  const value = Number(row[metric]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * @param {Record<string, any>[]} events
 * @param {Record<string, any>[]} delegations
 * @returns {Map<string, Record<string, any>[]>}
 */
function groupByLeaf(events, delegations) {
  const index = buildDelegationJoinIndex(delegations);
  const { matched, unmatched } = joinTodoUsageEvents(events, index);
  const groups = new Map();
  for (const hit of matched) {
    (groups.get(hit.todoId) || groups.set(hit.todoId, []).get(hit.todoId)).push(hit.event);
  }
  const notDelegated = unmatched.filter((e) => !text(e.delegationId));
  const unjoined = unmatched.filter((e) => text(e.delegationId));
  if (notDelegated.length) groups.set(USAGE_TOP_NOT_DELEGATED, notDelegated);
  if (unjoined.length) groups.set(USAGE_TOP_UNJOINED, unjoined);
  return groups;
}

export const HEAVY_CONTEXT_FACTOR = 3;
export const HEAVY_CONTEXT_MIN_EVENTS = 5;
export const HEAVY_CONTEXT_MIN_FRESH = 1_000_000;

/**
 * Context sizes are not comparable across harnesses (a codex event is a whole
 * turn, a deepseek event one message), so a chat is flagged against the median
 * prompt volume of chats on the same harness: `heavy_context` means "much
 * larger than its peers and already costly" - a restart or compaction candidate.
 *
 * @param {Record<string, any>[]} rows chat rows, mutated in place
 */
function flagHeavyContext(rows) {
  const byHarness = new Map();
  for (const row of rows) {
    if (row.avgContextPerEvent == null || row.events < HEAVY_CONTEXT_MIN_EVENTS) continue;
    const harness = row.harnesses[0] || 'other';
    (byHarness.get(harness) || byHarness.set(harness, []).get(harness)).push(row.avgContextPerEvent);
  }
  const median = new Map([...byHarness].map(([h, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return [h, sorted[Math.floor(sorted.length / 2)]];
  }));
  for (const row of rows) {
    const base = median.get(row.harnesses[0] || 'other');
    const heavy = base > 0 && row.events >= HEAVY_CONTEXT_MIN_EVENTS && row.fresh >= HEAVY_CONTEXT_MIN_FRESH
      && row.avgContextPerEvent >= base * HEAVY_CONTEXT_FACTOR;
    row.flags = heavy ? ['heavy_context'] : [];
  }
}

/**
 * @param {Record<string, any>[]} events
 * @param {(event: Record<string, any>) => string} keyOf
 * @returns {Map<string, Record<string, any>[]>}
 */
function groupByKey(events, keyOf) {
  const map = new Map();
  for (const e of events) {
    const key = keyOf(e);
    (map.get(key) || map.set(key, []).get(key)).push(e);
  }
  return map;
}

/**
 * Splits delegated usage by whether the delegation re-entered an earlier
 * session (`sessionResume.reasonCode === 'resumed'`), per harness and role.
 *
 * @param {Record<string, any>[]} events
 * @param {Record<string, any>[]} delegations
 * @returns {Map<string, Record<string, any>[]>}
 */
function groupByResume(events, delegations) {
  const resumedIds = new Set();
  const cappedIds = new Set();
  const known = new Set();
  for (const d of Array.isArray(delegations) ? delegations : []) {
    const id = text(d?.id);
    if (!id) continue;
    known.add(id);
    if (d.sessionResume?.reasonCode === 'resumed') resumedIds.add(id);
    else if (d.sessionResume?.reasonCode === USAGE_TOP_RESUME_CONTEXT_CAP) cappedIds.add(id);
  }
  const groups = new Map();
  for (const e of events) {
    const id = text(e.delegationId);
    const key = id && known.has(id)
      ? `${text(e.harness) || 'other'}|${text(e.role) || '-'}|${resumedIds.has(id) ? USAGE_TOP_RESUMED : cappedIds.has(id) ? USAGE_TOP_RESUME_CONTEXT_CAP : USAGE_TOP_FRESH_SESSION}`
      : USAGE_TOP_NOT_DELEGATED;
    (groups.get(key) || groups.set(key, []).get(key)).push(e);
  }
  return groups;
}

/**
 * Ranks consumers along one axis.
 *
 * @param {{
 *   events: Record<string, any>[],
 *   delegations?: Record<string, any>[],
 *   groupBy?: string,
 *   metric?: string,
 *   limit?: number,
 *   tz?: string,
 *   labels?: Map<string, string>,
 * }} input
 * @returns {{ groupBy: string, metric: string, totals: Record<string, any>, rows: Record<string, any>[], truncated: boolean, groups: number }}
 */
export function buildUsageTop(input: Partial<{ events: Record<string, any>[], delegations?: Record<string, any>[], groupBy?: string, metric?: string, limit?: number, tz?: string, labels?: Map<string, string> }> = {}) {
  const events = Array.isArray(input.events) ? input.events.filter((e) => e && typeof e === 'object') : [];
  const groupBy = USAGE_TOP_GROUPS.includes(input.groupBy) ? input.groupBy : 'chat';
  const metric = USAGE_TOP_METRICS.includes(input.metric) ? input.metric : 'fresh';
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, USAGE_TOP_MAX_LIMIT) : USAGE_TOP_DEFAULT_LIMIT;
  const groups = groupBy === 'leaf'
    ? groupByLeaf(events, input.delegations)
    : groupBy === 'resume'
      ? groupByResume(events, input.delegations)
      : groupByKey(events, groupKeyFn(groupBy, input.tz || 'UTC'));
  const totals = summarizeUsageGroup(events);
  const rows = [...groups].map(([key, list]) => {
    const row: Record<string, any> = { key, ...summarizeUsageGroup(list) };
    const label = input.labels?.get(key);
    if (label) row.label = label;
    row.shareOfFresh = totals.fresh > 0 ? Number((row.fresh / totals.fresh).toFixed(4)) : null;
    // Rounds a leaf/delegation needed: fresh tokens per attempt shows what one PASS cost.
    row.freshPerAttempt = row.attempts > 0 ? Math.round(row.fresh / row.attempts) : null;
    row.freshPerDelegation = row.delegations > 0 ? Math.round(row.fresh / row.delegations) : null;
    row.weightedPerDelegation = row.delegations > 0 ? Math.round(row.weighted / row.delegations) : null;
    return row;
  });
  if (groupBy === 'chat') flagHeavyContext(rows);
  rows.sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || String(a.key).localeCompare(String(b.key)));
  return {
    groupBy,
    metric,
    totals,
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    groups: rows.length,
  };
}

/**
 * Filters events to one subject (chat, delegation, leaf or cycle).
 *
 * @param {Record<string, any>[]} events
 * @param {Record<string, any>[]} delegations
 * @param {{ type: string, id: string }} subject
 * @returns {Record<string, any>[]}
 */
export function selectSubjectEvents(events, delegations, subject) {
  const id = text(subject?.id);
  if (!id) return [];
  if (subject.type === 'chat') return events.filter((e) => text(e.chatId) === id);
  if (subject.type === 'delegation') return events.filter((e) => text(e.delegationId) === id);
  if (subject.type === 'cycle') return events.filter((e) => text(e.cycleId) === id);
  return groupByLeaf(events, delegations).get(id) || [];
}

/**
 * Drill-down for one subject: breakdown by role/model/run/day plus the
 * single most expensive measurements, so a spike can be traced to a turn.
 *
 * @param {{ events: Record<string, any>[], delegations?: Record<string, any>[], subject: { type: string, id: string }, limit?: number, tz?: string }} input
 * @returns {Record<string, any>}
 */
export function explainUsage(input: Partial<{ events: Record<string, any>[], delegations?: Record<string, any>[], subject: { type: string, id: string }, limit?: number, tz?: string }> = {}) {
  const subject = { type: USAGE_EXPLAIN_SUBJECTS.includes(input.subject?.type) ? input.subject.type : 'chat', id: text(input.subject?.id) };
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, USAGE_TOP_MAX_LIMIT) : 10;
  const events = selectSubjectEvents(Array.isArray(input.events) ? input.events : [], input.delegations || [], subject);
  const part = (groupBy) => buildUsageTop({ events, groupBy, metric: 'fresh', limit, tz: input.tz }).rows;
  const byRun = new Map();
  for (const e of events) {
    const key = text(e.runId) || USAGE_TOP_UNATTRIBUTED;
    (byRun.get(key) || byRun.set(key, []).get(key)).push(e);
  }
  const runs = [...byRun].map(([key, list]) => ({ key, ...summarizeUsageGroup(list), startedAt: list.map((e) => text(e.at)).filter(Boolean).sort()[0] || null }))
    .sort((a, b) => b.fresh - a.fresh)
    .slice(0, limit);
  const topEvents = events
    .filter((e) => e.eventType !== 'run')
    .map((e) => ({ e, s: summarizeUsageGroup([e]) }))
    .sort((a, b) => b.s.fresh - a.s.fresh)
    .slice(0, limit)
    .map(({ e, s }) => ({
      at: text(e.at),
      harness: text(e.harness),
      model: text(e.model),
      role: text(e.role),
      runId: text(e.runId) || null,
      fresh: s.fresh,
      cacheRead: s.cacheRead,
      output: s.output,
    }));
  return {
    subject,
    found: events.length > 0,
    totals: summarizeUsageGroup(events),
    byRole: part('role'),
    byModel: part('model'),
    byDay: part('day'),
    topRuns: runs,
    topEvents,
  };
}
