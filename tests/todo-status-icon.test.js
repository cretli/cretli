import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTodoStatusIcon } from '../app_front/features/todo/todoStatusIcon.js';

const root = { id: 'root', status: 'doing', title: 'Parent' };
const child = { id: 'child', parentId: 'root', status: 'doing', title: 'Child' };
const chat = { id: 'chat', todoId: 'child' };

test('doing alone never implies agent work', () => {
  assert.equal(resolveTodoStatusIcon(root, [root]).spinning, false);
});
test('live descendant animates parent even when collapsed', () => {
  const actual = resolveTodoStatusIcon(root, [root, child], [chat], () => ({ tone: 'active' }));
  assert.equal(actual.spinning, true);
  assert.equal(actual.title, 'Child');
});
test('input wait pauses instead of spinning', () => {
  const actual = resolveTodoStatusIcon(root, [root, child], [chat], () => ({ tone: 'approval' }));
  assert.equal(actual.icon, 'mdi-pause-circle-outline');
  assert.equal(actual.spinning, false);
});
test('finished tasks and unrelated chats cannot animate a task', () => {
  assert.equal(resolveTodoStatusIcon({ ...root, status: 'done' }, [root, child], [chat], () => ({ tone: 'active' })).spinning, false);
  assert.equal(resolveTodoStatusIcon(root, [root], [chat], () => ({ tone: 'active' })).spinning, false);
});
test('explicit chat todo association overrides stale linked role', () => {
  const linked = { ...root, chats: [{ id: 'chat', roles: ['orchestrator'] }] };
  assert.equal(resolveTodoStatusIcon(linked, [linked], [chat], () => ({ tone: 'active' })).spinning, false);
});
