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


const policy = { requirePlanApproval: true };

test('UI mark: leaf under an unapproved parent plan reads waiting_plan, other blocks stay blocked', async () => {
  const { readTodoRowGateMark, readTodoRowMark } = await import('../app_front/features/todo/todoTreeView.js');
  const items = [
    row('parent', { plan: { markdown: 'draft' } }),
    row('leaf', { parentId: 'parent' }),
    row('seqparent'), row('first', { parentId: 'seqparent', status: 'idea' }),
    row('second', { parentId: 'seqparent', siblingIndex: 1 }),
    row('stored', { blockedReason: 'needs a decision' }),
  ];
  assert.equal(readTodoRowMark(items, items[1]), 'blocked');
  assert.equal(readTodoRowGateMark(items, items[1], policy), 'waiting_plan');
  assert.equal(readTodoRowGateMark(items, items[1], null), 'blocked');
  assert.equal(readTodoRowGateMark(items, items[5], policy), 'blocked');
  assert.equal(readTodoRowGateMark(items, items[4], policy), 'blocked');
  items[0].plan.approvedAt = '2026-11-01';
  assert.equal(readTodoRowGateMark(items, items[1], policy), 'ready');
  assert.equal(items[1].status, 'ready');
});

test('UI mark: policy off or an approved container body does not claim waiting_plan', async () => {
  const { readTodoRowGateMark } = await import('../app_front/features/todo/todoTreeView.js');
  const items = [row('c', { body: 'Container scope description' }), row('leaf', { parentId: 'c' }), row('solo')];
  assert.equal(readTodoRowGateMark(items, items[1], policy), 'ready');
  assert.equal(readTodoRowGateMark(items, items[2], { requirePlanApproval: false }), 'ready');
  assert.equal(readTodoRowGateMark(items, items[2], policy), 'waiting_plan');
});

test('painted mark flips from waiting_plan to ready when an ancestor plan is approved', async () => {
  // todoRowRender.js needs a DOM and SCSS, so its two call sites share this helper.
  const { readTodoRowPaintMark } = await import('../app_front/features/todo/todoTreeView.js');
  const items = [row('parent', { plan: { markdown: 'draft' } }), row('leaf', { parentId: 'parent' }), row('d', { status: 'done' })];
  assert.equal(readTodoRowPaintMark(items, items[1], { policy }), 'waiting_plan');
  assert.equal(readTodoRowPaintMark(items, items[1], { policy, reviewedOpen: true }), '');
  assert.equal(readTodoRowPaintMark(items, items[2], { policy }), '');
  items[0].plan.approvedAt = '2026-11-01';
  assert.equal(readTodoRowPaintMark(items, items[1], { policy }), 'ready');
});

test('UI mark: a draft plan on a grandparent also reads waiting_plan; another block higher up stays blocked', async () => {
  const { readTodoRowGateMark } = await import('../app_front/features/todo/todoTreeView.js');
  const items = [
    row('root', { plan: { markdown: 'draft' } }),
    row('group', { parentId: 'root' }),
    row('leaf', { parentId: 'group' }),
  ];
  assert.equal(readTodoRowGateMark(items, items[2], policy), 'waiting_plan');
  assert.notEqual(readTodoRowGateMark(items, items[1], policy), 'waiting_plan', 'containers never claim waiting_plan');
  items[0].plan.approvedAt = '2026-11-01';
  assert.equal(readTodoRowGateMark(items, items[2], policy), 'ready');
  // A stored block on the middle node wins over the plan gate above it.
  items[0].plan.approvedAt = '';
  items[1].blockedReason = 'waiting for a decision';
  assert.equal(readTodoRowGateMark(items, items[2], policy), 'blocked');
});
