/**
 * Workspace Watcher history repair (leaf R18): preview + selective apply of the
 * false failures/backoff/blockedReason left by the 2026-10-07 restart incident.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import {
  applyWorkspaceWatcherHistoryRepair,
  previewWorkspaceWatcherHistoryRepair,
} from '../lib/workspace-watcher-history-repair.js';
import { workspaceWatcherFailureCeilingReason } from '../lib/workspace-watcher-blocked-reason.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-repair-'));
const RESTART = '2026-10-07T15:00:00.000Z';
const STARTED = '2026-10-07T14:50:00.000Z';
const CLOSED = '2026-10-07T15:05:00.000Z';
const LATE = '2026-10-08T10:00:00.000Z';
const BACKOFF = '2026-10-07T20:00:00.000Z';
let seq = 0;

function chat(todoId, over = {}) {
  seq += 1;
  return {
    id: `chat-${seq}`, cycleId: `cycle-${seq}`, todoIds: [todoId], startedAt: STARTED, at: CLOSED, outcome: 'failure',
    closeSource: 'reconcile', closeReason: 'cycle_room_gone', ...over,
  };
}

function setup(name, build) {
  const dataDir = path.join(tmpRoot, `d-${name}`);
  const cwd = path.join(tmpRoot, `w-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const todo = addTodo(dataDir, cwd, { title: 't', status: 'ready' }).item;
  const spec = build(todo.id);
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { maxConsecutiveFailures: 3 },
    failures: spec.failures,
    backoffUntil: spec.backoffUntil ?? BACKOFF,
    cycleChats: spec.chats,
  }, { dataDir });
  if (spec.blocked) {
    const t = getTodoById(dataDir, cwd, todo.id);
    updateTodo(dataDir, cwd, todo.id, { status: 'ready', strictStatus: true, blockedReason: workspaceWatcherFailureCeilingReason(3, 3), expectedUpdatedAt: t.updatedAt });
  }
  return { dataDir, cwd, todoId: todo.id };
}

const win = { restartAt: [RESTART] };
function previewApply(ctx, extra = {}) {
  const p = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win, ...extra });
  const r = applyWorkspaceWatcherHistoryRepair({
    dataDir: ctx.dataDir, ...win, ...extra, apply: true, casToken: p.casToken, previewId: p.previewId, actor: 'test', now: Date.parse(CLOSED),
  });
  return { p, r };
}

// 1. incident-like: 3 orphan cycles + 1 restart-killed -> full restore
{
  const ctx = setup('incident', (id) => ({
    failures: { [id]: 4 },
    blocked: true,
    chats: [chat(id), chat(id), chat(id), chat(id, { closeReason: 'missing_report' })],
  }));
  const p = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(p.candidates.length, 1);
  assert.equal(p.candidates[0].cycleIds.length, 4);
  assert.equal(p.candidates[0].current.failures, 4);
  assert.equal(p.candidates[0].proposed.failures, 0);
  assert.equal(p.candidates[0].proposed.backoffUntil, '');
  assert.equal(p.candidates[0].proposed.blockedReason, '');
  assert.ok(p.candidates[0].evidence.length === 4);
  // preview writes nothing
  assert.equal(getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir }).failures[ctx.todoId], 4);
  const { r } = previewApply(ctx);
  assert.equal(r.ok, true);
  const row = getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir });
  assert.equal(row.failures[ctx.todoId], undefined);
  assert.equal(row.backoffUntil, '');
  assert.ok(row.cycleChats.every((c) => c.outcome === 'interrupted_restart'));
  assert.equal(row.historyRepairs.length, 1);
  assert.equal(row.historyRepairs[0].before.failures, 4);
  assert.equal(row.historyRepairs[0].after.failures, 0);
  assert.equal(row.historyRepairs[0].actor, 'test');
  assert.equal(getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId).blockedReason || '', '');
  // 5. second apply is a no-op
  const again = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(again.candidates.length, 0);
  const second = applyWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win, apply: true, casToken: again.casToken, previewId: again.previewId });
  assert.equal(second.ok, true);
  assert.equal(second.applied.length, 0);
  assert.equal(getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir }).historyRepairs.length, 1);
}
console.log('OK: incident-like store is previewed, restored, and a second apply is a no-op');

// 2. genuine failure stays
{
  const ctx = setup('genuine', (id) => ({
    failures: { [id]: 2 },
    chats: [chat(id, { closeSource: 'report', closeReason: 'cycle_failure' }), chat(id, { closeReason: 'cycle_no_progress' })],
  }));
  const { p, r } = previewApply(ctx);
  assert.equal(p.candidates.length, 0);
  assert.equal(r.applied.length, 0);
  const row = getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir });
  assert.equal(row.failures[ctx.todoId], 2);
  assert.equal(row.backoffUntil, BACKOFF);
}
console.log('OK: genuine failures stay untouched');

// 3. mixed: partial decrement, backoff and blocker stay when genuine failures remain
{
  const ctx = setup('mixed', (id) => ({
    failures: { [id]: 3 },
    blocked: true,
    chats: [chat(id, { closeSource: 'report', closeReason: 'cycle_failure' }), chat(id), chat(id)],
  }));
  const { p, r } = previewApply(ctx);
  assert.equal(p.candidates[0].proposed.failures, 1);
  assert.equal(r.ok, true);
  const row = getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir });
  assert.equal(row.failures[ctx.todoId], 1);
  assert.equal(row.backoffUntil, BACKOFF, 'backoff is not cleared while a genuine failure remains');
  assert.equal(row.cycleChats.filter((c) => c.outcome === 'interrupted_restart').length, 2);
  assert.equal(row.cycleChats.filter((c) => c.outcome === 'failure').length, 1);
  assert.equal(getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId).blockedReason || '', '');
}
console.log('OK: mixed genuine + artefact decrements only the artefacts');

// 4. stale CAS aborts
{
  const ctx = setup('stale', (id) => ({ failures: { [id]: 1 }, chats: [chat(id)] }));
  const p = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  upsertWorkspaceWatcher(ctx.cwd, { stopReason: 'changed-after-preview' }, { dataDir: ctx.dataDir });
  const r = applyWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win, apply: true, casToken: p.casToken, previewId: p.previewId });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale_preview');
  assert.equal(getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir }).failures[ctx.todoId], 1);
  const noFlag = applyWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win, casToken: p.casToken, previewId: p.previewId });
  assert.equal(noFlag.reason, 'apply_flag_required');
}
console.log('OK: stale CAS and missing apply flag abort without writing');

// 6. old rows without evidence -> insufficient_evidence, never corrected
{
  const ctx = setup('legacy', (id) => ({
    failures: { [id]: 2 },
    chats: [chat(id, { closeSource: null, closeReason: '' }), chat(id, { at: LATE })],
  }));
  const { p, r } = previewApply(ctx);
  assert.equal(p.candidates.length, 0);
  assert.deepEqual(p.insufficient_evidence.map((i) => i.reason).sort(), ['closed_after_grace', 'legacy_row_without_close_evidence']);
  assert.equal(r.applied.length, 0);
  assert.equal(getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir }).failures[ctx.todoId], 2);
  const noWindow = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir });
  assert.ok(noWindow.insufficient_evidence.some((i) => i.reason === 'no_restart_instant_given'));
}
console.log('OK: rows without evidence are reported as insufficient_evidence');

// F4 (a)(b): a cycle that ran entirely after / before the restart is genuine
{
  const ctx = setup('nospan', (id) => ({
    failures: { [id]: 2 },
    chats: [
      chat(id, { startedAt: '2026-10-07T15:01:00.000Z', closeReason: 'missing_report' }),
      chat(id, { startedAt: '2026-10-07T14:30:00.000Z', at: '2026-10-07T14:40:00.000Z', closeReason: 'missing_report' }),
    ],
  }));
  const { p, r } = previewApply(ctx);
  assert.equal(p.candidates.length, 0);
  assert.equal(r.applied.length, 0);
  assert.equal(getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir }).failures[ctx.todoId], 2);
  // a missing startedAt is insufficient, not an artefact
  const noStart = setup('nostart', (id) => ({ failures: { [id]: 1 }, chats: [chat(id, { startedAt: '' })] }));
  const q = previewWorkspaceWatcherHistoryRepair({ dataDir: noStart.dataDir, ...win });
  assert.equal(q.candidates.length, 0);
  assert.equal(q.insufficient_evidence[0].reason, 'started_at_missing');
}
console.log('OK: cycles that did not span the restart are genuine');

// F4 (c): missing or one-sided window never yields a candidate
{
  const ctx = setup('onesided', (id) => ({ failures: { [id]: 1 }, chats: [chat(id)] }));
  for (const extra of [{ restartAt: [] }, { from: '2026-10-07T00:00:00Z' }, { to: '2026-10-09T00:00:00Z' }, { restartAt: ['garbage'] }]) {
    const p = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...extra });
    assert.equal(p.candidates.length, 0, JSON.stringify(extra));
    assert.equal(p.insufficient_evidence[0].reason, 'no_restart_instant_given');
  }
  const huge = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, restartAt: RESTART, graceMs: 1e12 });
  assert.equal(huge.window.graceMs, 6 * 60 * 60_000, 'grace is capped');
}
console.log('OK: missing/one-sided window is not evidence');

// F4 (d): multi-todo row, all artefacts: backoff cleared, audit accurate
{
  const dataDir = path.join(tmpRoot, 'd-multi');
  const cwd = path.join(tmpRoot, 'w-multi');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const a = addTodo(dataDir, cwd, { title: 'a', status: 'ready' }).item;
  const b = addTodo(dataDir, cwd, { title: 'b', status: 'ready' }).item;
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot', policy: { maxConsecutiveFailures: 3 }, failures: { [a.id]: 2, [b.id]: 1 }, backoffUntil: BACKOFF,
    cycleChats: [chat(a.id), chat(a.id), chat(b.id)],
  }, { dataDir });
  const ctx = { dataDir, cwd };
  const { p, r } = previewApply(ctx);
  assert.equal(p.candidates.length, 2);
  assert.ok(p.candidates.every((c) => c.proposed.backoffUntil === ''));
  assert.equal(r.ok, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(row.failures, {});
  assert.equal(row.backoffUntil, '');
  assert.equal(row.historyRepairs.length, 2);
  for (const rec of row.historyRepairs) {
    assert.equal(rec.after.backoffUntil, '');
    assert.equal(rec.row.failuresBefore, 3);
    assert.equal(rec.row.failuresAfter, 0);
  }
}
console.log('OK: multi-todo row clears backoff with an accurate audit');

// F4 (e): todo CAS miss is recorded, and a rerun clears the blocker idempotently
{
  const ctx = setup('casmiss', (id) => ({ failures: { [id]: 3 }, blocked: true, chats: [chat(id), chat(id), chat(id)] }));
  const p = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  const first = applyWorkspaceWatcherHistoryRepair({
    dataDir: ctx.dataDir, ...win, apply: true, casToken: p.casToken, previewId: p.previewId, now: Date.parse(CLOSED),
    beforeTodoUpdate: () => {
      const t = getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId);
      updateTodo(ctx.dataDir, ctx.cwd, ctx.todoId, { title: 'edited concurrently', expectedUpdatedAt: t.updatedAt });
    },
  });
  assert.equal(first.todoUpdates[0].status, 'cas_miss');
  let row = getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir });
  assert.equal(row.historyRepairs[0].todoUpdate, 'cas_miss');
  assert.ok(getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId).blockedReason, 'still blocked after the miss');
  const again = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(again.candidates.length, 1);
  assert.equal(again.candidates[0].blockedOnly, true);
  const second = applyWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win, apply: true, casToken: again.casToken, previewId: again.previewId });
  assert.equal(second.todoUpdates[0].status, 'cleared');
  assert.equal(getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId).blockedReason || '', '');
  row = getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir });
  assert.equal(row.historyRepairs.length, 1, 'retry updates the original record');
  assert.equal(row.historyRepairs[0].todoUpdate, 'cleared_on_retry');
  assert.ok(row.historyRepairs[0].retriedAt);
  const third = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(third.candidates.length, 0, 'rerun is idempotent');
}
console.log('OK: todo cas_miss is audited and a rerun repairs it');

// F2 round 3 (a): a NEW failure-ceiling blocker after a 'cleared' repair is not touched
{
  const ctx = setup('later-blocker', (id) => ({ failures: { [id]: 3 }, blocked: true, chats: [chat(id), chat(id), chat(id)] }));
  previewApply(ctx);
  assert.equal(getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir }).historyRepairs[0].todoUpdate, 'cleared');
  // Later genuine blocker (different counters) on the same todo, failures below ceiling in the row.
  const t = getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId);
  updateTodo(ctx.dataDir, ctx.cwd, ctx.todoId, { status: 'ready', strictStatus: true, blockedReason: workspaceWatcherFailureCeilingReason(4, 3), expectedUpdatedAt: t.updatedAt });
  const p = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(p.candidates.length, 0);
  const r = applyWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win, apply: true, casToken: p.casToken, previewId: p.previewId });
  assert.equal(r.applied.length, 0);
  assert.ok(getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId).blockedReason, 'later blocker untouched');
}
console.log('OK: a later failure-ceiling blocker is not cleared by an old repair');

// F2 round 3 (b): cas_miss repair, genuine failures back at the ceiling -> not cleared
{
  const ctx = setup('risen', (id) => ({ failures: { [id]: 3 }, blocked: true, chats: [chat(id), chat(id), chat(id)] }));
  const p0 = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  applyWorkspaceWatcherHistoryRepair({
    dataDir: ctx.dataDir, ...win, apply: true, casToken: p0.casToken, previewId: p0.previewId,
    beforeTodoUpdate: () => {
      const t = getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId);
      updateTodo(ctx.dataDir, ctx.cwd, ctx.todoId, { title: 'concurrent', expectedUpdatedAt: t.updatedAt });
    },
  });
  upsertWorkspaceWatcher(ctx.cwd, { failures: { [ctx.todoId]: 3 } }, { dataDir: ctx.dataDir });
  const p = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(p.candidates.length, 0);
  assert.ok(getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId).blockedReason);
}
console.log('OK: cas_miss retry is refused when genuine failures are back at the ceiling');

// F2 round 3 (c): the retry happens once; afterwards nothing is proposed again
{
  const ctx = setup('retry-once', (id) => ({ failures: { [id]: 3 }, blocked: true, chats: [chat(id), chat(id), chat(id)] }));
  const p0 = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  applyWorkspaceWatcherHistoryRepair({
    dataDir: ctx.dataDir, ...win, apply: true, casToken: p0.casToken, previewId: p0.previewId,
    beforeTodoUpdate: () => {
      const t = getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId);
      updateTodo(ctx.dataDir, ctx.cwd, ctx.todoId, { title: 'concurrent', expectedUpdatedAt: t.updatedAt });
    },
  });
  const p1 = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(p1.candidates.length, 1);
  assert.equal(p1.candidates[0].retryOf, getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir }).historyRepairs[0].idempotencyKey);
  const r1 = applyWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win, apply: true, casToken: p1.casToken, previewId: p1.previewId });
  assert.equal(r1.todoUpdates[0].status, 'cleared');
  const p2 = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(p2.candidates.length, 0);
}
console.log('OK: cas_miss retry runs once and is not proposed again');

// blockedOnly retry hits cas_miss again -> record stays cas_miss and is proposed again
{
  const ctx = setup('retry-miss-again', (id) => ({ failures: { [id]: 3 }, blocked: true, chats: [chat(id), chat(id), chat(id)] }));
  const concurrentEdit = () => {
    const t = getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId);
    updateTodo(ctx.dataDir, ctx.cwd, ctx.todoId, { title: `concurrent ${Math.random()}`, expectedUpdatedAt: t.updatedAt });
  };
  const p0 = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  applyWorkspaceWatcherHistoryRepair({
    dataDir: ctx.dataDir, ...win, apply: true, casToken: p0.casToken, previewId: p0.previewId, beforeTodoUpdate: concurrentEdit,
  });
  const p1 = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(p1.candidates.length, 1);
  assert.equal(p1.candidates[0].blockedOnly, true);
  const r1 = applyWorkspaceWatcherHistoryRepair({
    dataDir: ctx.dataDir, ...win, apply: true, casToken: p1.casToken, previewId: p1.previewId, beforeTodoUpdate: concurrentEdit,
  });
  assert.equal(r1.todoUpdates[0].status, 'cas_miss');
  const row = getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir });
  assert.equal(row.historyRepairs.length, 1);
  assert.equal(row.historyRepairs[0].todoUpdate, 'cas_miss', 'record stays cas_miss');
  assert.ok(getTodoById(ctx.dataDir, ctx.cwd, ctx.todoId).blockedReason, 'still blocked');
  const p2 = previewWorkspaceWatcherHistoryRepair({ dataDir: ctx.dataDir, ...win });
  assert.equal(p2.candidates.length, 1, 'proposed again');
  assert.equal(p2.candidates[0].blockedOnly, true);
  assert.equal(p2.candidates[0].retryOf, row.historyRepairs[0].idempotencyKey);
}
console.log('OK: a second cas_miss on the retry keeps the record and proposes it again');

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('\nworkspace watcher history repair tests passed');
