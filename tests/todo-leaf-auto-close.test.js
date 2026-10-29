/**
 * Flag-gated automatic leaf close after code review PASS (stage 4):
 * `evaluateTodoLeafAutoClose`, `closeTodoLeafIfEligible` and the sync hook.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTodo, closeTodoLeafIfEligible, loadTodosData, updateTodo } from '../lib/persist/todos-persist.js';
import { worktreeRegistryPath, writeWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { buildLiveWorktreePredicate } from '../lib/todo-worktree-manual.js';
import { evaluateTodoLeafAutoClose, isTodoLeafAutoCloseEnabled } from '../lib/todo-review-sync.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
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
    executor: { transport: 'testfake', model: assignment === 'review' ? 'testfakeb-chat' : 'gpt-5' },
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

async function close(project, leafId, rows) {
  return (await closeTodoLeafAfterReview({
    dataDir: ISOLATED_DATA_DIR, workspaceFolder: project, todoId: leafId, rows,
  }));
}

test('AC1: doing -> done when review passed and nothing blocks', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const result = (await close(project, leaf.id, passedRows(leaf.id)));
  assert.equal(result.closed, true);
  assert.equal(statusOf(project, leaf.id), 'done');
});

test('AC1: integration.ready leaf is not closed', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  updateTodo(ISOLATED_DATA_DIR, project, leaf.id, { integration: { state: 'ready' } });
  const result = (await close(project, leaf.id, passedRows(leaf.id)));
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'awaiting_integration');
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('AC2: implement/fix queued after the review blocks the close', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = [
    ...passedRows(leaf.id),
    row(leaf.id, 'implement', { pickRole: 'fix', queuedAt: t(5), status: 'queued', startedAt: '', finishedAt: '' }),
  ];
  assert.equal((await close(project, leaf.id, rows)).closed, false);
  // Even a completed fix queued after the review makes the review stale.
  const stale = [...passedRows(leaf.id), row(leaf.id, 'implement', { pickRole: 'fix', queuedAt: t(5) })];
  const result = (await close(project, leaf.id, stale));
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'review_stale');
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('AC3: two close attempts produce exactly one transition', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = passedRows(leaf.id);
  const results = [(await close(project, leaf.id, rows)), (await close(project, leaf.id, rows))];
  assert.equal(results.filter((r) => r.closed).length, 1);
  assert.equal(results[1].reason, 'not_doing');
});

test('AC4: flag off changes nothing through the sync hook', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  assert.equal(isTodoLeafAutoCloseEnabled({}), false);
  const deps = { rows: passedRows(leaf.id) };
  (await syncTodoReviewTarget(
    { workspaceFolder: project, todoId: leaf.id, dataDir: ISOLATED_DATA_DIR },
    { env: {}, deps },
  ));
  assert.equal(statusOf(project, leaf.id), 'doing');
  const on = { CRETLI_TODO_LEAF_AUTO_CLOSE: '1' };
  assert.equal(isTodoLeafAutoCloseEnabled(on), true);
  (await syncTodoReviewTarget(
    { workspaceFolder: project, todoId: leaf.id, dataDir: ISOLATED_DATA_DIR },
    { env: on, deps },
  ));
  assert.equal(statusOf(project, leaf.id), 'done');
});

test('AC5: a plan-review PASS never closes a leaf', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = [row(leaf.id, 'review', { reviewSubject: 'plan' })];
  const result = (await close(project, leaf.id, rows));
  assert.equal(result.closed, false);
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('cancel_unconfirmed slot blocks the close', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = [
    ...passedRows(leaf.id),
    row(leaf.id, 'implement', { queuedAt: t(0), slotHeldBy: 'cancel_unconfirmed', status: 'interrupted' }),
  ];
  const result = (await close(project, leaf.id, rows));
  assert.equal(result.reason, 'cancel_unconfirmed');
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('failed, unknown and verify-missing reviews do not close', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const impl = row(leaf.id, 'implement', { queuedAt: t(1) });
  const cases = [
    row(leaf.id, 'review', { queuedAt: t(3), reportVerdict: 'FAIL', report: 'VERDICT: FAIL' }),
    row(leaf.id, 'review', { queuedAt: t(3), verifyRequired: true, reviewCanRunTests: false }),
  ];
  for (const review of cases) {
    assert.equal((await close(project, leaf.id, [impl, review])).closed, false);
  }
  assert.equal((await close(project, leaf.id, [])).closed, false);
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

test('F1: worktree-mode leaf with PASS and no integration object is not closed', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  updateTodo(ISOLATED_DATA_DIR, project, leaf.id, { executionMode: 'worktree' });
  const result = (await close(project, leaf.id, passedRows(leaf.id)));
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

test('F5: auto-close appends a changelog note', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  (await close(project, leaf.id, passedRows(leaf.id)));
  const saved = loadTodosData(ISOLATED_DATA_DIR, project).items.find((r) => r.id === leaf.id);
  assert.ok(saved.changelog.some((e) => /Auto-closed/.test(e.text)));
});

const REGISTRY_OPTIONS = { dataDir: ISOLATED_DATA_DIR };

async function withRegistry(items, work) {
  const file = worktreeRegistryPath(REGISTRY_OPTIONS);
  try {
    if (typeof items === 'string') fs.writeFileSync(file, items);
    else writeWorktreeRegistry({ items }, REGISTRY_OPTIONS);
    return await work();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function worktreeRecord(todoId, extra = {}) {
  return {
    todoId,
    workspaceFolder: '/tmp/ws',
    worktreePath: `/tmp/wt-${todoId}`,
    branch: `cretli/todo/${todoId}`,
    baseCommit: 'abc123',
    ...extra,
  };
}

test('T1: unreadable worktree registry refuses the close', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  (await withRegistry('{ not json', async () => {
    const result = (await close(project, leaf.id, passedRows(leaf.id)));
    assert.equal(result.closed, false);
    assert.equal(result.reason, 'worktree_registry_unreadable');
    assert.equal(buildLiveWorktreePredicate(ISOLATED_DATA_DIR)(leaf.id), false);
    assert.throws(() => buildLiveWorktreePredicate(ISOLATED_DATA_DIR, { strict: true }));
  }));
  assert.equal(statusOf(project, leaf.id), 'doing');
});

test('T2: live registry record on the root blocks a child leaf', async () => {
  const project = makeProject();
  const root = addTodo(ISOLATED_DATA_DIR, project, { title: 'Root', status: 'doing' }).item;
  const leaf = addTodo(ISOLATED_DATA_DIR, project, { title: 'Leaf', status: 'doing', parentId: root.id }).item;
  (await withRegistry({ [root.id]: worktreeRecord(root.id) }, async () => {
    const result = (await close(project, leaf.id, passedRows(leaf.id)));
    assert.equal(result.closed, false);
    assert.equal(result.reason, 'worktree_execution');
  }));
});

test('T3: live registry record on the leaf itself blocks the close', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  (await withRegistry({ [leaf.id]: worktreeRecord(leaf.id) }, async () => {
    const result = (await close(project, leaf.id, passedRows(leaf.id)));
    assert.equal(result.closed, false);
    assert.equal(result.reason, 'worktree_execution');
  }));
});

test('T4: cleaned or released record does not block the close', async () => {
  for (const extra of [{ cleanedAt: t(5) }, { releasedAt: t(5) }]) {
    const project = makeProject();
    const leaf = makeLeaf(project);
    (await withRegistry({ [leaf.id]: worktreeRecord(leaf.id, extra) }, async () => {
      assert.equal((await close(project, leaf.id, passedRows(leaf.id))).closed, true);
    }));
  }
});

test('T5: error after the save reports closed, error before it does not', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const after = (await closeTodoLeafAfterReview({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    todoId: leaf.id,
    rows: passedRows(leaf.id),
    deps: {
      closeLeaf: (...args) => {
        closeTodoLeafIfEligible(...args);
        throw new Error('boom');
      },
    },
  }));
  assert.deepEqual(after, { closed: true, reason: 'error_after_close' });
  assert.equal(statusOf(project, leaf.id), 'done');
  const other = makeLeaf(project);
  const before = (await closeTodoLeafAfterReview({
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: project,
    todoId: other.id,
    rows: passedRows(other.id),
    deps: { closeLeaf: () => { throw new Error('boom'); } },
  }));
  assert.deepEqual(before, { closed: false, reason: 'error' });
  assert.equal(statusOf(project, other.id), 'doing');
});

test('T6: auto-close clears the claim fields', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  updateTodo(ISOLATED_DATA_DIR, project, leaf.id, {
    claimedByChatId: 'chat-1',
    claimedAt: t(2),
    claimLeaseUntil: t(30),
  });
  assert.equal((await close(project, leaf.id, passedRows(leaf.id))).closed, true);
  const saved = loadTodosData(ISOLATED_DATA_DIR, project).items.find((r) => r.id === leaf.id);
  assert.equal(saved.claimedByChatId, undefined);
  assert.equal(saved.claimedAt, undefined);
  assert.equal(saved.claimLeaseUntil, undefined);
});

test('T7: concurrent async closes in the same process close exactly once', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  const rows = passedRows(leaf.id);
  const results = await Promise.all([close(project, leaf.id, rows), close(project, leaf.id, rows)]);
  assert.equal(results.filter((r) => r.closed).length, 1);
  assert.equal(statusOf(project, leaf.id), 'done');
});

function runChild(project, leafId, rows, startAt) {
  const script = fileURLToPath(new URL('./helpers/auto-close-child.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        AC_PROJECT: project,
        AC_LEAF: leafId,
        AC_ROWS: JSON.stringify(rows),
        AC_START_AT: String(startAt),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

test('T8: concurrent processes produce exactly one transition', async () => {
  for (let round = 0; round < 5; round += 1) {
    const project = makeProject();
    const leaf = makeLeaf(project);
    const rows = passedRows(leaf.id);
    const startAt = Date.now() + 1500;
    const results = await Promise.all([
      runChild(project, leaf.id, rows, startAt),
      runChild(project, leaf.id, rows, startAt),
      runChild(project, leaf.id, rows, startAt),
    ]);
    assert.equal(results.filter((r) => r.closed === true).length, 1, JSON.stringify(results));
    for (const r of results.filter((x) => !x.closed)) assert.equal(r.reason, 'not_doing');
    const saved = loadTodosData(ISOLATED_DATA_DIR, project).items.find((r) => r.id === leaf.id);
    assert.equal(saved.status, 'done');
    assert.equal(saved.changelog.filter((e) => /Auto-closed/.test(e.text)).length, 1);
  }
});

test('FU-1: live fixed_pair policy holds an all-legacy round open in the hook', async () => {
  const project = makeProject();
  const leaf = makeLeaf(project);
  saveDelegationSettings(project, {
    reviewer_policy: { code: { selection: 'fixed_pair', members_source: 'learned', session: 'fresh' } },
  }, { dataDir: ISOLATED_DATA_DIR });
  try {
    const result = (await close(project, leaf.id, passedRows(leaf.id)));
    assert.equal(result.closed, false);
    assert.equal(result.reason, 'review_pending');
    assert.equal(statusOf(project, leaf.id), 'doing');
  } finally {
    saveDelegationSettings(project, { reviewer_policy: null }, { dataDir: ISOLATED_DATA_DIR });
  }
});
