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
  resolveWorkspaceTodoExecutionIdentity,
} from '../lib/workspace-watcher-recovery.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

function countedCycle(values, count) {
  const cycle = { ...values };
  const todoIds = values.todoIds;
  const chatId = values.chatId;
  Object.defineProperty(cycle, 'todoIds', { enumerable: true, get() { count.todoIds += 1; return todoIds; } });
  Object.defineProperty(cycle, 'chatId', { enumerable: true, get() { count.chatId += 1; return chatId; } });
  return cycle;
}

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
  const cycles = items.map((item, index) => {
    const cycle = { chatId: `chat-${index}`, cycleId: `cycle-${index}`, runId: `run-${index}` };
    Object.defineProperty(cycle, 'todoIds', { enumerable: true, get() { counter.reads += 1; return [item.id]; } });
    return cycle;
  });
  const expected = items.map((item, index) => classifyWorkspaceDoingTodo({
    ...base({}), item, items,
    index: new Map(items.map((row) => [row.id, row])),
    childParentIds: new Set(), delegations, cycles,
  }));
  const legacyReads = counter.reads;
  counter.reads = 0;
  const actual = classifyWorkspaceDoingTodos(base({ items, delegations, cycles }));
  assert.deepEqual(actual, expected, 'indexed result equals the linear-scan result');
  assert.ok(legacyReads >= 200 * 200, `legacy path scans n x n (${legacyReads})`);
  // Linear: delegation and cycle indexes are built once; classification does
  // not revisit every cycle's todo list for every doing row.
  assert.ok(counter.reads <= 200 * 3, `indexed path is linear (${counter.reads} indexed field reads)`);
}

{
  const count = { todoIds: 0, chatId: 0 };
  const items = [];
  const cycles = [];
  const closedCycles = [];
  const records = new Map();
  for (let i = 0; i < 40; i += 1) {
    const active = { id: `active-${i}`, status: 'doing', claimedByChatId: `active-chat-${i}` };
    const orphan = { id: `orphan-${i}`, status: 'doing', updatedAt: new Date(NOW - 3_600_000).toISOString() };
    const interrupted = { id: `closed-${i}`, status: 'doing', claimedByChatId: `closed-chat-${i}` };
    items.push(active, orphan, interrupted);
    cycles.push(countedCycle({ todoIds: [active.id], chatId: `active-chat-${i}`, cycleId: `active-cycle-${i}` }, count));
    cycles.push(countedCycle({ todoIds: [orphan.id], chatId: '', cycleId: `orphan-cycle-${i}` }, count));
    const cycleId = `restart-cycle-${i}`;
    closedCycles.push(countedCycle({ todoIds: [interrupted.id], chatId: '', cycleId, closeReason: 'interrupted_restart', at: new Date(NOW - 1000).toISOString() }, count));
    records.set(interrupted.id, { cycles: [cycleId] });
  }
  const options = {
    items, cycles, closedCycles,
    reviewPolicy: { orphanDoingMinMs: 1 },
    hasLiveWorktree: (id) => id.startsWith('active-') || id.startsWith('closed-'),
    readWorktreeRecord: (id) => records.get(id) || null,
  };
  const expected = items.map((item) => classifyWorkspaceDoingTodo({
    ...base(options), item, items,
    index: new Map(items.map((row) => [row.id, row])),
    childParentIds: new Set(), delegations: [],
  }));
  count.todoIds = 0;
  count.chatId = 0;
  const actual = classifyWorkspaceDoingTodos(base(options));
  assert.deepEqual(actual, expected, 'bulk cycle indexes preserve single-row classification');
  assert.equal(actual.filter((row) => row.state === 'active' && row.reason === 'worktree_cycle').length, 40);
  assert.equal(actual.filter((row) => row.state === 'unknown' && row.todoId.startsWith('orphan-')).length, 40);
  assert.equal(actual.filter((row) => row.state === 'recoverable' && row.reason === 'restart_interrupted_worktree').length, 40);
  assert.ok(count.todoIds <= cycles.length + closedCycles.length, `cycle todo lists indexed once (${count.todoIds})`);
  assert.ok(count.chatId <= cycles.length, `cycle chat ids indexed once (${count.chatId})`);
}

{
  const item = { id: 'ordered', status: 'doing', claimedByChatId: 'owner' };
  const first = { chatId: 'owner', cycleId: 'first', runId: 'run-first', todoIds: [] };
  const second = { chatId: 'owner', cycleId: 'second', runId: 'run-second', todoIds: [] };
  const ordered = classifyWorkspaceDoingTodos(base({ items: [item], cycles: [first, second] }))[0];
  assert.equal(ordered.cycleId, 'first', 'owner-cycle lookup keeps first-match ordering');

  const worktree = { id: 'claimant-only', status: 'doing', claimedByChatId: 'claimant' };
  const closed = [{ cycleId: 'old', todoIds: ['claimant-only'], closeReason: 'interrupted_restart', at: new Date(NOW - 1000).toISOString() }];
  const protectedState = classifyWorkspaceDoingTodos(base({
    items: [worktree],
    cycles: [{ chatId: 'claimant', cycleId: 'new', todoIds: ['another-todo'] }],
    closedCycles: closed,
    hasLiveWorktree: () => true,
    readWorktreeRecord: () => ({ cycles: ['old'] }),
  }))[0];
  assert.equal(protectedState.state, 'user_action', 'claimant-only active cycle prevents interrupted recovery');
  assert.equal(protectedState.reason, 'worktree_open');
}

{
  const item = { id: 'changing', status: 'doing', updatedAt: new Date(NOW - 3_600_000).toISOString() };
  const run = (cycles) => classifyWorkspaceDoingTodos(base({ items: [item], cycles, reviewPolicy: { orphanDoingMinMs: 1 } }))[0];
  assert.equal(run([]).state, 'recoverable');
  assert.equal(run([{ todoIds: ['changing'] }]).state, 'unknown');
  assert.equal(run([{ todoIds: ['different'] }]).state, 'recoverable');
  assert.equal(run([]).state, 'recoverable');
}

{
  const item = { id: 'operator-held', status: 'doing', updatedAt: new Date(NOW).toISOString(), reservedBy: { kind: 'operator', clientId: 'operator-1', until: new Date(NOW + 60_000).toISOString() } };
  const state = classifyWorkspaceDoingTodo({ ...base({}), item, items: [item], index: new Map([[item.id, item]]), childParentIds: new Set(), delegations: [] });
  assert.equal(state.state, 'user_action');
  assert.equal(state.reason, 'reserved_by_operator');
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

// Newest leaf delegation wins; ties keep list order (indexed and linear paths agree).
{
  const delegations = [
    { id: 'd1', leafId: 't1', controllerChatId: 'c-old', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'd2', leafId: 't1', controllerChatId: 'c-new', createdAt: '2026-02-01T00:00:00Z' },
    { id: 'd3', leafId: 't1', controllerChatId: 'c-tie', createdAt: '2026-02-01T00:00:00Z' },
  ];
  const item = { id: 't1' };
  const a = resolveWorkspaceTodoExecutionIdentity(item, new Map(), delegations);
  const b = resolveWorkspaceTodoExecutionIdentity(item, new Map(), delegations, buildDelegationIndex(delegations));
  assert.deepEqual(a, b);
  assert.equal(a.delegationId, 'd2');
}
