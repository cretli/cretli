/**
 * The chat transport's todo-change dispatcher: a server `todosChanged` frame
 * becomes the `cretli:todo-changed` DOM event the Todo panel listens for. An
 * incomplete frame must never dispatch, so no panel refresh is triggered.
 */
import assert from 'node:assert/strict';

/** @type {CustomEvent[]} */
const dispatched = [];
globalThis.window = {
  dispatchEvent(event) {
    dispatched.push(event);
    return true;
  },
};

const { dispatchTodoChangedEvent, dispatchTodoReconnectEvent } = await import('../app_front/features/chat/chatTransport.js');

assert.equal(dispatchTodoChangedEvent({ todoId: 'todo-1', workspaceFolder: '/ws/a', reason: 'review' }), true);
assert.equal(dispatched.length, 1);
assert.equal(dispatched[0].type, 'cretli:todo-changed');
assert.deepEqual(dispatched[0].detail, { workspaceFolder: '/ws/a', todoId: 'todo-1', reason: 'review' });

// No todo id means nothing to refresh.
assert.equal(dispatchTodoChangedEvent({ workspaceFolder: '/ws/a' }), false);
assert.equal(dispatchTodoChangedEvent(null), false);
assert.equal(dispatched.length, 1, 'an incomplete frame must not dispatch an event');

// A frame without a workspace still dispatches (the panel falls back to its own scope).
assert.equal(dispatchTodoChangedEvent({ todoId: 'todo-2' }), true);
assert.deepEqual(dispatched[1].detail, { workspaceFolder: '', todoId: 'todo-2', reason: '' });

// A reconnect asks for one refresh without a todo id (a frame may have been missed).
assert.equal(dispatchTodoReconnectEvent(), true);
assert.equal(dispatched[2].type, 'cretli:todo-changed');
assert.deepEqual(dispatched[2].detail, { workspaceFolder: '', todoId: '', reason: 'reconnect' });

console.log('OK: todo-change dispatcher emits one DOM event per complete frame');
