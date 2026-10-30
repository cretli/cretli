/**
 * classifyWorkspaceDoingTodos builds a per-call delegation index instead of
 * filtering every delegation for every doing row. The index is pure (built from
 * the caller's arrays, never retained), so freshness means "a second call sees
 * the changed input".
 */
import assert from 'node:assert/strict';
import {
  buildDelegationIndex,
  classifyWorkspaceDoingTodo,
  classifyWorkspaceDoingTodos,
} from '../lib/workspace-watcher-recovery.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

function fixture(count, counter) {
  const items = [];
  const delegations = [];
  for (let i = 0; i < count; i += 1) {
    const id = `todo-${i}`;
    items.push({
      id, status: 'doing', updatedAt: new Date(NOW + i).toISOString(),
      ...(i % 2 === 0 ? { claimedByChatId: `chat-${i}` } : { orchestratorChatId: `chat-${i}` }),
    });
    const row = {
      id: `deleg-${i}`, controllerChatId: `chat-${i}`, status: 'completed', taskOutcome: 'success',
      createdAt: new Date(NOW + i).toISOString(), finishedAt: new Date(NOW + i + 1).toISOString(),
    };
    // Count reads of the two fields the old per-row filter touched.
    Object.defineProperty(row, 'leafId', { enumerable: true, get() { counter.reads += 1; return id; } });
    delegations.push(row);
  }
  return { items, delegations };
}

const base = (extra) => ({
  cycles: [],
  now: NOW,
  probe: () => ({ known: true, busy: false, reason: 'idle' }),
  isCycleChatAlive: () => false,
  ...extra,
});

/** Reference: the pre-index behaviour (no delegationIndex passed). */
function legacy(items, delegations) {
  const index = new Map(items.map((row) => [row.id, row]));
  const childParentIds = new Set();
  return items.map((item) => classifyWorkspaceDoingTodo({
    ...base({}), item, items, index, childParentIds, delegations,
  }));
}

{
  const counter = { reads: 0 };
  const { items, delegations } = fixture(200, counter);
  const expected = legacy(items, delegations);
  const legacyReads = counter.reads;
  counter.reads = 0;
  const actual = classifyWorkspaceDoingTodos(base({ items, delegations }));
  assert.deepEqual(actual, expected, 'indexed result equals the linear-scan result');
  assert.ok(legacyReads >= 200 * 200, `legacy path scans n x n (${legacyReads})`);
  // Linear: one read per delegation to build the index, plus bucket lookups only.
  assert.ok(counter.reads <= 200 * 2, `indexed path is linear (${counter.reads} leafId reads)`);
}

{
  // Row order inside related/occupied selection is preserved when a row matches
  // by both controller and leaf (dedupe) and when two rows match differently.
  const items = [{ id: 'a', status: 'doing', claimedByChatId: 'c1' }];
  const delegations = [
    { id: 'd1', leafId: 'a', controllerChatId: 'other', status: 'completed', taskOutcome: 'success', finishedAt: '2025-12-31T00:00:00.000Z' },
    { id: 'd2', leafId: 'a', controllerChatId: 'c1', status: 'completed', taskOutcome: 'blocked', finishedAt: '2025-12-31T01:00:00.000Z' },
    { id: 'd3', leafId: 'zzz', controllerChatId: 'c1', status: 'completed', taskOutcome: 'success', finishedAt: '2025-12-30T00:00:00.000Z' },
  ];
  assert.deepEqual(classifyWorkspaceDoingTodos(base({ items, delegations })), legacy(items, delegations));
  const idx = buildDelegationIndex(delegations);
  assert.deepEqual(idx.byLeaf.get('a').map((r) => r.id), ['d1', 'd2']);
  assert.deepEqual(idx.byController.get('c1').map((r) => r.id), ['d2', 'd3']);
}

{
  // Freshness: nothing is cached across calls; a changed delegation list is seen.
  const items = [{ id: 'a', status: 'doing', orchestratorChatId: 'c1' }];
  const run = (delegations) => classifyWorkspaceDoingTodos(base({ items, delegations }))[0];
  const first = run([]);
  const second = run([{ id: 'd1', leafId: 'a', controllerChatId: 'c1', status: 'running' }]);
  assert.notEqual(first.state, 'active');
  assert.equal(second.state, 'active');
  assert.equal(second.delegationId, 'd1');
  const third = run([]);
  assert.equal(third.state, first.state, 'dropping the delegation drops the evidence');
}

console.log('workspace-watcher-recovery-index: ok');
