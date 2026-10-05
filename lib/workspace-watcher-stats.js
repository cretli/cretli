/**
 * Workspace Watcher monitoring statistics (TODO "Monitoring Dashboard").
 *
 * The watcher already persists the raw material for observability — bounded
 * `cycleChats` (closed cycles with `startedAt`/`at`/`outcome`), the decision
 * log, and the delegation store — but none of it is aggregated for a human.
 * This module turns those records into the numbers the Settings dashboard
 * renders: throughput, success rate, common stop reasons, and top harnesses by
 * delegation count and pass rate.
 *
 * The aggregation helpers are pure (clock and rows injected) so the timing and
 * bucketing rules are unit-testable in Node without a store. `getWorkspaceWatcherStats`
 * is the only function that reads the persisted watcher row and delegation
 * records, and it degrades to empty counters when a read fails so a damaged
 * delegation file can never take down the monitoring view.
 */

import {
  WORKSPACE_WATCHER_CYCLE_OUTCOMES,
  WORKSPACE_WATCHER_MAX_CYCLE_CHATS,
  getWorkspaceWatcher,
  normalizeWorkspaceFolder,
  normalizeWorkspaceWatcherRow,
} from './persist/workspace-watchers-persist.js';
import { loadDelegations } from './persist/delegations-persist.js';
import { isDelegationSlotOccupied } from './delegation-status.js';
import { workspaceWatcherUtcDayKey } from './workspace-watcher-guardrails.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** Decision kinds that represent "the watcher parked itself" — the halt/attention
 *  set the "most common stop reasons" stat aggregates. Kept as the closed
 *  vocabulary the guardrails and cycle modules actually emit, so the dashboard
 *  never invents a reason that no producer writes. */
export const WORKSPACE_WATCHER_STOP_REASON_KINDS = Object.freeze([
  'cycle_failed',
  'orchestrator_blocked',
  'paused',
  'stopped',
  'wait_quiet_hours',
  'wait_budget',
  'wait_cooldown',
  'backoff',
  'wait_same_findings',
  'wait_harness_usage',
  'wait_plan_approval',
  'plan_gate',
]);

/**
 * Parse a stored timestamp into a finite epoch ms, or null when unusable.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseMs(value) {
  const ms = Date.parse(String(value ?? '').trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Round a 0..1 ratio to 4 decimals, or null when there is no denominator.
 *
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number | null}
 */
function ratioOr(numerator, denominator) {
  if (!denominator || denominator <= 0) return null;
  const value = numerator / denominator;
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The Monday 00:00 UTC calendar week a moment falls in, as `YYYY-MM-DD`.
 *
 * @param {number} ms
 * @returns {string}
 */
function utcWeekStartKey(ms) {
  const date = new Date(ms);
  const day = date.getUTCDay();
  const offset = (day + 6) % 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset));
  return monday.toISOString().slice(0, 10);
}

/**
 * Normalize one stored `cycleChats` entry into a timeline-ready record.
 *
 * @param {object} entry
 * @returns {{ cycleId: string, chatId: string, todoIds: string[], startedAt: string, at: string, outcome: string, startMs: number | null, endMs: number | null, durationMs: number | null }}
 */
function normalizeCycleEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const startedAt = String(source.startedAt ?? '').trim();
  const at = String(source.at ?? '').trim();
  const endMs = parseMs(at);
  // The Gantt needs a start position; a legacy entry without `startedAt` falls
  // back to the close instant so it still renders (as a point). The duration,
  // however, stays null unless the real start is known, so the UI reports "no
  // duration" rather than a misleading zero.
  const realStartMs = parseMs(startedAt);
  const startMs = realStartMs ?? endMs;
  const durationMs = realStartMs != null && endMs != null && endMs >= realStartMs
    ? endMs - realStartMs
    : null;
  const outcomeRaw = String(source.outcome ?? '').trim().toLowerCase();
  return {
    cycleId: String(source.cycleId ?? '').trim(),
    chatId: String(source.id ?? '').trim(),
    todoIds: Array.isArray(source.todoIds) ? source.todoIds.map((id) => String(id ?? '').trim()).filter(Boolean) : [],
    startedAt,
    at,
    outcome: WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(outcomeRaw) ? outcomeRaw : '',
    harness: String(source.harness ?? '').trim(),
    startMs,
    endMs,
    durationMs,
  };
}

/**
 * Aggregate the bounded `cycleChats` window into cycle throughput, outcome mix,
 * success rate, average duration and the daily/weekly buckets the dashboard
 * renders. Everything is relative to `now` (injected) so tests are deterministic.
 *
 * @param {object[] | null | undefined} cycleChats
 * @param {{ now?: number, recentCap?: number, dailyDays?: number, weeklyWeeks?: number }} [options]
 * @returns {object}
 */
export function summarizeWatcherCycles(cycleChats, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const recentCap = Math.max(1, Number(options.recentCap) || WORKSPACE_WATCHER_MAX_CYCLE_CHATS);
  const dailyDays = Math.max(1, Math.floor(Number(options.dailyDays) || 7));
  const weeklyWeeks = Math.max(1, Math.floor(Number(options.weeklyWeeks) || 6));

  const entries = (Array.isArray(cycleChats) ? cycleChats : [])
    .map(normalizeCycleEntry)
    .filter((entry) => entry.chatId || entry.cycleId || entry.endMs != null);

  const outcomes = { success: 0, failure: 0, blocked: 0 };
  let durationSum = 0;
  let durationCount = 0;
  let timed = 0;
  for (const entry of entries) {
    if (entry.outcome && outcomes[entry.outcome] != null) outcomes[entry.outcome] += 1;
    if (entry.endMs != null) timed += 1;
    if (entry.durationMs != null) {
      durationSum += entry.durationMs;
      durationCount += 1;
    }
  }

  // Daily buckets: the last `dailyDays` UTC days (oldest first), so a gap shows
  // as a zero rather than a missing label. Weekly buckets span `weeklyWeeks`
  // UTC weeks. Throughput counts *completed TODOs* (distinct todo ids from
  // success cycles), never closed cycles: a failure or blocked cycle adds no
  // throughput. `success` equals the completed count; `failure`/`blocked` are
  // the distinct todo ids attempted (and not completed) that day, kept purely
  // for the tooltip and deliberately excluded from `total`.
  const dailyMap = new Map();
  for (let offset = dailyDays - 1; offset >= 0; offset -= 1) {
    const day = workspaceWatcherUtcDayKey(now - offset * MS_PER_DAY);
    dailyMap.set(day, { day, total: 0, success: 0, failure: 0, blocked: 0 });
  }
  const weeklyMap = new Map();
  for (let offset = weeklyWeeks - 1; offset >= 0; offset -= 1) {
    const week = utcWeekStartKey(now - offset * MS_PER_WEEK);
    if (!weeklyMap.has(week)) weeklyMap.set(week, { week, total: 0, success: 0 });
  }

  // Credit each completed todo once, on the day/week of its earliest success
  // close, so a todo re-run in a later cycle is not double counted.
  const completedTodos = new Set();
  const successEntries = entries
    .filter((entry) => entry.outcome === 'success' && entry.endMs != null && entry.todoIds.length)
    .slice()
    .sort((a, b) => a.endMs - b.endMs);
  for (const entry of successEntries) {
    const dayBucket = dailyMap.get(workspaceWatcherUtcDayKey(entry.endMs));
    const weekBucket = weeklyMap.get(utcWeekStartKey(entry.endMs));
    for (const todoId of entry.todoIds) {
      if (completedTodos.has(todoId)) continue;
      completedTodos.add(todoId);
      if (dayBucket) {
        dayBucket.total += 1;
        dayBucket.success += 1;
      }
      if (weekBucket) {
        weekBucket.total += 1;
        weekBucket.success += 1;
      }
    }
  }

  // Informational attempt counts (excluded from throughput totals): the
  // distinct todo ids that saw a failed/blocked cycle but never completed.
  const flagged = new Set();
  const attemptEntries = entries
    .filter((entry) => (entry.outcome === 'failure' || entry.outcome === 'blocked')
      && entry.endMs != null && entry.todoIds.length)
    .slice()
    .sort((a, b) => a.endMs - b.endMs);
  for (const entry of attemptEntries) {
    const dayBucket = dailyMap.get(workspaceWatcherUtcDayKey(entry.endMs));
    if (!dayBucket) continue;
    for (const todoId of entry.todoIds) {
      const key = `${entry.outcome}:${todoId}`;
      if (flagged.has(key) || completedTodos.has(todoId)) continue;
      flagged.add(key);
      dayBucket[entry.outcome] += 1;
    }
  }

  const recent = entries
    .filter((entry) => entry.startMs != null || entry.endMs != null)
    .sort((a, b) => (a.startMs ?? a.endMs ?? 0) - (b.startMs ?? b.endMs ?? 0))
    .slice(-recentCap);

  const outcomeTotal = outcomes.success + outcomes.failure + outcomes.blocked;
  const avgDurationMs = durationCount > 0 ? Math.round(durationSum / durationCount) : null;

  return {
    windowCycles: entries.length,
    timedCycles: timed,
    outcomes,
    successRate: ratioOr(outcomes.success, outcomeTotal),
    avgDurationMs,
    daily: [...dailyMap.values()],
    weekly: [...weeklyMap.values()],
    recent,
  };
}

/**
 * Aggregate delegation records into the harness breakdown (count + verified
 * pass rate) and the list of currently active jobs for a single workspace.
 *
 * @param {object[] | null | undefined} delegations
 * @param {{ workspaceFolder?: string }} [options]
 * @returns {{ harnesses: object[], active: object[], counts: object }}
 */
export function summarizeWatcherDelegations(delegations, options = {}) {
  const folderKey = normalizeWorkspaceFolder(options.workspaceFolder);
  const rows = (Array.isArray(delegations) ? delegations : []).filter((row) => (
    folderKey
    && normalizeWorkspaceFolder(row?.workspaceFolder) === folderKey
  ));

  /** @type {Map<string, { harness: string, count: number, verified: number, passed: number, verifyFailed: number, completed: number, failed: number, active: number }>} */
  const harnessMap = new Map();
  /** @type {object[]} */
  const active = [];
  let completed = 0;
  let failed = 0;
  let activeCount = 0;

  const bucket = (harness) => {
    if (!harnessMap.has(harness)) {
      harnessMap.set(harness, {
        harness, count: 0, verified: 0, passed: 0, verifyFailed: 0, completed: 0, failed: 0, active: 0,
      });
    }
    return harnessMap.get(harness);
  };

  for (const row of rows) {
    const harness = String(row?.executor?.transport ?? '').trim().toLowerCase() || 'unknown';
    const entry = bucket(harness);
    entry.count += 1;
    const status = String(row?.status ?? '').trim().toLowerCase();
    const isOccupied = isDelegationSlotOccupied(row);
    const verifyStatus = String(row?.verifyResult?.status ?? '').trim().toLowerCase();
    if (verifyStatus === 'passed') {
      entry.verified += 1;
      entry.passed += 1;
    } else if (verifyStatus === 'failed') {
      entry.verified += 1;
      entry.verifyFailed += 1;
    }
    if (status === 'completed') {
      entry.completed += 1;
      completed += 1;
    } else if (status === 'failed' || status === 'cancelled') {
      entry.failed += 1;
      failed += 1;
    }
    if (isOccupied) {
      entry.active += 1;
      activeCount += 1;
      active.push({
        id: String(row?.id ?? '').trim(),
        childChatId: String(row?.childChatId ?? '').trim(),
        parentChatId: String(row?.parentChatId ?? '').trim(),
        harness,
        model: String(row?.executor?.model ?? '').trim(),
        assignment: String(row?.assignment ?? '').trim(),
        status,
        startedAt: String(row?.startedAt ?? row?.createdAt ?? '').trim(),
        createdAt: String(row?.createdAt ?? '').trim(),
      });
    }
  }

  const harnesses = [...harnessMap.values()]
    .map((entry) => ({
      ...entry,
      passRate: ratioOr(entry.passed, entry.verified),
      completedShare: ratioOr(entry.completed, entry.count),
    }))
    .sort((a, b) => (b.count - a.count) || a.harness.localeCompare(b.harness));

  active.sort((a, b) => String(b.startedAt || b.createdAt).localeCompare(String(a.startedAt || a.createdAt)));

  return {
    harnesses,
    active,
    counts: { total: rows.length, completed, failed, active: activeCount },
  };
}

/**
 * Count decision kinds for the two dashboard needs: the halt/attention "stop
 * reasons" (restricted to the vocabulary that means the watcher could not
 * progress) and the full per-kind tally that powers the "filter by type"
 * dropdown. Newest decisions win for `lastReason` so the sample shown matches
 * what the operator just saw.
 *
 * @param {object[] | null | undefined} decisions
 * @returns {{ stopReasons: object[], decisionKinds: object[] }}
 */
export function summarizeWatcherStopReasons(decisions) {
  const rows = Array.isArray(decisions) ? decisions : [];
  const stopCounts = new Map();
  const kindCounts = new Map();
  for (const row of rows) {
    const kind = String(row?.kind ?? '').trim();
    if (!kind) continue;
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
    if (!WORKSPACE_WATCHER_STOP_REASON_KINDS.includes(kind)) continue;
    const prev = stopCounts.get(kind) || { kind, count: 0, lastReason: '', lastAt: '' };
    const at = String(row?.at ?? '').trim();
    prev.count += 1;
    if (at >= prev.lastAt) {
      prev.lastAt = at;
      prev.lastReason = String(row?.reason ?? '').trim();
    }
    stopCounts.set(kind, prev);
  }
  const stopReasons = [...stopCounts.values()]
    .sort((a, b) => (b.count - a.count) || a.kind.localeCompare(b.kind))
    .slice(0, 8);
  const decisionKinds = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (b.count - a.count) || a.kind.localeCompare(b.kind));
  return { stopReasons, decisionKinds };
}

/**
 * Assemble the full monitoring payload for one workspace. Reads the persisted
 * watcher row and delegation records; a delegation read failure degrades to
 * empty harness stats rather than failing the endpoint.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, now?: number, recentCap?: number }} input
 * @returns {object}
 */
export function getWorkspaceWatcherStats(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = normalizeWorkspaceFolder(input.workspaceFolder);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir })
    || normalizeWorkspaceWatcherRow({ workspaceFolder });

  let delegations = [];
  try {
    delegations = loadDelegations({ dataDir });
  } catch {
    delegations = [];
  }

  const cycles = summarizeWatcherCycles(watcher?.cycleChats, { now, recentCap: input.recentCap });
  const del = summarizeWatcherDelegations(delegations, { workspaceFolder });
  const reasons = summarizeWatcherStopReasons(watcher?.decisions);

  return {
    workspaceFolder,
    generatedAt: new Date(now).toISOString(),
    mode: String(watcher?.mode ?? 'off'),
    cycleCount: Number(watcher?.cycleCount) || 0,
    cycles: {
      windowCycles: cycles.windowCycles,
      timedCycles: cycles.timedCycles,
      outcomes: cycles.outcomes,
      successRate: cycles.successRate,
      avgDurationMs: cycles.avgDurationMs,
      recent: cycles.recent,
    },
    throughput: { daily: cycles.daily, weekly: cycles.weekly },
    harnesses: del.harnesses,
    activeDelegations: del.active,
    delegationCounts: del.counts,
    stopReasons: reasons.stopReasons,
    decisionKinds: reasons.decisionKinds,
  };
}
