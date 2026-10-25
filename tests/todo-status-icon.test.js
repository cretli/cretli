import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTodoReviewedButOpen, resolveTodoStatusIcon } from '../app_front/features/todo/todoStatusIcon.js';

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
test('open leaf with a passed code review gets the reviewed-open marker', () => {
  const leaf = { id: 'leaf', parentId: 'root', status: 'ready', title: 'Leaf', review: { code: { state: 'passed' } } };
  const actual = resolveTodoStatusIcon(leaf, [root, leaf]);
  assert.equal(actual.icon, 'mdi-check-decagram-outline');
  assert.equal(actual.labelKey, 'todo.statusReviewedOpen');
  assert.equal(isTodoReviewedButOpen({ ...leaf, status: 'done' }, [leaf]), false);
  assert.equal(isTodoReviewedButOpen({ ...leaf, review: { code: { state: 'pending' } } }, [leaf]), false);
  assert.equal(isTodoReviewedButOpen(root, [root, leaf]), false);
  assert.equal(isTodoReviewedButOpen({ ...leaf, review: { code: { state: 'manual' } } }, [leaf]), true);
});
test('a live agent still wins over the reviewed-open marker', () => {
  const leaf = { id: 'child', parentId: 'root', status: 'doing', title: 'Child', review: { code: { state: 'passed' } } };
  assert.equal(resolveTodoStatusIcon(leaf, [root, leaf], [chat], () => ({ tone: 'active' })).spinning, true);
});

test('deferred has its own icon and never spins or counts as reviewed-open', () => {
  const parked = { id: 'p', status: 'deferred', title: 'Parked', review: { code: { state: 'passed' } } };
  const chats = [{ id: 'c', todoId: 'p' }];
  const actual = resolveTodoStatusIcon(parked, [parked], chats, () => ({ tone: 'active' }));
  assert.equal(actual.icon, 'mdi-calendar-clock-outline');
  assert.equal(actual.spinning, false);
  assert.equal(actual.labelKey, 'todo.statusDeferred');
  assert.equal(isTodoReviewedButOpen(parked, [parked]), false);
});
