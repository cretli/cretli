/**
 * Flag-gated automatic leaf close after code review PASS (stage 4):
 * `evaluateTodoLeafAutoClose`, `closeTodoLeafIfEligible` and the sync hook.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-persist.js';
import { evaluateTodoLeafAutoClose, isTodoLeafAutoCloseEnabled } from '../lib/todo-review-sync.js';
import { closeTodoLeafAfterReview, syncTodoReviewTarget } from '../lib/todo-review-sync-hooks.js';

let seq = 0;
const t = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

function makeProject() {
  const dir = path.join(ISOLATED_DATA_DIR, `auto-close-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeLeaf(project) {
  return addTodo(ISOLATED_DATA_DIR, project, { title: 'Leaf', status: 'doing' }).item;
}

function statusOf(project, id) {
  return loadTodosData(ISOLATED_DATA_DIR, project).items.find((row) => row.id === id).status;
}

function row(leafId, assignment, overrides = {}) {
  const at = overrides.queuedAt || t(1);
  return {
    id: `${assignment}-${++seq}`,
    workspaceFolder: '/tmp/ws',
    leafId,
    parentChatId: 'parent',
    assignment,
    executionMode: 'agent',
    status: 'completed',
    attemptId: `att-${++seq}`,
    queuedAt: at,
    createdAt: at,
    startedAt: at,
    finishedAt: at,
    executor: { transport: 'opencode', model: assignment === 'review' ? 'deepseek-chat' : 'gpt-5' },
    ...(assignment === 'review'
      ? {
        reviewSubject: 'code',
        reviewSubjectSource: 'explicit',
        reportVerdict: 'PASS',
        verifyRequired: false,
        report: 'TASK: review\nVERDICT: PASS',
      }
      : { report: '' }),
    ...overrides,
  };
}

function passedRows(leafId) {
  return [row(leafId, 'implement', { queuedAt: t(1) }), row(leafId, 'review', { queuedAt: t(3) })];
}

function close(project, leafId, rows) {
  return closeTodoLeafAfterReview({
    dataDir: ISOLATED_DATA_DIR, workspaceFolder: project, todoId: leafId, rows,
  });
}

test('AC1: doing -> done when review passed and nothing blocks', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const result = close(project, leaf.id, passedRows(leaf.id));
  assert.equal(result.closed, true);
  assert.equal(statusOf(project, leaf.id), 'done');
});

test('AC1: integration.ready leaf is not closed', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  updateTodo(ISOLATED_DATA_DIR, project, leaf.id, { integration: { state: 'ready' } });
  const result = close(project, leaf.id, passedRows(leaf.id));
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'awaiting_integration');
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('AC2: implement/fix queued after the review blocks the close', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = [
    ...passedRows(leaf.id),
    row(leaf.id, 'implement', { pickRole: 'fix', queuedAt: t(5), status: 'queued', startedAt: '', finishedAt: '' }),
  ];
  assert.equal(close(project, leaf.id, rows).closed, false);
  // Even a completed fix queued after the review makes the review stale.
  const stale = [...passedRows(leaf.id), row(leaf.id, 'implement', { pickRole: 'fix', queuedAt: t(5) })];
  const result = close(project, leaf.id, stale);
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'review_stale');
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('AC3: two close attempts produce exactly one transition', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = passedRows(leaf.id);
  const results = [close(project, leaf.id, rows), close(project, leaf.id, rows)];
  assert.equal(results.filter((r) => r.closed).length, 1);
  assert.equal(results[1].reason, 'not_doing');
});

test('AC4: flag off changes nothing through the sync hook', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  assert.equal(isTodoLeafAutoCloseEnabled({}), false);
  const deps = { rows: passedRows(leaf.id) };
  syncTodoReviewTarget(
    { workspaceFolder: project, todoId: leaf.id, dataDir: ISOLATED_DATA_DIR },
    { env: {}, deps },
  );
  assert.equal(statusOf(project, leaf.id), 'doing');
  const on = { CRETLI_TODO_LEAF_AUTO_CLOSE: '1' };
  assert.equal(isTodoLeafAutoCloseEnabled(on), true);
  syncTodoReviewTarget(
    { workspaceFolder: project, todoId: leaf.id, dataDir: ISOLATED_DATA_DIR },
    { env: on, deps },
  );
  assert.equal(statusOf(project, leaf.id), 'done');
});

test('AC5: a plan-review PASS never closes a leaf', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = [row(leaf.id, 'review', { reviewSubject: 'plan' })];
  const result = close(project, leaf.id, rows);
  assert.equal(result.closed, false);
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('cancel_unconfirmed slot blocks the close', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = [
    ...passedRows(leaf.id),
    row(leaf.id, 'implement', { queuedAt: t(0), slotHeldBy: 'cancel_unconfirmed', status: 'interrupted' }),
  ];
  const result = close(project, leaf.id, rows);
  assert.equal(result.reason, 'cancel_unconfirmed');
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('failed, unknown and verify-missing reviews do not close', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const impl = row(leaf.id, 'implement', { queuedAt: t(1) });
  const cases = [
    row(leaf.id, 'review', { queuedAt: t(3), reportVerdict: 'FAIL', report: 'VERDICT: FAIL' }),
    row(leaf.id, 'review', { queuedAt: t(3), verifyRequired: true, reviewCanRunTests: false }),
  ];
  for (const review of cases) {
    assert.equal(close(project, leaf.id, [impl, review]).closed, false);
  }
  assert.equal(close(project, leaf.id, []).closed, false);
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('a parent is never closed explicitly', () => {
  const project = makeProject();
  const parent = makeLeaf(project);
  addTodo(ISOLATED_DATA_DIR, project, { title: 'Child', status: 'doing', parentId: parent.id });
  const verdict = evaluateTodoLeafAutoClose({
    todo: parent,
    items: loadTodosData(ISOLATED_DATA_DIR, project).items,
    rows: passedRows(parent.id),
  });
  assert.equal(verdict.reason, 'not_leaf');
});

test('F1: worktree-mode leaf with PASS and no integration object is not closed', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  updateTodo(ISOLATED_DATA_DIR, project, leaf.id, { executionMode: 'worktree' });
  const result = close(project, leaf.id, passedRows(leaf.id));
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'worktree_execution');
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('F1: live worktree record on the tree root blocks the leaf close', () => {
  const project = makeProject();
  const root = addTodo(ISOLATED_DATA_DIR, project, { title: 'Root', status: 'doing' }).item;
  const leaf = addTodo(ISOLATED_DATA_DIR, project, { title: 'Leaf', status: 'doing', parentId: root.id }).item;
  const items = loadTodosData(ISOLATED_DATA_DIR, project).items;
  const todo = items.find((r) => r.id === leaf.id);
  const rows = passedRows(leaf.id);
  const live = evaluateTodoLeafAutoClose({ todo, items, rows, isLiveWorktree: (id) => id === root.id });
  assert.equal(live.eligible, false);
  assert.equal(live.reason, 'worktree_execution');
  const none = evaluateTodoLeafAutoClose({ todo, items, rows, isLiveWorktree: () => false });
  assert.equal(none.eligible, true);
});

test('F5: auto-close appends a changelog note', () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  close(project, leaf.id, passedRows(leaf.id));
  const saved = loadTodosData(ISOLATED_DATA_DIR, project).items.find((r) => r.id === leaf.id);
  assert.ok(saved.changelog.some((e) => /Auto-closed/.test(e.text)));
});
