import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countRunningLeavesByTree,
  evaluateWorkspaceWatcherSafetyValve,
  explainParallelScopeBlock,
  explainWorkspaceWatcherRejections,
  isWorkspaceWatcherInfraFailure,
  pickDominantRejection,
  rankWorkspaceWatcherCandidates,
  setWorkspaceWatcherStabilitySource,
  workspaceWatcherPriorityClass,
} from '../lib/workspace-watcher-scheduler.js';
import { decideWorkspaceWatcherAction, pickNextWorkspaceReadyTodo } from '../lib/workspace-watcher.js';
import { buildWorkspaceWatcherCycleClosePatch } from '../lib/workspace-watcher-cycle-close.js';
import { normalizeWorkspaceWatcherRow } from '../lib/persist/workspace-watchers-persist.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const healthy = { alarms: [] };
const hot = { alarms: ['eventLoopP99'] };

function leaf(id, extra = {}) {
  return { id, status: 'ready', title: id, updatedAt: `u-${id}`, siblingIndex: 0, ...extra };
}

function decide({ load, active = 0, maxParallel = 1, items, readyLeaves, watcher = {} }) {
  return decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy: { maxParallel, requirePlanApproval: false }, ...watcher },
    snapshot: {
      readyTodoCount: readyLeaves.length,
      readyLeaves,
      items: items || readyLeaves,
      activeAgentCount: active,
      errors: [],
    },
    load,
    now: NOW,
  });
}

test('safety valve: maxParallel does not block while S1 is healthy', () => {
  assert.equal(evaluateWorkspaceWatcherSafetyValve({ count: 7, maxParallel: 1, load: healthy }).reached, false);
  const d = decide({ load: healthy, active: 3, maxParallel: 1, readyLeaves: [leaf('a')] });
  assert.equal(d.kind, 'start_cycle');
});

test('hard cap: ten active cycles postpone an eleventh start even while S1 is healthy', () => {
  const activeCycles = Array.from({ length: 10 }, (_, index) => ({
    cycleId: `cycle-${index}`,
    chatId: `chat-${index}`,
    todoIds: [`todo-${index}`],
    startedAt: new Date(NOW + index).toISOString(),
    status: 'running',
  }));
  const d = decide({
    load: healthy,
    active: 0,
    maxParallel: 10,
    readyLeaves: [leaf('eleventh')],
    watcher: { activeCycles },
  });
  assert.equal(d.kind, 'wait_active');
  assert.equal(d.reason, 'hard_cap');
});

test('safety valve: danger alarms postpone the start with a named reason', () => {
  const v = evaluateWorkspaceWatcherSafetyValve({ count: 1, maxParallel: 1, load: hot });
  assert.equal(v.reached, true);
  assert.equal(v.reason, 'stability_valve:eventLoopP99');
  const d = decide({ load: hot, active: 1, maxParallel: 1, readyLeaves: [leaf('a')] });
  assert.equal(d.kind, 'wait_active');
  assert.equal(d.reason, 'stability_valve:eventLoopP99');
});

test('safety valve: below maxParallel a start is still allowed under danger', () => {
  assert.equal(evaluateWorkspaceWatcherSafetyValve({ count: 1, maxParallel: 2, load: hot }).reached, false);
});

test('safety valve: advisory alarms (child processes) are not danger', () => {
  const v = evaluateWorkspaceWatcherSafetyValve({ count: 5, maxParallel: 1, load: { alarms: ['childProcesses'] } });
  assert.equal(v.reached, false);
});

test('safety valve: without any S1 source maxParallel stays a plain cap', () => {
  setWorkspaceWatcherStabilitySource(null);
  const v = evaluateWorkspaceWatcherSafetyValve({ count: 1, maxParallel: 1 });
  assert.deepEqual(v, { reached: true, reason: 'max_parallel', alarms: [] });
});

test('safety valve: a registered source feeds the valve', () => {
  setWorkspaceWatcherStabilitySource(() => healthy);
  try {
    assert.equal(evaluateWorkspaceWatcherSafetyValve({ count: 4, maxParallel: 1 }).reached, false);
    setWorkspaceWatcherStabilitySource(() => ({ alarms: ['lowDisk'] }));
    assert.equal(evaluateWorkspaceWatcherSafetyValve({ count: 4, maxParallel: 1 }).reason, 'stability_valve:lowDisk');
  } finally {
    setWorkspaceWatcherStabilitySource(null);
  }
});

test('priority classes: continuation work outranks fresh and background work', () => {
  const fresh = leaf('fresh');
  const cont = leaf('cont', { leafMaterial: { revision: 'x' } });
  const bg = leaf('bg', { priority: 'low' });
  assert.equal(workspaceWatcherPriorityClass(cont) < workspaceWatcherPriorityClass(fresh), true);
  assert.equal(workspaceWatcherPriorityClass(fresh) < workspaceWatcherPriorityClass(bg), true);
  assert.deepEqual(
    rankWorkspaceWatcherCandidates([bg, fresh, cont], { items: [bg, fresh, cont] }).map((r) => r.id),
    ['cont', 'fresh', 'bg'],
  );
});

test('fair share: the tree with fewer running leaves goes first', () => {
  const items = [
    { id: 'big', status: 'doing', runMode: 'parallel' },
    { id: 'big1', status: 'doing', parentId: 'big' },
    { id: 'big2', status: 'ready', parentId: 'big', updatedAt: 'a' },
    { id: 'small', status: 'doing', runMode: 'parallel' },
    { id: 'small1', status: 'ready', parentId: 'small', updatedAt: 'z' },
  ];
  assert.deepEqual(countRunningLeavesByTree(items), { big: 1 });
  const ranked = rankWorkspaceWatcherCandidates([items[2], items[4]], {
    items,
    runningByTree: countRunningLeavesByTree(items),
  });
  assert.equal(ranked[0].id, 'small1', 'the idle tree is served before the busy one despite a newer update');
});

test('fair share: least recently served tree rotates in, so no tree starves', () => {
  const a = leaf('a', { updatedAt: '1' });
  const b = leaf('b', { updatedAt: '2' });
  const items = [a, b];
  const first = rankWorkspaceWatcherCandidates([a, b], { items, lastServedByTree: {} });
  assert.equal(first[0].id, 'a');
  // After `a` was served, `b` must win even though `a` is older.
  const second = rankWorkspaceWatcherCandidates([a, b], { items, lastServedByTree: { a: NOW } });
  assert.equal(second[0].id, 'b');
  const third = rankWorkspaceWatcherCandidates([a, b], { items, lastServedByTree: { a: NOW, b: NOW + 1 } });
  assert.equal(third[0].id, 'a');
});

test('the pick honours lastServedByTree from the watcher row', () => {
  const a = leaf('a', { updatedAt: '1' });
  const b = leaf('b', { updatedAt: '2' });
  const pick = pickNextWorkspaceReadyTodo({ items: [a, b], lastServedByTree: { a: NOW } });
  assert.equal(pick.id, 'b');
});

test('lastServedByTree is persisted by the row normalizer', () => {
  const row = normalizeWorkspaceWatcherRow({ workspaceFolder: '/w', lastServedByTree: { t1: 5, bad: 'x', '': 3 } });
  assert.deepEqual(row.lastServedByTree, { t1: 5 });
});

test('infra failures: mcp_not_ready and restart never count, missing_report counts only without lag', () => {
  assert.equal(isWorkspaceWatcherInfraFailure('mcp_not_ready'), true);
  assert.equal(isWorkspaceWatcherInfraFailure('mcp_tools_missing'), true);
  assert.equal(isWorkspaceWatcherInfraFailure('missing_report', { load: healthy }), false);
  assert.equal(isWorkspaceWatcherInfraFailure('missing_report', { load: hot }), true);
  assert.equal(isWorkspaceWatcherInfraFailure('reported_failure', { load: hot }), false);
});

function closePatch(decisionReason, previous = 1) {
  return buildWorkspaceWatcherCycleClosePatch({
    row: { failures: { t1: previous }, policy: {}, activeCycles: [], cycles: [], lease: {} },
    cycle: { cycleId: 'c1', chatId: 'ch1', todoIds: ['t1'] },
    outcome: 'failure',
    decisionReason,
    now: NOW,
  });
}

test('failure ceiling: an mcp_not_ready close leaves the counter and backoff untouched', () => {
  const patch = closePatch('mcp_not_ready');
  assert.equal(patch.failures, undefined, 'counter is not rewritten');
  assert.equal(patch.backoffUntil, undefined, 'no failure backoff is armed');
});

test('failure ceiling: a genuine failure still increments the counter', () => {
  setWorkspaceWatcherStabilitySource(() => healthy);
  try {
    assert.equal(closePatch('missing_report').failures.t1, 2);
    setWorkspaceWatcherStabilitySource(() => hot);
    assert.equal(closePatch('missing_report').failures, undefined, 'missing_report under lag is infrastructure');
  } finally {
    setWorkspaceWatcherStabilitySource(null);
  }
});

const parallelItems = () => [
  { id: 'p', status: 'doing', runMode: 'parallel' },
  { id: 'busy', status: 'doing', parentId: 'p', body: '## Leaf scope\n- lib/a.js\n' },
  { id: 'nos', status: 'ready', parentId: 'p', body: 'no scope here' },
  { id: 'disj', status: 'ready', parentId: 'p', body: '## Leaf scope\n- lib/b.js\n' },
  { id: 'clash', status: 'ready', parentId: 'p', body: '## Leaf scope\n- lib/a.js\n' },
];

test('parallel scope: undeclared scope reports parallel_scope_unknown naming the running sibling', () => {
  const items = parallelItems();
  assert.deepEqual(explainParallelScopeBlock(items, items[2]), {
    code: 'parallel_scope_unknown',
    conflictLeafId: 'busy',
  });
  assert.equal(explainParallelScopeBlock(items, items[3]), null, 'disjoint declared scope may run');
  assert.deepEqual(explainParallelScopeBlock(items, items[4]), {
    code: 'parallel_scope_collision',
    conflictLeafId: 'busy',
  });
});

test('Why?: idle decision names parallel_scope_unknown when no leaf reaches the ready list', () => {
  const items = parallelItems().filter((r) => r.id !== 'disj' && r.id !== 'clash');
  const d = decide({ load: healthy, readyLeaves: [], items });
  assert.equal(d.kind, 'idle_no_work');
  assert.equal(d.reason, 'parallel_scope_unknown');
  assert.deepEqual(d.rejections, [{ id: 'nos', filter: 'parallel_scope_unknown', conflictLeafId: 'busy' }]);
});

test('Why?: a backed-off leaf does not label a pool blocked by something else', () => {
  const a = leaf('a');
  const b = leaf('b');
  const c = leaf('c');
  const d = decide({
    load: healthy,
    readyLeaves: [a, b, c],
    watcher: {
      failures: { b: 5, c: 5 },
      policy: { maxParallel: 1, maxConsecutiveFailures: 3, requirePlanApproval: false },
      blockedBackoff: { a: { count: 1, until: new Date(NOW + 60_000).toISOString() } },
    },
  });
  assert.equal(d.kind, 'idle_no_work');
  assert.equal(d.reason, 'failure_ceiling', 'two leaves at the ceiling outweigh one in backoff');
  assert.deepEqual(
    d.rejections.map((r) => [r.id, r.filter]),
    [['a', 'blocked_backoff'], ['b', 'failure_ceiling'], ['c', 'failure_ceiling']],
  );
});

test('rejections helper lists each filter and picks the dominant one', () => {
  const rows = explainWorkspaceWatcherRejections({
    items: [],
    readyLeaves: [leaf('x'), leaf('y')],
    classify: (row) => (row.id === 'x' ? 'blocked_backoff' : 'same_findings'),
  });
  assert.equal(rows.length, 2);
  assert.equal(pickDominantRejection([{ filter: 'a' }, { filter: 'b' }, { filter: 'b' }]), 'b');
  assert.equal(pickDominantRejection([]), '');
});
