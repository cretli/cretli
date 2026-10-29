import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addTodo,
  getTodoById,
  todosDocumentPath,
  commitWatcherTodoCommand,
} from '../lib/persist/todos-persist.js';
import { createTodosStore } from '../lib/persist/todos-store.js';
import {
  upsertWorkspaceWatcher,
  getWorkspaceWatcher,
  withWorkspaceWatchersFileLock,
  WorkspaceWatchersLockAsyncCallbackError,
  loadWorkspaceWatchersDocument,
} from '../lib/persist/workspace-watchers-persist.js';

let sequence = 0;
function fixture() {
  const cwd = `/example/l3d0-${++sequence}`;
  const todo = addTodo(ISOLATED_DATA_DIR, cwd, { title: 'Leaf', status: 'ready' }).item;
  const row = upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir: ISOLATED_DATA_DIR });
  return { cwd, todo, row, revision: currentRevision() };
}

const currentRevision = () => loadWorkspaceWatchersDocument({ dataDir: ISOLATED_DATA_DIR }).revision;

function command(f, overrides = {}) {
  return {
    todoId: f.todo.id,
    expectedTodoUpdatedAt: f.todo.updatedAt,
    expectedWatcherUpdatedAt: f.row.updatedAt,
    expectedWatcherRevision: f.revision,
    decide: () => ({ todoPatch: { status: 'doing' }, watcherPatch: { mode: 'autopilot' } }),
    ...overrides,
  };
}

test('command commits todo and watcher row together', () => {
  const f = fixture();
  const result = commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f));
  assert.equal(result.ok, true);
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'doing');
  assert.equal(getWorkspaceWatcher(f.cwd, { dataDir: ISOLATED_DATA_DIR }).mode, 'autopilot');
});

test('stale todo version rejects without writing either side', () => {
  const f = fixture();
  const result = commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, { expectedTodoUpdatedAt: '2000-01-01T00:00:00.000Z' }));
  assert.deepEqual(result, { ok: false, reason: 'todo_conflict' });
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'ready');
  assert.equal(getWorkspaceWatcher(f.cwd, { dataDir: ISOLATED_DATA_DIR }).mode, 'observe');
});

test('command without expectedWatcherRevision is rejected before any write', () => {
  const f = fixture();
  for (const bad of [undefined, null, '1', 1.5, -1]) {
    assert.throws(
      () => commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, { expectedWatcherRevision: bad })),
      (err) => err.code === 'WATCHER_REVISION_REQUIRED',
    );
  }
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'ready');
  assert.equal(getWorkspaceWatcher(f.cwd, { dataDir: ISOLATED_DATA_DIR }).mode, 'observe');
});

test('stale watcher revision rejects with an IDENTICAL updatedAt and writes neither side', (t) => {
  const f = fixture();
  const stale = f.revision;
  // Freeze the clock so the next watcher write reuses the exact same updatedAt.
  const frozen = new Date(f.row.updatedAt).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: frozen });
  const newer = upsertWorkspaceWatcher(f.cwd, { paused: true }, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(newer.updatedAt, f.row.updatedAt, 'precondition: updatedAt collides');
  assert.equal(currentRevision(), stale + 1);
  const result = commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, {
    expectedWatcherUpdatedAt: newer.updatedAt,
    expectedWatcherRevision: stale,
  }));
  assert.deepEqual(result, { ok: false, reason: 'watcher_conflict' });
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'ready');
  const row = getWorkspaceWatcher(f.cwd, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(row.mode, 'observe');
  assert.equal(currentRevision(), stale + 1);
  // The fresh revision is accepted.
  const ok = commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, {
    expectedWatcherUpdatedAt: newer.updatedAt,
    expectedWatcherRevision: currentRevision(),
  }));
  assert.equal(ok.ok, true);
});

test('fence rejection and skipped decision write nothing', () => {
  const f = fixture();
  assert.deepEqual(
    commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, { fence: () => false })),
    { ok: false, reason: 'fenced' },
  );
  assert.deepEqual(
    commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, { decide: () => false })),
    { ok: false, reason: 'skipped' },
  );
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'ready');
});

test('an error between the todo and watcher writes rolls the todo back byte-for-byte', () => {
  const f = fixture();
  const file = todosDocumentPath(ISOLATED_DATA_DIR, f.cwd);
  const before = fs.readFileSync(file);
  assert.throws(
    () => commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, {
      beforeWatcherWrite: () => { throw new Error('injected'); },
    })),
    /injected/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'ready');
  assert.equal(getWorkspaceWatcher(f.cwd, { dataDir: ISOLATED_DATA_DIR }).mode, 'observe');
});

test('invalid todo patch throws before any watcher write', () => {
  const f = fixture();
  assert.throws(() => commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, {
    decide: () => ({ todoPatch: { parentId: 'missing-parent-id' }, watcherPatch: { mode: 'autopilot' } }),
  })));
  assert.equal(getWorkspaceWatcher(f.cwd, { dataDir: ISOLATED_DATA_DIR }).mode, 'observe');
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'ready');
});

test('facade exposes the command and resolves with the sync result', async () => {
  const f = fixture();
  const result = await createTodosStore().commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f));
  assert.equal(result.ok, true);
});

test('lock guard rejects a callback that awaits the async facade', async () => {
  const f = fixture();
  const store = createTodosStore();
  assert.throws(
    () => withWorkspaceWatchersFileLock(async () => {
      await store.getTodo(ISOLATED_DATA_DIR, f.cwd, f.todo.id);
    }, { dataDir: ISOLATED_DATA_DIR }),
    WorkspaceWatchersLockAsyncCallbackError,
  );
  // The lock was released: a following synchronous section still works (also nested).
  assert.equal(withWorkspaceWatchersFileLock(() => withWorkspaceWatchersFileLock(() => 7, { dataDir: ISOLATED_DATA_DIR }), { dataDir: ISOLATED_DATA_DIR }), 7);
  assert.throws(
    () => withWorkspaceWatchersFileLock(() => withWorkspaceWatchersFileLock(async () => {}, { dataDir: ISOLATED_DATA_DIR }), { dataDir: ISOLATED_DATA_DIR }),
    WorkspaceWatchersLockAsyncCallbackError,
  );
});

function crashChild(f, point) {
  const todo = getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id);
  return spawnSync(process.execPath, [
    fileURLToPath(new URL('./helpers/watcher-todo-crash-child.mjs', import.meta.url)),
    ISOLATED_DATA_DIR, f.cwd, f.todo.id, todo.updatedAt, f.row.updatedAt, String(f.revision), point,
  ], { env: { ...process.env, CRETLI_DATA_DIR: ISOLATED_DATA_DIR }, encoding: 'utf8' });
}

const journalFile = () => path.join(ISOLATED_DATA_DIR, 'watcher-todo-command.journal.json');

test('SIGKILL between the todo and watcher writes is rolled back by the next writer', () => {
  const f = fixture();
  const child = crashChild(f, 'between');
  assert.equal(child.signal, 'SIGKILL');
  assert.ok(fs.existsSync(journalFile()), 'journal survives the crash');
  // The raw file shows the partial state until some lock holder recovers it.
  assert.equal(JSON.parse(fs.readFileSync(todosDocumentPath(ISOLATED_DATA_DIR, f.cwd), 'utf8')).items[0].status, 'doing');
  // An unrelated watcher write is enough: recovery runs on lock acquisition.
  upsertWorkspaceWatcher(f.cwd, { paused: false }, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'ready');
  assert.equal(getWorkspaceWatcher(f.cwd, { dataDir: ISOLATED_DATA_DIR }).mode, 'observe');
  assert.equal(fs.existsSync(journalFile()), false);
});

test('SIGKILL after the watcher commit rolls forward and keeps both writes', () => {
  const f = fixture();
  const child = crashChild(f, 'after');
  assert.equal(child.signal, 'SIGKILL');
  assert.ok(fs.existsSync(journalFile()));
  // A todo-side writer also triggers recovery.
  addTodo(ISOLATED_DATA_DIR, f.cwd, { title: 'Other' });
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'doing');
  assert.equal(getWorkspaceWatcher(f.cwd, { dataDir: ISOLATED_DATA_DIR }).mode, 'autopilot');
  assert.equal(fs.existsSync(journalFile()), false);
});

test('after crash recovery a stale-version command is still rejected (CAS and fence intact)', () => {
  const f = fixture();
  crashChild(f, 'between');
  const stale = commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, { expectedTodoUpdatedAt: 'stale' }));
  assert.deepEqual(stale, { ok: false, reason: 'todo_conflict' });
  assert.equal(fs.existsSync(journalFile()), false, 'recovery ran before the CAS check');
  const fenced = commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f, { fence: () => false }));
  assert.deepEqual(fenced, { ok: false, reason: 'fenced' });
  assert.equal(getTodoById(ISOLATED_DATA_DIR, f.cwd, f.todo.id).status, 'ready');
  // The original expectations are still valid after the rollback.
  assert.equal(commitWatcherTodoCommand(ISOLATED_DATA_DIR, f.cwd, command(f)).ok, true);
});

test('a corrupt journal fails closed instead of guessing', () => {
  const f = fixture();
  fs.writeFileSync(journalFile(), '{not json');
  assert.throws(
    () => upsertWorkspaceWatcher(f.cwd, { paused: true }, { dataDir: ISOLATED_DATA_DIR }),
    (error) => error.code === 'WATCHER_TODO_JOURNAL_CORRUPT',
  );
  fs.rmSync(journalFile());
});
