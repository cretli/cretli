/**
 * Live todo-review refresh event (docs/todo-review-contract.md §10.7, U7):
 * identifier-only frame, server-side workspace filtering and the widget
 * exclusion, debounced emission only when the snapshot actually changed.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  __clearChatListUpdateClientsForTest,
  broadcastTodoReviewChanged,
  subscribeChatListUpdates,
} from '../lib/chat-list-updates.js';
import {
  clearTodoReviewLiveChanges,
  emitTodoReviewChanged,
  flushTodoReviewLiveChanges,
  pendingTodoReviewLiveChangeCount,
  setTodoReviewLiveDebounceMs,
} from '../lib/todo-review-live.js';
import { syncTodoReviewTarget } from '../lib/todo-review-sync-hooks.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

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
clearTodoReviewLiveChanges();
setTodoReviewLiveDebounceMs(1_000_000); // flush explicitly, never on a timer

runCase('broadcast sends identifiers only to a bare session', () => {
  __clearChatListUpdateClientsForTest();
  const session = socket();
  subscribeChatListUpdates(session, { kind: 'session' });
  broadcastTodoReviewChanged({ workspaceFolder: '/ws/a', todoId: 'todo-1' });
  assert.deepEqual(session.messages, [
    { type: 'todosChanged', reason: 'review', workspaceFolder: '/ws/a', todoId: 'todo-1' },
  ]);
});

runCase('a session scoped to another workspace receives nothing', () => {
  __clearChatListUpdateClientsForTest();
  const local = socket();
  const foreign = socket();
  const bare = socket();
  subscribeChatListUpdates(local, { kind: 'session', workspaceFolder: '/ws/a' });
  subscribeChatListUpdates(foreign, { kind: 'session', workspaceFolder: '/ws/b' });
  subscribeChatListUpdates(bare, { kind: 'session' });
  broadcastTodoReviewChanged({ workspaceFolder: '/ws/a', todoId: 'todo-1' });
  assert.equal(local.messages.length, 1);
  assert.equal(foreign.messages.length, 0, 'a foreign workspace must not receive the frame');
  assert.equal(bare.messages.length, 1, 'the trusted bare session still refreshes');
});

runCase('a widget never receives a todo-change frame in v1 (U7)', () => {
  __clearChatListUpdateClientsForTest();
  const widget = socket();
  subscribeChatListUpdates(widget, { kind: 'widget', chatIds: ['own'], workspaceFolder: '/ws/a' });
  broadcastTodoReviewChanged({ workspaceFolder: '/ws/a', todoId: 'todo-1' });
  assert.deepEqual(widget.messages, []);
});

runCase('an incomplete frame is never broadcast', () => {
  __clearChatListUpdateClientsForTest();
  const session = socket();
  subscribeChatListUpdates(session, { kind: 'session' });
  broadcastTodoReviewChanged({ todoId: 'todo-1' });
  broadcastTodoReviewChanged({ workspaceFolder: '/ws/a' });
  assert.deepEqual(session.messages, []);
});

runCase('the debouncer coalesces one change per workspace+todo', () => {
  __clearChatListUpdateClientsForTest();
  clearTodoReviewLiveChanges();
  assert.equal(emitTodoReviewChanged({ workspaceFolder: '/ws/a', todoId: 't1' }), false, 'no subscribers -> no schedule');
  const session = socket();
  subscribeChatListUpdates(session, { kind: 'session' });
  assert.equal(emitTodoReviewChanged({ workspaceFolder: '/ws/a', todoId: 't1' }), true);
  assert.equal(emitTodoReviewChanged({ workspaceFolder: '/ws/a', todoId: 't1' }), true);
  assert.equal(emitTodoReviewChanged({ workspaceFolder: '/ws/a', todoId: 't2' }), true);
  assert.equal(pendingTodoReviewLiveChangeCount(), 2);
  assert.equal(flushTodoReviewLiveChanges(), 2);
  assert.deepEqual(session.messages.map((frame) => frame.todoId).sort(), ['t1', 't2']);
  assert.equal(pendingTodoReviewLiveChangeCount(), 0);
});

runCase('sync emits on a changed snapshot and stays silent when unchanged', () => {
  __clearChatListUpdateClientsForTest();
  clearTodoReviewLiveChanges();
  const session = socket();
  subscribeChatListUpdates(session, { kind: 'session' });

  const target = { workspaceFolder: '/ws/a', todoId: 'todo-1', dataDir: '/tmp/unused' };
  const changed = syncTodoReviewTarget(target, {
    deps: {
      computeSnapshot: () => ({ code: { state: 'passed' } }),
      writeReview: () => ({ changed: true, generation: 1 }),
    },
  });
  assert.equal(changed.changed, true);
  assert.equal(pendingTodoReviewLiveChangeCount(), 1, 'a changed snapshot schedules exactly one frame');
  flushTodoReviewLiveChanges();
  assert.deepEqual(session.messages.at(-1), {
    type: 'todosChanged',
    reason: 'review',
    workspaceFolder: '/ws/a',
    todoId: 'todo-1',
  });

  session.messages.length = 0;
  const unchanged = syncTodoReviewTarget(target, {
    deps: {
      computeSnapshot: () => ({ code: { state: 'passed' } }),
      writeReview: () => ({ changed: false, generation: 1 }),
    },
  });
  assert.equal(unchanged.changed, false);
  assert.equal(pendingTodoReviewLiveChangeCount(), 0, 'an identical snapshot must not schedule a frame');
  flushTodoReviewLiveChanges();
  assert.deepEqual(session.messages, [], 'no frame and therefore no refresh for an identical snapshot');
});

__clearChatListUpdateClientsForTest();
clearTodoReviewLiveChanges();
removeIsolatedDataDir();

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('todo-review-live: all passed');
