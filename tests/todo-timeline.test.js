import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildTodoTimeline, normalizeTodoActivity } from '../lib/todo-timeline.js';
import { addTodo, getTodoById, updateTodo, linkTodoChat } from '../lib/persist/todos-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { registerTodosRoutes, slimTodoForList } from '../lib/routes/todos-routes.js';

const at = (minute) => `2026-01-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

test('timeline retains previous rounds, cancelled attempts and verification, scoped to the exact TODO', () => {
  const item = { id: 'todo', createdAt: at(0), plan: { markdownUpdatedAt: at(4), approvedAt: at(6) }, changelog: [] };
  const rows = [
    { id: 'old-review', leafId: 'todo', workRole: 'review_plan', planReviewerSessionId: 'round-1',
      attemptId: 'cancelled', queuedAt: at(1), startedAt: at(2), finishedAt: at(3), status: 'cancelled',
      executor: { transport: 'codex', model: 'model-a' }, childChatId: 'chat-a' },
    { id: 'review', leafId: 'todo', workRole: 'review_plan', planReviewerSessionId: 'round-2',
      attemptId: 'passed', queuedAt: at(5), startedAt: at(6), finishedAt: at(7), status: 'completed', reportVerdict: 'PASS',
      executor: { transport: 'claude', model: 'model-b' }, childChatId: 'chat-b',
      verifyResult: { recordedAt: at(8), status: 'passed', verdict: 'PASS', outputTail: 'private verify output' } },
    { id: 'foreign', leafId: 'another-todo', childChatId: 'chat-a', queuedAt: at(0), report: 'another task' },
  ];
  const entries = buildTodoTimeline(item, rows.reverse());
  assert.deepEqual(entries.map((entry) => entry.at), entries.map((entry) => entry.at).sort());
  const finished = entries.filter((entry) => entry.kind === 'delegation_finished');
  assert.deepEqual(finished.map((entry) => [entry.round, entry.status, entry.verdict]), [[1, 'cancelled', ''], [2, 'completed', 'PASS']]);
  assert.equal(finished[0].harness, 'codex');
  assert.equal(entries.at(-1).kind, 'delegation_verified');
  assert.equal(entries.at(-1).chatId, 'chat-b');
  assert.doesNotMatch(JSON.stringify(entries), /private verify output|another task|foreign/);
});

test('archived retries keep their own verdict and verify result without duplicating the current attempt', () => {
  const previous = { attemptId: 'first', queuedAt: at(1), startedAt: at(2), finishedAt: at(3), status: 'failed', reportVerdict: 'FAIL' };
  const current = { id: 'job', leafId: 'todo', attemptId: 'second', queuedAt: at(4), startedAt: at(5), finishedAt: at(6), status: 'completed', reportVerdict: 'PASS' };
  const entries = buildTodoTimeline({ id: 'todo' }, [{ ...current, attempts: [previous, current] }]);
  assert.deepEqual(entries.filter((entry) => entry.kind === 'delegation_finished').map((entry) => entry.verdict), ['FAIL', 'PASS']);
});

test('retargeted delegations expose only attempts bound to this TODO', () => {
  const rows = [{ id: 'retargeted', leafId: 'other', attemptId: 'current', queuedAt: at(3),
    attempts: [{ leafId: 'todo', attemptId: 'past', queuedAt: at(1), finishedAt: at(2), status: 'failed' }] }];
  const entries = buildTodoTimeline({ id: 'todo' }, rows);
  assert.deepEqual([...new Set(entries.map((entry) => entry.attemptId))], ['past']);
  const otherEntries = buildTodoTimeline({ id: 'other' }, rows);
  assert.deepEqual([...new Set(otherEntries.map((entry) => entry.attemptId))], ['current']);
});

test('legacy milestones and notes are dated and invalid or duplicate milestones are omitted', () => {
  const entries = buildTodoTimeline({
    id: 'todo', createdAt: at(0), plan: { markdownUpdatedAt: at(1), approvedAt: at(2) },
    activity: [{ id: 'audit', kind: 'plan_saved', at: at(1) }, { kind: 'plan_saved', at: 'invalid' }],
    changelog: [{ at: at(3), kind: 'implement', text: 'Saved implementation note', chatId: 'chat' }],
  });
  assert.deepEqual(entries.map((entry) => entry.kind), ['created', 'plan_saved', 'plan_approved', 'note']);
  assert.equal(entries.at(-1).text, 'Saved implementation note');
  assert.deepEqual(normalizeTodoActivity([null, {}, { kind: 'invented', at: at(1) }]), []);
});

test('real saves persist plan edits, approval invalidation and status changes but skip no-op and chat-link writes', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-timeline-'));
  const dataDir = path.join(cwd, 'data');
  const initial = addTodo(dataDir, cwd, { title: 'Task' }).item;
  updateTodo(dataDir, cwd, initial.id, { plan: { markdown: 'Plan v1' } });
  updateTodo(dataDir, cwd, initial.id, { plan: { approvedAt: at(1) }, status: 'ready' });
  updateTodo(dataDir, cwd, initial.id, { plan: { markdown: 'Plan v2' } });
  const current = getTodoById(dataDir, cwd, initial.id);
  assert.deepEqual(current.activity.map((entry) => entry.kind), ['plan_saved', 'status_changed', 'plan_approved', 'plan_saved', 'approval_removed']);
  const count = current.activity.length;
  updateTodo(dataDir, cwd, initial.id, { plan: { markdown: 'Plan v2' } });
  linkTodoChat(dataDir, cwd, initial.id, randomUUID());
  assert.equal(getTodoById(dataDir, cwd, initial.id).activity.length, count);
  assert.equal('activity' in slimTodoForList(current), false, 'the list never carries the full audit trail');
});

test('history endpoint returns saved delegations and refuses a TODO from another workspace', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-timeline-route-'));
  const dataDir = path.join(cwd, 'data');
  const item = addTodo(dataDir, cwd, { title: 'Task' }).item;
  const delegation = createDelegationRecord({
    parentChatId: randomUUID(), childChatId: randomUUID(), workspaceFolder: cwd,
    leafId: item.id, executor: { transport: 'codex', model: 'model-a' }, queuedAt: at(1),
  });
  updateDelegationRecord(delegation.id, { startedAt: at(2) });
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map((method) => [method, (route, handler) => routes.set(`${method} ${route}`, handler)]));
  registerTodosRoutes(app, { dataDir, getCurrentCwd: () => cwd });
  const invoke = (workspaceFolder) => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    routes.get('get /api/todos/:id/history')({ params: { id: item.id }, query: { workspaceFolder } }, response);
    return response;
  };
  const result = invoke(cwd);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.entries.some((entry) => entry.delegationId === delegation.id), true);
  const other = invoke(mkdtempSync(path.join(os.tmpdir(), 'cr-timeline-other-')));
  assert.equal(other.statusCode, 404);
});
