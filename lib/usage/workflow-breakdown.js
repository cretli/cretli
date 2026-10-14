/**
 * Usage grouped by delegation workflow leaf and round.
 *
 * Pure read model: no I/O. The ledger already stamps `delegationId`,
 * `attemptId` and `runId` on delegated usage, and the delegation rows carry the
 * leaf and the attempt chronology, so a "round" is the 1-based ordinal of an
 * attempt among the attempts of one leaf. No new ledger field is needed.
 *
 * Events are attributed through the same exact join as the TODO usage model, so
 * a replayed logical event is counted once and an unmatched event is reported
 * separately instead of being folded into a round.
 */

import { buildDelegationJoinIndex, joinTodoUsageEvents } from './todo-usage.js';
import { sumUsageCost, sumUsageTokenBuckets } from './usage-insights.js';

const MAX_ROWS = 200;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {object} attempt
 * @returns {number}
 */
function attemptTimeMs(attempt) {
  const ms = Date.parse(text(attempt?.startedAt) || text(attempt?.queuedAt));
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

/**
 * `keepAlivePings` (`{ leafId, delegationId, chatId, runId }`) attributes the
 * paid keep-alive turns: their usage events carry no delegation id, so they are
 * matched by run id and reported as a separate `keep_alive` row per leaf. They
 * never inflate a review round and are not counted as unmatched.
 *
 * @param {{ events?: object[], delegations?: object[], limit?: number, keepAlivePings?: object[] }} [input]
 * @returns {{ rows: object[], unmatched: { events: number }, duplicates: number, truncated: boolean }}
 */
export function buildWorkflowBreakdown(input = {}) {
  const index = buildDelegationJoinIndex(input.delegations);
  const pingByRun = new Map();
  for (const ping of Array.isArray(input.keepAlivePings) ? input.keepAlivePings : []) {
    const runId = text(ping?.runId);
    if (runId) pingByRun.set(`${text(ping.chatId)}|${runId}`, ping);
  }
  const pingEvents = new Map();
  const ordinary = [];
  for (const event of Array.isArray(input.events) ? input.events : []) {
    const ping = event && !text(event.delegationId)
      ? pingByRun.get(`${text(event.chatId)}|${text(event.runId)}`)
      : null;
    if (!ping) {
      ordinary.push(event);
      continue;
    }
    const key = `${text(ping.leafId)}|${text(ping.delegationId)}`;
    const list = pingEvents.get(key) || { ping, events: [] };
    list.events.push(event);
    pingEvents.set(key, list);
  }
  const { matched, unmatched, duplicates } = joinTodoUsageEvents(ordinary, index);
  // Round ordinal per leaf, from the deduped attempt chronology.
  const attemptsByLeaf = new Map();
  for (const hit of index.byKey.values()) {
    if (!hit.todoId) continue;
    const list = attemptsByLeaf.get(hit.todoId) || [];
    list.push({ key: `${hit.delegationId}|${text(hit.attempt.attemptId)}`, attempt: hit.attempt, delegationId: hit.delegationId });
    attemptsByLeaf.set(hit.todoId, list);
  }
  const roundOf = new Map();
  for (const list of attemptsByLeaf.values()) {
    list.sort((a, b) => attemptTimeMs(a.attempt) - attemptTimeMs(b.attempt));
    list.forEach((item, i) => roundOf.set(item.key, i + 1));
  }
  const groups = new Map();
  for (const row of matched) {
    const attemptId = text(row.event.attemptId);
    const round = roundOf.get(`${row.delegationId}|${attemptId}`) ?? null;
    const key = `${row.todoId}|${round ?? ''}|${row.delegationId}`;
    let group = groups.get(key);
    if (!group) {
      group = { leafId: row.todoId, round, delegationId: row.delegationId, role: text(row.event.role) || null, events: [] };
      groups.set(key, group);
    }
    group.events.push(row.event);
  }
  const all = [...groups.values()]
    .map((group) => ({
      leafId: group.leafId,
      round: group.round,
      delegationId: group.delegationId,
      role: group.role,
      tokens: sumUsageTokenBuckets(group.events),
      // Cost origin stays split: measured (reported/actual) vs estimated.
      cost: sumUsageCost(group.events),
    }))
    .sort((a, b) => a.leafId.localeCompare(b.leafId) || (a.round ?? 1e9) - (b.round ?? 1e9));
  for (const { ping, events } of pingEvents.values()) {
    all.push({
      leafId: text(ping.leafId),
      round: null,
      delegationId: text(ping.delegationId),
      role: 'keep_alive',
      tokens: sumUsageTokenBuckets(events),
      cost: sumUsageCost(events),
    });
  }
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : MAX_ROWS;
  return {
    rows: all.slice(0, limit),
    unmatched: { events: unmatched.length },
    duplicates,
    truncated: all.length > limit,
  };
}
