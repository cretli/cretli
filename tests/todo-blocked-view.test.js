/** Input state (todo rows + watcher state) -> blocked cause/action decisions. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTodoBlockedView, decideBlockedTodo } from '../lib/todo-blocked-view.js';

const NOW = Date.parse('2026-10-24T10:00:00Z');
const row = (id, extra = {}) => ({ id, title: `T-${id}`, status: 'ready', siblingIndex: 0, ...extra });
const decide = (items, id, extra = {}) => decideBlockedTodo({ item: items.find((r) => r.id === id), items, now: NOW, ...extra });

test('earlier open sibling blocks a later one -> defer', () => {
  const items = [row('p'), row('a', { parentId: 'p', status: 'idea' }), row('b', { parentId: 'p', siblingIndex: 1 })];
  assert.deepEqual(decide(items, 'b'), { todoId: 'b', cause: 'blocked_sibling', action: 'defer', detail: 'T-a', blockerId: 'a' });
});

test('deferred or done sibling does not block', () => {
  const items = [row('p'), row('a', { parentId: 'p', status: 'deferred' }), row('b', { parentId: 'p', siblingIndex: 1 })];
  assert.equal(decide(items, 'b'), null);
});

test('unapproved parent plan -> open report; approved ancestor unlocks', () => {
  const items = [row('r', { plan: { markdown: 'x', approvedAt: '' } }), row('p', { parentId: 'r', plan: { markdown: 'y' } }), row('c', { parentId: 'p' })];
  assert.equal(decide(items, 'c').cause, 'plan_unapproved');
  assert.equal(decide(items, 'c').action, 'open_report');
  items[0].plan.approvedAt = '2026-10-01';
  assert.equal(decide(items, 'c'), null);
});

test('missing parent -> orphan, ready', () => {
  const d = decide([row('c', { parentId: 'gone' })], 'c');
  assert.equal(d.cause, 'orphan');
  assert.equal(d.action, 'ready');
});

test('active backoff -> backoff; expired backoff -> none', () => {
  const items = [row('a')];
  assert.equal(decide(items, 'a', { backoffUntil: '2026-10-24T11:00:00Z' }).cause, 'backoff');
  assert.equal(decide(items, 'a', { backoffUntil: '2026-10-24T09:00:00Z' }), null);
});

test('watcher-parked blockedReason -> parked, ready', () => {
  assert.equal(decide([row('a', { blockedReason: 'parked' })], 'a').cause, 'parked');
});

test('doing rows: dead container and stale worktree; active stays unlisted', () => {
  const items = [row('a', { status: 'doing' })];
  assert.equal(decide(items, 'a', { doingState: { state: 'recoverable', reason: 'chat_missing' } }).cause, 'dead_container');
  assert.equal(decide(items, 'a', { doingState: { state: 'user_action', reason: 'worktree_open' } }).action, 'refresh_worktree');
  assert.equal(decide(items, 'a', { doingState: { state: 'active', reason: 'busy' } }), null);
});

test('done todos are never blocked', () => {
  assert.equal(decide([row('a', { status: 'done', blockedReason: 'x' })], 'a'), null);
});

test('buildTodoBlockedView groups by cause and skips grouping nodes', () => {
  const items = [
    row('p'),
    row('a', { parentId: 'p', status: 'idea' }),
    row('b', { parentId: 'p', siblingIndex: 1 }),
    row('o', { parentId: 'gone' }),
  ];
  const view = buildTodoBlockedView({ items, now: NOW });
  assert.equal(view.total, 2);
  assert.deepEqual(view.groups.map((g) => g.cause), ['blocked_sibling', 'orphan']);
});

test('doing leaf with failed review -> review_failed needs-human, open report', () => {
  const items = [row('a', { status: 'doing', review: { code: { state: 'failed', reason: 'review_failed' } } })];
  const d = decide(items, 'a', { doingState: { state: 'user_action', reason: 'review_failed' } });
  assert.equal(d.cause, 'review_failed');
  assert.equal(d.action, 'open_report');
  assert.equal(buildTodoBlockedView({ items, doingStates: [{ todoId: 'a', state: 'user_action', reason: 'review_failed' }], now: NOW }).groups[0].cause, 'review_failed');
});

test('UI maps refresh_worktree to the refresh endpoint, not a todo patch', async () => {
  const { blockedActionPatch, blockedActionRequest } = await import('../app_front/features/todo/todoBlockedView.js');
  assert.equal(blockedActionPatch('refresh_worktree'), null);
  const req = blockedActionRequest('refresh_worktree', 'abc');
  assert.equal(req.path, '/api/workspace-watcher/refresh-worktree');
  assert.deepEqual(req.options, { method: 'POST', body: { todoId: 'abc' } });
  assert.equal(blockedActionRequest('ready', 'abc'), null);
});
