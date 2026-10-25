import assert from 'node:assert/strict';
import { parseChatMessageRef } from '../lib/chat-message-ref.js';
import { formatTodoRef, parseTodoRef } from '../lib/todo-ref.js';

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

const TODO_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

runCase('formatTodoRef: full id and prefix', () => {
  assert.equal(formatTodoRef(TODO_ID), `cretli-ref todo=${TODO_ID}`);
  assert.equal(formatTodoRef(TODO_ID.toUpperCase()), `cretli-ref todo=${TODO_ID}`);
  assert.equal(formatTodoRef('abcdef12'), 'cretli-ref todo=abcdef12');
});

runCase('formatTodoRef: rejects empty and malformed ids', () => {
  assert.equal(formatTodoRef(''), '');
  assert.equal(formatTodoRef('short'), '');
  assert.equal(formatTodoRef('zzzzzzzz'), '');
  assert.equal(formatTodoRef('abcdef12-'), '');
});

runCase('parseTodoRef: parses full id and prefix', () => {
  assert.deepEqual(parseTodoRef(`cretli-ref todo=${TODO_ID}`), { todoId: TODO_ID });
  assert.deepEqual(parseTodoRef('  cretli-ref   todo=abcdef12  '), { todoId: 'abcdef12' });
});

runCase('parseTodoRef: rejects malformed and chat refs', () => {
  assert.equal(parseTodoRef(''), null);
  assert.equal(parseTodoRef('todo=abcdef12'), null);
  assert.equal(parseTodoRef('cretli-ref todo=short'), null);
  assert.equal(parseTodoRef('cretli-ref todo='), null);
  assert.equal(parseTodoRef('cretli-ref todo=zzzzzzzz'), null);
  assert.equal(parseTodoRef('cretli-ref chat=aaaaaaaa-1111-2222-3333-444444444444 seq=3'), null);
});

runCase('todo ref does not collide with the chat message ref parser', () => {
  assert.equal(parseChatMessageRef(`cretli-ref todo=${TODO_ID}`), null);
  assert.deepEqual(
    parseChatMessageRef(`cretli-ref chat=${TODO_ID} seq=3`),
    { chatId: TODO_ID, seq: 3 },
  );
});

process.exit(failed ? 1 : 0);
