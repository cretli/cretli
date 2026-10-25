/**
 * watcher_show / watcher_update return a compact structured view: the full
 * Watcher view (ready leaves with bodies, review findings, long decision
 * lists) overflowed agent tool-result budgets, so a cycle orchestrator's
 * `report` answer was saved to a file and never seen.
 */
import assert from 'node:assert/strict';
import { compactWatcherViewForMcp } from '../lib/mcp/builtin/watcher-tools.js';

const body = 'x'.repeat(4000);
const view = {
  workspaceFolder: '/w',
  watcher: {
    mode: 'autopilot',
    activeCycles: [{ cycleId: 'c1', chatId: 'chat-1', todoIds: ['t1'] }],
    findings: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${i}`, { hash: 'h', summary: body }])),
    scoutFindingDecisions: Array.from({ length: 8 }, () => ({ text: body })),
    scoutFindingDecisionIndex: [{ id: 1 }],
    decisions: Array.from({ length: 50 }, (_, i) => ({ at: String(i), kind: 'tick', reason: body.slice(0, 500) })),
    reports: Array.from({ length: 20 }, (_, i) => ({ reportId: `r${i}`, message: body.slice(0, 400) })),
    cycleChats: Array.from({ length: 20 }, (_, i) => ({ chatId: `c${i}` })),
  },
  snapshot: {
    readyTodoCount: 24,
    readyLeaves: Array.from({ length: 24 }, (_, i) => ({ id: `l${i}`, title: `Leaf ${i}`, status: 'ready', parentId: 'p', siblingIndex: i, updatedAt: 'u', body, activity: [{ text: body }], changelog: [] })),
    recentErrors: Array.from({ length: 20 }, (_, i) => ({ at: String(i), error: 'e' })),
    readyTodoIds: Array.from({ length: 24 }, (_, i) => `l${i}`),
    doingTodoIds: Array.from({ length: 40 }, (_, i) => `d${i}`),
    blockedTodoIds: Array.from({ length: 150 }, (_, i) => `b${i}`),
    doingStates: [
      ...Array.from({ length: 36 }, (_, i) => ({ todoId: `p${i}`, state: 'dependency', reason: 'aggregates_children', evidence: { body } })),
      { todoId: 'd1', state: 'unknown', reason: 'state_missing', chatId: 'chat-x', evidence: { body } },
      { todoId: 'd2', state: 'user_action', reason: 'worktree_open', chatId: 'chat-y' },
    ],
  },
  guardrails: { kind: 'ok' },
};

const fullSize = JSON.stringify(view).length;
const compact = compactWatcherViewForMcp(view);
const compactSize = JSON.stringify(compact).length;
assert.ok(fullSize > 250_000, `fixture is large (${fullSize})`);
assert.ok(compactSize < 12_000, `compact view stays small (${compactSize})`);

assert.equal(compact.compact, true);
assert.equal(compact.workspaceFolder, '/w');
assert.deepEqual(compact.guardrails, { kind: 'ok' });
assert.equal(compact.watcher.mode, 'autopilot');
assert.deepEqual(compact.watcher.activeCycles, view.watcher.activeCycles, 'active cycles are kept whole');
assert.equal(compact.watcher.findings, undefined);
assert.equal(compact.watcher.findingsCount, 30);
assert.equal(compact.watcher.scoutFindingDecisions, undefined);
assert.equal(compact.watcher.scoutFindingDecisionsCount, 8);
assert.equal(compact.watcher.scoutFindingDecisionIndex, undefined);
assert.equal(compact.watcher.decisions.length, 6);
assert.ok(compact.watcher.decisions[0].reason.length <= 241, 'decision reasons are clipped');
assert.deepEqual(Object.keys(compact.watcher.decisions[0]).sort(), ['at', 'kind', 'reason', 'todoId']);
assert.equal(compact.watcher.decisions.at(-1).at, '49', 'newest decisions are kept');
assert.equal(compact.watcher.reports.length, 3);
assert.equal(compact.watcher.cycleChats.length, 3);
assert.equal(compact.snapshot.readyTodoCount, 24);
assert.equal(compact.snapshot.readyLeaves.length, 24);
assert.equal(compact.snapshot.readyLeavesCount, 24);
assert.deepEqual(compact.snapshot.readyLeaves[3], { id: 'l3', title: 'Leaf 3', parentId: 'p', siblingIndex: 3 });
assert.equal(compact.snapshot.recentErrors.length, 5);
assert.equal(compact.snapshot.readyTodoIds, undefined);
assert.equal(compact.snapshot.doingTodoIds, undefined);
assert.equal(compact.snapshot.doingCount, 40);
assert.deepEqual(compact.snapshot.doingStates.map((row) => row.todoId), ['d1', 'd2'], 'only rows needing attention');
assert.equal(compact.snapshot.doingStates[0].evidence, undefined);
assert.equal(compact.snapshot.doingDependencyCount, 36);
assert.equal(compact.snapshot.blockedTodoIds.length, 25);
assert.equal(compact.snapshot.blockedTodoIdsCount, 150);

// The input is not mutated, and empty shapes pass through.
assert.equal(view.watcher.decisions.length, 50);
assert.equal(compactWatcherViewForMcp(null), null);
assert.deepEqual(compactWatcherViewForMcp({ watcher: { mode: 'off' } }).watcher.decisions, []);

console.log('watcher-mcp-compact-view: ok');
