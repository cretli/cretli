/**
 * Live fan-out for workspace watcher state.
 *
 * The watcher must reuse the existing chat-list channel: a `workspace-watcher`
 * `chatsChanged` frame reaches every open panel, and the presence rows carry the
 * compact autopilot summary for the sidebar badge.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  subscribeChatListUpdates,
  __clearChatListUpdateClientsForTest,
} from '../lib/chat-list-updates.js';
import {
  broadcastWorkspaceWatcherChanged,
  workspaceWatcherPresenceRows,
  workspaceWatcherPresenceKey,
} from '../lib/workspace-watcher-live.js';
import { isWorkspaceWatcherActiveCycleChatAlive } from '../lib/workspace-watcher.js';
import { classifyWorkspaceDoingTodos, summarizeWorkspaceTodoRecovery } from '../lib/workspace-watcher-recovery.js';

function socket() {
  const messages = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    messages,
    send: (payload) => messages.push(JSON.parse(payload)),
  });
}

__clearChatListUpdateClientsForTest();
const viewer = socket();
subscribeChatListUpdates(viewer);
broadcastWorkspaceWatcherChanged({ workspaceFolder: '/repo/one' });
assert.deepEqual(viewer.messages.at(-1), { type: 'chatsChanged', reason: 'workspace-watcher', chatId: null });
__clearChatListUpdateClientsForTest();

const rows = workspaceWatcherPresenceRows([
  {
    workspaceFolder: '/repo/one',
    mode: 'autopilot',
    paused: true,
    stopReason: 'loop_same_findings',
    activeCycle: { chatId: 'orch-1', todoIds: ['todo-1', 'todo-2'] },
  },
  { workspaceFolder: '/repo/two', mode: 'observe' },
  { workspaceFolder: '/repo/off', mode: 'off' },
  { workspaceFolder: '/repo/zero', mode: 'off', pinnedChatId: 'pin-off' },
  null,
]);
assert.equal(rows.length, 3, 'off rows without a pinned chat and null rows are dropped');
assert.equal(rows[0].workspaceFolder, '/repo/one');
assert.equal(rows[0].paused, true);
assert.equal(rows[0].activeCycleCount, 1);
assert.equal(rows[0].activeCycleChatId, 'orch-1');
assert.deepEqual(rows[0].activeCycleTodoIds, ['todo-1', 'todo-2']);
assert.deepEqual(rows[0].activeCycleChatIds, ['orch-1']);
assert.equal(rows[1].mode, 'observe');
assert.equal(rows[2].workspaceFolder, '/repo/zero');
assert.equal(rows[2].mode, 'off');
assert.equal(rows[2].pinnedChatId, 'pin-off', 'a disabled but pinned workspace stays listed');

const base = workspaceWatcherPresenceKey(rows);
assert.equal(workspaceWatcherPresenceKey(workspaceWatcherPresenceRows([
  {
    workspaceFolder: '/repo/one',
    mode: 'autopilot',
    paused: true,
    stopReason: 'loop_same_findings',
    activeCycle: { chatId: 'orch-1', todoIds: ['todo-1', 'todo-2'] },
  },
  { workspaceFolder: '/repo/two', mode: 'observe' },
  { workspaceFolder: '/repo/off', mode: 'off' },
  { workspaceFolder: '/repo/zero', mode: 'off', pinnedChatId: 'pin-off' },
])), base, 'the fingerprint ignores dropped off rows');
assert.notEqual(
  workspaceWatcherPresenceKey(workspaceWatcherPresenceRows([
    { workspaceFolder: '/repo/one', mode: 'autopilot', paused: false },
  ])),
  base,
  'a pause change changes the fingerprint',
);

const multi = workspaceWatcherPresenceRows([{
  workspaceFolder: '/repo/multi',
  mode: 'autopilot',
  activeCycles: [
    { chatId: 'orch-a', todoIds: ['todo-a'] },
    { chatId: 'orch-b', todoIds: ['todo-b'] },
  ],
}]);
assert.equal(multi[0].activeCycleCount, 2);
assert.deepEqual(multi[0].activeCycleChatIds, ['orch-a', 'orch-b']);

// Recovery read model: liveness evidence maps to one state per `doing` row, and
// an unconfirmed probe is never read as "the run ended".
const classify = (probe, extra = {}) => classifyWorkspaceDoingTodos({
  items: [{ id: 'leaf', status: 'doing', claimedByChatId: 'orch', updatedAt: 'rev-1', execution: { attemptId: 'att-1', cycleId: 'cyc-1' } }],
  delegations: [],
  cycles: [{ cycleId: 'cyc-1', chatId: 'orch', runId: 'run-1', phase: 'running' }],
  probe,
  isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
  now: Date.parse('2026-03-01T10:00:00.000Z'),
  ...extra,
})[0];
const liveBusy = classify(() => ({ known: true, busy: true, reason: 'busy' }));
assert.deepEqual(
  [liveBusy.state, liveBusy.reason, liveBusy.evidence, liveBusy.source, liveBusy.runId, liveBusy.cycleId, liveBusy.attemptId, liveBusy.revision],
  ['active', 'busy', 'chat_run_probe', 'watcher_claim', 'run-1', 'cyc-1', 'att-1', 'rev-1'],
);
assert.equal(classify(() => ({ known: true, busy: false, reason: 'idle' }), { getChat: () => ({ archived: true }) }).state, 'recoverable');
assert.equal(classify(() => ({ known: true, busy: false, reason: 'idle' }), { getChat: () => ({ archived: false }) }).state, 'user_action');
assert.equal(classify(() => ({ known: false, busy: false, reason: 'chat_missing' })).state, 'recoverable');
for (const reason of ['state_missing', 'adapter_missing', 'adapter_error']) {
  const unknown = classify(() => ({ known: false, busy: false, reason }));
  assert.deepEqual([unknown.state, unknown.reason], ['unknown', reason], `${reason} is unknown, not dead`);
}
const occupied = classify(() => ({ known: true, busy: false, reason: 'idle' }), {
  delegations: [{ id: 'job-1', parentChatId: 'orch', status: 'completed', runId: 'child-run', runStoppingAt: '2026-03-01T09:59:30.000Z' }],
});
assert.deepEqual([occupied.state, occupied.reason, occupied.delegationId], ['active', 'run_stopping', 'job-1']);
const starting = classify(() => ({ known: false, busy: false, reason: 'chat_missing' }), {
  cycles: [{ cycleId: 'cyc-1', chatId: 'orch', phase: 'starting', startDeadlineAt: '2026-03-01T10:01:00.000Z' }],
});
assert.deepEqual([starting.state, starting.reason], ['active', 'starting'], 'a reserved start is not a dead run');
const pastStartUnknown = classify(() => ({ known: false, busy: false, reason: 'state_missing' }), {
  cycles: [{ cycleId: 'cyc-1', chatId: 'orch', phase: 'starting', startDeadlineAt: '2026-03-01T09:00:00.000Z' }],
});
assert.deepEqual([pastStartUnknown.state, pastStartUnknown.reason], ['unknown', 'state_missing'], 'starting past deadline with unknown probe is not active');
assert.deepEqual(summarizeWorkspaceTodoRecovery([liveBusy, occupied, { state: 'unknown' }, { state: 'bogus' }]), {
  active: 2, dependency: 0, user_action: 0, recoverable: 0, unknown: 1,
});

console.log('workspace-watcher-live.test.js OK');
