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

console.log('workspace-watcher-live.test.js OK');
