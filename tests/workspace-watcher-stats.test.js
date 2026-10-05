/**
 * Workspace Watcher monitoring stats (TODO "Monitoring Dashboard").
 *
 * Covers the pure aggregation (throughput, success rate, avg duration, harness
 * breakdown, stop reasons) plus the `cycleChats.startedAt` schema change that
 * makes the Gantt honest: the close patch mirrors the live slot's start and the
 * store normalizer preserves it. Uses a scratch data dir for the one end-to-end
 * read so no live project data is touched.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { buildWorkspaceWatcherCycleClosePatch } from '../lib/workspace-watcher-cycle-close.js';
import {
  getWorkspaceWatcherStats,
  summarizeWatcherCycles,
  summarizeWatcherDelegations,
  summarizeWatcherStopReasons,
  WORKSPACE_WATCHER_STOP_REASON_KINDS,
} from '../lib/workspace-watcher-stats.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

test('summarizeWatcherCycles computes outcomes, rate, duration and daily/weekly buckets', () => {
  const chats = [
    { id: 'c1', cycleId: 'cy1', todoIds: ['t1'], startedAt: iso(NOW - 60_000), at: iso(NOW - 30_000), outcome: 'success' },
    { id: 'c2', cycleId: 'cy2', todoIds: ['t2'], startedAt: iso(NOW - 120_000), at: iso(NOW - 60_000), outcome: 'failure' },
    { id: 'c3', cycleId: 'cy3', todoIds: ['t3'], startedAt: iso(NOW - DAY - 10_000), at: iso(NOW - DAY), outcome: 'blocked' },
  ];
  const s = summarizeWatcherCycles(chats, { now: NOW });
  assert.deepEqual(s.outcomes, { success: 1, failure: 1, blocked: 1 });
  assert.equal(s.successRate, 0.3333);
  // Two modern entries have known durations (30s and 60s); the third (10s) too.
  assert.equal(s.avgDurationMs, Math.round((30_000 + 60_000 + 10_000) / 3));
  assert.equal(s.timedCycles, 3);
  // Throughput counts completed TODOs, not closed cycles: only t1 (the one
  // success cycle) lands today; the failed (t2) and blocked (t3) cycles add no
  // throughput, though they still show as attempts on their day's bar.
  const today = s.daily.at(-1);
  assert.equal(today.total, 1, 'one completed todo = one throughput unit');
  assert.equal(today.success, 1);
  assert.equal(today.failure, 1, 't2 failed today is surfaced but not in total');
  const yesterday = s.daily.at(-2);
  assert.equal(yesterday.total, 0, 'a blocked cycle contributes no throughput');
  assert.equal(yesterday.blocked, 1);
  // Weekly buckets track completed todos too; only t1 closed this week.
  const thisWeek = s.weekly.at(-1);
  assert.equal(thisWeek.total, 1);
  assert.equal(thisWeek.success, 1);
});

test('summarizeWatcherCycles keeps legacy (no startedAt) as null duration and caps recent', () => {
  const chats = [
    { id: 'c1', cycleId: 'cy1', todoIds: [], at: iso(NOW - 5_000), outcome: 'success' }, // no startedAt
  ];
  const s = summarizeWatcherCycles(chats, { now: NOW });
  assert.equal(s.recent[0].durationMs, null);
  assert.equal(s.avgDurationMs, null, 'no known durations keeps the average honest');
  // recentCap trims the newest entries.
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `c${i}`, startedAt: iso(NOW - (i + 1) * 1000), at: iso(NOW - i * 1000), outcome: 'success',
  }));
  const capped = summarizeWatcherCycles(many, { now: NOW, recentCap: 20 });
  assert.equal(capped.recent.length, 20);
  assert.equal(capped.recent.at(-1).chatId, 'c0', 'sorted oldest→newest, newest is c0');
});

test('summarizeWatcherDelegations groups by harness, filters by workspace, lists active', () => {
  const rows = [
    { workspaceFolder: '/w', executor: { transport: 'OpenCode', model: 'm1' }, status: 'completed', verifyResult: { status: 'passed' } },
    { workspaceFolder: '/w', executor: { transport: 'opencode' }, status: 'failed' },
    { workspaceFolder: '/w', executor: { transport: 'deepseek' }, status: 'running', startedAt: iso(NOW - 1000), childChatId: 'kid', parentChatId: 'orch' },
    { workspaceFolder: '/other', executor: { transport: 'qwen' }, status: 'completed', verifyResult: { status: 'passed' } },
  ];
  const del = summarizeWatcherDelegations(rows, { workspaceFolder: '/w', now: NOW });
  assert.equal(del.counts.total, 3, 'the /other workspace row is excluded');
  const opencode = del.harnesses.find((h) => h.harness === 'opencode');
  assert.equal(opencode.count, 2);
  assert.equal(opencode.verified, 1);
  assert.equal(opencode.passRate, 1, 'pass rate is computed over verified delegations');
  const deepseek = del.harnesses.find((h) => h.harness === 'deepseek');
  assert.equal(deepseek.passRate, null);
  // Harness list is sorted by count desc; the two-count opencode leads.
  assert.equal(del.harnesses[0].harness, 'opencode');
  assert.deepEqual(del.active.map((a) => [a.harness, a.status]), [['deepseek', 'running']]);
});

test('summarizeWatcherStopReasons keeps halt kinds, drops progress kinds', () => {
  const decisions = [
    { kind: 'cycle_failed', reason: 'failure', at: iso(NOW - 1000) },
    { kind: 'cycle_failed', reason: 'blocked', at: iso(NOW) },
    { kind: 'wait_budget', reason: 'daily_budget', at: iso(NOW - 500) },
    { kind: 'start_cycle', reason: 'go', at: iso(NOW) },
  ];
  assert.ok(WORKSPACE_WATCHER_STOP_REASON_KINDS.includes('cycle_failed'));
  const r = summarizeWatcherStopReasons(decisions);
  const failed = r.stopReasons.find((s) => s.kind === 'cycle_failed');
  assert.equal(failed.count, 2);
  assert.equal(failed.lastReason, 'blocked', 'newest decision wins for the sample reason');
  assert.ok(!r.stopReasons.some((s) => s.kind === 'start_cycle'), 'progress kinds are not stop reasons');
  assert.deepEqual(r.decisionKinds.find((k) => k.kind === 'start_cycle'), { kind: 'start_cycle', count: 1 });
});

test('normalizeWorkspaceWatcherRow preserves cycleChats.startedAt', () => {
  const started = iso(NOW - 90_000);
  const closed = iso(NOW);
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/w',
    cycleChats: [
      { id: 'c1', cycleId: 'cy1', todoIds: ['t1'], startedAt: started, at: closed, outcome: 'success' },
      { id: 'c2', cycleId: 'cy2', todoIds: ['t2'], at: closed, outcome: 'success' },
    ],
  });
  assert.equal(row.cycleChats[0].startedAt, started);
  assert.equal(row.cycleChats[1].startedAt, '', 'a legacy entry normalizes to an empty start, not a fabricated one');
});

test('buildWorkspaceWatcherCycleClosePatch mirrors cycle.startedAt into cycleChats', () => {
  const started = iso(NOW - 120_000);
  const cycle = {
    cycleId: 'cy1', chatId: 'c1', todoIds: ['t1'], startedAt: started, phase: 'running',
  };
  const row = {
    cycleCount: 0, activeCycles: [cycle], lease: { token: 't' }, failures: {}, decisions: [], policy: {}, planRequests: {},
  };
  const patch = buildWorkspaceWatcherCycleClosePatch({ row, cycle, outcome: 'success', now: NOW });
  const entry = patch.cycleChats.find((chat) => chat.id === 'c1');
  assert.equal(entry.startedAt, started, 'the Gantt gets a real duration from the mirrored start');
  assert.ok(entry.at, 'the close time is still recorded');
});

test('summarizeWatcherCycles counts distinct completed todos, not cycles or failed/blocked', () => {
  const chats = [
    { id: 'a', todoIds: ['t1'], startedAt: iso(NOW - 5000), at: iso(NOW - 4000), outcome: 'success' },
    { id: 'b', todoIds: ['t1'], startedAt: iso(NOW - 3000), at: iso(NOW - 2000), outcome: 'success' }, // duplicate t1 completion
    { id: 'c', todoIds: ['t2'], startedAt: iso(NOW - 2500), at: iso(NOW - 1500), outcome: 'success' },
    { id: 'd', todoIds: ['t3'], startedAt: iso(NOW - 2000), at: iso(NOW - 1000), outcome: 'failure' },
    { id: 'e', todoIds: ['t4'], startedAt: iso(NOW - 1500), at: iso(NOW - 500), outcome: 'blocked' },
    { id: 'f', todoIds: ['t5', 't6'], startedAt: iso(NOW - 1000), at: iso(NOW - 300), outcome: 'success' }, // one cycle, two todos
  ];
  const s = summarizeWatcherCycles(chats, { now: NOW });
  const today = s.daily.at(-1);
  // Completed distinct todos: t1 (deduped), t2, t5, t6 = 4. The failure (t3)
  // and blocked (t4) cycles never add to throughput, even though both closed
  // today, and the repeated t1 success is counted once.
  assert.equal(today.total, 4, 'throughput = distinct completed todos');
  assert.equal(today.success, 4);
  assert.equal(today.failure, 1, 'failed todo surfaced but excluded from total');
  assert.equal(today.blocked, 1, 'blocked todo surfaced but excluded from total');
  assert.equal(s.weekly.at(-1).total, 4);
  // Cycle-level outcomes stay cycle-based (the success-rate KPI is unaffected).
  assert.deepEqual(s.outcomes, { success: 4, failure: 1, blocked: 1 });
});

test('the orchestrator harness is mirrored into cycleChats and surfaced by stats', () => {
  const started = iso(NOW - 40_000);
  // finalize records the harness on the live slot, which the store preserves.
  const activeRow = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/w',
    activeCycles: [{ cycleId: 'cy1', chatId: 'c1', todoIds: ['t1'], startedAt: started, harness: 'deepseek' }],
  });
  assert.equal(activeRow.activeCycles[0].harness, 'deepseek', 'activeCycles normalizer keeps harness');
  // close copies the live slot's harness into the durable cycleChats entry.
  const cycle = { cycleId: 'cy1', chatId: 'c1', todoIds: ['t1'], startedAt: started, harness: 'opencode' };
  const row = {
    cycleCount: 0, activeCycles: [cycle], lease: { token: 't' }, failures: {}, decisions: [], policy: {}, planRequests: {},
  };
  const patch = buildWorkspaceWatcherCycleClosePatch({ row, cycle, outcome: 'success', now: NOW });
  const closed = patch.cycleChats.find((chat) => chat.id === 'c1');
  assert.equal(closed.harness, 'opencode', 'close mirrors the orchestrator harness');
  const normalized = normalizeWorkspaceWatcherRow({ workspaceFolder: '/w', cycleChats: [closed] });
  assert.equal(normalized.cycleChats[0].harness, 'opencode', 'cycleChats normalizer preserves harness');
  // the aggregation surfaces it on the timeline-ready record.
  const s = summarizeWatcherCycles([normalized.cycleChats[0]], { now: NOW });
  assert.equal(s.recent[0].harness, 'opencode');
});

test('getWorkspaceWatcherStats reads a seeded watcher row end-to-end', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-stats-'));
  const ws = path.join(dataDir, 'workspace');
  upsertWorkspaceWatcher(ws, { mode: 'autopilot', cycleCount: 5 }, { dataDir });
  upsertWorkspaceWatcher(ws, {
    cycleChats: [
      { id: 'a', cycleId: 'cy-a', todoIds: ['t'], startedAt: iso(NOW - 40_000), at: iso(NOW - 20_000), outcome: 'success' },
      { id: 'b', cycleId: 'cy-b', todoIds: ['t'], startedAt: iso(NOW - 30_000), at: iso(NOW - 10_000), outcome: 'failure' },
    ],
    decisions: [
      { at: iso(NOW), kind: 'cycle_failed', reason: 'failure', readyTodoCount: 0, activeAgentCount: 0, shouldNotify: true, nextTodoId: '' },
    ],
  }, { dataDir });
  const stats = getWorkspaceWatcherStats({ dataDir, workspaceFolder: ws, now: NOW });
  assert.equal(stats.ok, undefined);
  assert.equal(stats.cycleCount, 5);
  assert.equal(stats.cycles.windowCycles, 2);
  assert.equal(stats.cycles.successRate, 0.5);
  assert.equal(stats.cycles.avgDurationMs, 20_000);
  assert.equal(stats.stopReasons[0].kind, 'cycle_failed');
  assert.ok(Array.isArray(stats.throughput.daily) && stats.throughput.daily.length === 7);
  assert.deepEqual(stats.delegationCounts, { total: 0, completed: 0, failed: 0, active: 0 });
});
