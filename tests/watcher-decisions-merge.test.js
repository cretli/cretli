import './helpers/isolated-data-dir.js';
/**
 * Decision-log merging: consecutive identical idle decisions collapse into one
 * entry with count/firstAt/lastAt, and idle entries never push important ones out.
 */
import assert from 'node:assert/strict';
import {
  WORKSPACE_WATCHER_MAX_DECISIONS,
  appendWorkspaceWatcherDecisionEntries,
  normalizeWorkspaceWatcherDecision,
  trimWorkspaceWatcherDecisions,
} from '../lib/persist/workspace-watchers-persist.js';

const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
const idle = (i, extra = {}) => ({
  at: at(i), kind: 'idle_no_work', reason: 'no_ready_work', readyTodoCount: 0, activeAgentCount: 0, shouldNotify: false, nextTodoId: '', ...extra,
});
const important = (i, kind = 'cycle_completed') => ({
  at: at(i), kind, reason: `r${i}`, readyTodoCount: 0, activeAgentCount: 0, shouldNotify: false, nextTodoId: '',
});

{
  let log = [];
  for (let i = 0; i < 100; i += 1) log = appendWorkspaceWatcherDecisionEntries(log, idle(i));
  assert.equal(log.length, 1);
  assert.equal(log[0].count, 100);
  assert.equal(log[0].firstAt, at(0));
  assert.equal(log[0].lastAt, at(99));
  assert.equal(log[0].at, at(99));
  const round = normalizeWorkspaceWatcherDecision(log[0]);
  assert.equal(round.count, 100);
  assert.equal(round.firstAt, at(0));
  assert.equal(round.lastAt, at(99));
  assert.equal(normalizeWorkspaceWatcherDecision(idle(1)).count, undefined, 'an unmerged entry carries no count');
}

{
  let log = appendWorkspaceWatcherDecisionEntries([], idle(0), idle(1));
  log = appendWorkspaceWatcherDecisionEntries(log, idle(2, { reason: 'other' }));
  assert.equal(log.length, 2, 'a different reason breaks the merge');
  log = appendWorkspaceWatcherDecisionEntries(log, idle(3, { reason: 'other', rejections: [{ id: 'a', filter: 'x' }] }));
  assert.equal(log.length, 3, 'different rejections break the merge');
  log = appendWorkspaceWatcherDecisionEntries(log, idle(4, { reason: 'other', rejections: [{ id: 'a', filter: 'x' }] }));
  assert.equal(log.length, 3);
  assert.equal(log[2].count, 2);
  log = appendWorkspaceWatcherDecisionEntries(log, important(5), idle(6, { reason: 'other', rejections: [{ id: 'a', filter: 'x' }] }));
  assert.equal(log.length, 5, 'an important decision in between breaks the merge');
}

{
  for (const key of ['readyTodoCount', 'activeAgentCount', 'scoutAgentCount', 'unknownAgentCount']) {
    const log = appendWorkspaceWatcherDecisionEntries([], idle(0), idle(1, { [key]: 2 }));
    assert.equal(log.length, 2, `a changed ${key} starts a new entry`);
    assert.equal(log[0].count, undefined);
  }
}

{
  // 60 non-adjacent idle entries (alternating reasons) + 10 important ones.
  let log = [];
  for (let i = 0; i < 60; i += 1) log = appendWorkspaceWatcherDecisionEntries(log, idle(i, { reason: i % 2 ? 'a' : 'b' }));
  for (let i = 0; i < 10; i += 1) log = appendWorkspaceWatcherDecisionEntries(log, important(100 + i, i % 2 ? 'orchestrator_blocked' : 'start_cycle'));
  assert.equal(log.length, WORKSPACE_WATCHER_MAX_DECISIONS);
  assert.equal(log.filter((e) => e.kind !== 'idle_no_work').length, 10, 'all important decisions survive the trim');
}

{
  const many = Array.from({ length: WORKSPACE_WATCHER_MAX_DECISIONS + 5 }, (_, i) => important(i));
  const trimmed = trimWorkspaceWatcherDecisions(many);
  assert.equal(trimmed.length, WORKSPACE_WATCHER_MAX_DECISIONS);
  assert.equal(trimmed[0].at, at(5), 'with no idle left the oldest important entries go');
}

console.log('watcher decisions merge tests passed');
