import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-persist.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-todos-cache-'));
const originalRead = fs.readFileSync;
let todoReads = 0;
fs.readFileSync = function readFileSyncCounting(target, ...args) {
  if (String(target).includes(`${path.sep}todos${path.sep}`)) todoReads += 1;
  return originalRead.call(this, target, ...args);
};

try {
  const created = addTodo(ISOLATED_DATA_DIR, cwd, { title: 'Cached leaf', status: 'ready' });
  todoReads = 0;
  const first = loadTodosData(ISOLATED_DATA_DIR, cwd);
  const second = loadTodosData(ISOLATED_DATA_DIR, cwd);
  assert.equal(first.items.length, 1);
  assert.equal(second.items[0].id, created.item.id);
  assert.equal(second.items[0].title, 'Cached leaf');
  assert.equal(todoReads, 1);
  first.items[0].title = 'mutated';
  assert.equal(loadTodosData(ISOLATED_DATA_DIR, cwd).items[0].title, 'Cached leaf');
  assert.equal(todoReads, 1);
  updateTodo(ISOLATED_DATA_DIR, cwd, created.item.id, { status: 'done' });
  todoReads = 0;
  const after = loadTodosData(ISOLATED_DATA_DIR, cwd);
  assert.equal(after.items[0].status, 'done');
  assert.equal(todoReads, 1);
  console.log('todos-persist-cache.test.js ok');
} finally {
  fs.readFileSync = originalRead;
  fs.rmSync(cwd, { recursive: true, force: true });
}
