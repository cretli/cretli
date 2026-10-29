import assert from 'node:assert/strict';
import test from 'node:test';
import { attachIntegrationRoots, bindDecisionFlush, canSwipe, createDecisionQueue, decisionRequestInit, directionForPointer, groupDecisions, sortDecisions, swipeOption } from '../app_front/features/decisions/decisionLogic.js';

const choices = [
  { id: 'accept', risk: 'low', reversible: true },
  { id: 'reject', risk: 'low', reversible: true },
  { id: 'defer', risk: 'low', reversible: true },
];
const card = { id: 'a', status: 'pending', risk: 'low', reversible: true, humanOnly: false, recommended: 'accept', options: choices };

test('swipes require server low risk, reversibility and non-human-only card and option', () => {
  assert.equal(canSwipe(card), true);
  assert.equal(swipeOption(card, 'right')?.id, 'accept');
  assert.equal(swipeOption(card, 'left')?.id, 'reject');
  assert.equal(swipeOption(card, 'up')?.id, 'defer');
  for (const unsafe of [{ risk: 'medium' }, { reversible: false }, { humanOnly: true }, { status: 'stale' }]) {
    assert.equal(canSwipe({ ...card, ...unsafe }), false);
    assert.equal(swipeOption({ ...card, ...unsafe }, 'right'), null);
  }
  assert.equal(swipeOption({ ...card, options: [{ ...choices[0], risk: 'high' }] }, 'right'), null);
});

test('the touch handle accepts upward defer while the scrollable card body does not', () => {
  const start = { x: 100, y: 160, onHandle: true };
  assert.equal(directionForPointer(start, { x: 106, y: 70 }), 'up');
  assert.equal(directionForPointer({ ...start, onHandle: false }, { x: 106, y: 70 }), null);
  assert.equal(directionForPointer({ ...start, onHandle: false }, { x: 180, y: 155 }), 'right');
  assert.equal(directionForPointer({ ...start, onHandle: false }, { x: 25, y: 155 }), 'left');
  assert.equal(directionForPointer(start, { x: 103, y: 164 }), 'tap');
});

test('sorts blockers, one-hour expiry, then oldest and groups integration cards by tree', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const rows = [
    { id: 'rest', kind: 'scout_finding', createdAt: '2026-10-29T00:00:00Z' },
    { id: 'soon', kind: 'lesson_candidate', expiresAt: '2026-10-30T12:30:00Z' },
    { id: 'i2', kind: 'integration', subject: { rootTodoId: 'tree', todoId: 'b' }, createdAt: '2026-10-30T11:00:00Z' },
    { id: 'i1', kind: 'integration', subject: { rootTodoId: 'tree', todoId: 'a' }, createdAt: '2026-10-30T10:00:00Z' },
    { id: 'blocked', kind: 'needs_human', createdAt: '2026-10-30T09:00:00Z' },
  ];
  assert.deepEqual(sortDecisions(rows, now).map((row) => row.id), ['blocked', 'i1', 'i2', 'soon', 'rest']);
  assert.deepEqual(groupDecisions(rows, now).map((group) => group.cards.map((row) => row.id)),
    [['blocked'], ['i1', 'i2'], ['soon'], ['rest']]);
});

test('groups real integration subjects using the todo parent tree', () => {
  const cards = [{ id: 'a', kind: 'integration', subject: { todoId: 'leaf-a' } },
    { id: 'b', kind: 'integration', subject: { todoId: 'leaf-b' } }];
  const todos = [{ id: 'root' }, { id: 'branch', parentId: 'root' },
    { id: 'leaf-a', parentId: 'branch' }, { id: 'leaf-b', parentId: 'root' }];
  assert.deepEqual(groupDecisions(attachIntegrationRoots(cards, todos))[0].cards.map((item) => item.id), ['a', 'b']);
});

test('undo cancels the delayed POST; page hide flushes it with keepalive', () => {
  const timers = new Map();
  let next = 0;
  const delays = [];
  const sent = [];
  const queue = createDecisionQueue((entry, keepalive) => sent.push({ id: entry.card.id, keepalive }), {
    setTimer(fn, ms) { const id = ++next; timers.set(id, fn); delays.push(ms); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  queue.enqueue({ id: 'one' }, 'accept');
  assert.deepEqual(delays, [5000]);
  assert.equal(sent.length, 0);
  assert.equal(queue.undo('one'), true);
  assert.equal(timers.size, 0);
  queue.enqueue({ id: 'two' }, 'accept');
  const [timerId, callback] = timers.entries().next().value;
  timers.delete(timerId);
  callback();
  assert.deepEqual(sent, [{ id: 'two', keepalive: false }]);
  queue.enqueue({ id: 'three' }, 'accept');
  queue.flush();
  assert.deepEqual(sent.at(-1), { id: 'three', keepalive: true });
  assert.equal(timers.size, 0);
});

test('pagehide and hidden visibility flush pending requests with keepalive POST', () => {
  const page = new EventTarget();
  const visibility = new EventTarget();
  visibility.visibilityState = 'visible';
  const sent = [];
  const queue = createDecisionQueue((entry, keepalive) => sent.push(decisionRequestInit(entry, keepalive)), {
    setTimer: () => 1, clearTimer: () => {},
  });
  const unbind = bindDecisionFlush(queue, page, visibility);
  queue.enqueue({ id: 'one', revision: 3, workspaceFolder: '/my-app' }, 'accept');
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sent.length, 0);
  page.dispatchEvent(new Event('pagehide'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].keepalive, true);
  assert.deepEqual(JSON.parse(sent[0].body), { optionId: 'accept', expectedRevision: 3, reason: '', workspaceFolder: '/my-app' });
  queue.enqueue({ id: 'two', revision: 4 }, 'reject');
  visibility.visibilityState = 'hidden';
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].keepalive, true);
  unbind();
});
