/**
 * Per-todo execution mode override and watcher policy normalization.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addTodo, getTodoById, loadTodosData, updateTodo, workspaceKeyFromCwd } from '../lib/persist/todos-persist.js';
import {
  defaultWorkspaceWatcherPolicy,
  normalizeWorkspaceWatcherPolicy,
} from '../lib/persist/workspace-watchers-persist.js';
import { tempDir } from './helpers/temp-git-repo.js';

test('watcher policy defaults to project and ships an empty worktree layout', () => {
  const policy = defaultWorkspaceWatcherPolicy();
  assert.equal(policy.executionMode, 'project');
  assert.deepEqual(policy.worktree, {
    root: '',
    namespace: '',
    branchPrefix: '',
    directoryPrefix: '',
    prepareCommand: [],
  });
});

test('watcher policy normalization keeps a worktree layout and rejects an unknown mode', () => {
  const worktree = normalizeWorkspaceWatcherPolicy({
    executionMode: 'worktree',
    worktree: {
      root: '/tmp/worktrees',
      namespace: 'ws',
      branchPrefix: 'cretli/todo/',
      directoryPrefix: 't-',
      prepareCommand: ['npm', 'ci'],
    },
  });
  assert.equal(worktree.executionMode, 'worktree');
  assert.equal(worktree.worktree.root, '/tmp/worktrees');
  assert.equal(worktree.worktree.namespace, 'ws');
  assert.deepEqual(worktree.worktree.prepareCommand, ['npm', 'ci']);
  // Anything that is not exactly `worktree` degrades to the compatibility default.
  assert.equal(normalizeWorkspaceWatcherPolicy({ executionMode: 'elsewhere' }).executionMode, 'project');
  assert.equal(normalizeWorkspaceWatcherPolicy({}).executionMode, 'project');
});

test('todo executionMode persists, updates and clears', (t) => {
  const dataDir = tempDir('cretli-todo-mode-data-');
  const cwd = tempDir('cretli-todo-mode-ws-');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const created = addTodo(dataDir, cwd, { title: 'worktree leaf', status: 'ready', executionMode: 'worktree' }).item;
  assert.equal(created.executionMode, 'worktree');
  assert.equal(getTodoById(dataDir, cwd, created.id).executionMode, 'worktree');

  const toProject = updateTodo(dataDir, cwd, created.id, { executionMode: 'project' });
  const projectRow = toProject.items.find((row) => row.id === created.id);
  assert.equal(projectRow.executionMode, 'project');

  const toInherit = updateTodo(dataDir, cwd, created.id, { executionMode: 'inherit' });
  const inheritRow = toInherit.items.find((row) => row.id === created.id);
  assert.equal(inheritRow.executionMode, undefined, 'inherit is stored as no override');

  updateTodo(dataDir, cwd, created.id, { executionMode: 'worktree' });
  const cleared = updateTodo(dataDir, cwd, created.id, { executionMode: null });
  assert.equal(cleared.items.find((row) => row.id === created.id).executionMode, undefined);

  const loaded = loadTodosData(dataDir, cwd).items.find((row) => row.id === created.id);
  assert.equal(loaded.executionMode, undefined);
});

test('an invalid todo executionMode is rejected on create and update', (t) => {
  const dataDir = tempDir('cretli-todo-mode-invalid-data-');
  const cwd = tempDir('cretli-todo-mode-invalid-ws-');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  assert.throws(
    () => addTodo(dataDir, cwd, { title: 'bad', status: 'ready', executionMode: 'vm' }),
    (error) => error.code === 'VALIDATION',
  );
  const item = addTodo(dataDir, cwd, { title: 'ok', status: 'ready' }).item;
  assert.throws(
    () => updateTodo(dataDir, cwd, item.id, { executionMode: 'vm' }),
    (error) => error.code === 'VALIDATION',
  );
});

test('an unknown stored executionMode is dropped on load', (t) => {
  const dataDir = tempDir('cretli-todo-mode-load-data-');
  const cwd = tempDir('cretli-todo-mode-load-ws-');
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const item = addTodo(dataDir, cwd, { title: 'stored', status: 'ready' }).item;
  assert.equal(item.executionMode, undefined);

  // Corrupt the stored value directly; load must not surface it.
  const filePath = path.join(dataDir, 'todos', `${workspaceKeyFromCwd(cwd)}.json`);
  assert.equal(fs.existsSync(filePath), true);
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  doc.items = doc.items.map((row) => (row.id === item.id ? { ...row, executionMode: 'vm' } : row));
  fs.writeFileSync(filePath, JSON.stringify(doc));
  assert.equal(getTodoById(dataDir, cwd, item.id).executionMode, undefined);
});
