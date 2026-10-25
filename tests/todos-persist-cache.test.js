import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addTodo, isTodosDocCurrent, loadTodosData, todosDocumentPath, updateTodo } from '../lib/persist/todos-persist.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-todos-cache-'));
const originalRead = fs.readFileSync;
let todoReads = 0;
fs.readFileSync = function readFileSyncCounting(target, ...args) {
  if (String(target).includes(`${path.sep}todos${path.sep}`)) todoReads += 1;
  return originalRead.call(this, target, ...args);
};

try {
  const created = addTodo(ISOLATED_DATA_DIR, cwd, { title: 'Cached leaf', status: 'ready' });
  // A save primes the cache with the written document: no re-parse afterwards.
  todoReads = 0;
  const first = loadTodosData(ISOLATED_DATA_DIR, cwd);
  const second = loadTodosData(ISOLATED_DATA_DIR, cwd);
  assert.equal(first.items.length, 1);
  assert.equal(second.items[0].id, created.item.id);
  assert.equal(second.items[0].title, 'Cached leaf');
  assert.equal(todoReads, 0);
  first.items[0].title = 'mutated';
  assert.equal(loadTodosData(ISOLATED_DATA_DIR, cwd).items[0].title, 'Cached leaf');
  assert.equal(todoReads, 0);
  const saved = updateTodo(ISOLATED_DATA_DIR, cwd, created.item.id, { title: 'Renamed leaf' });
  assert.equal(isTodosDocCurrent(ISOLATED_DATA_DIR, cwd, saved), true, 'saved doc is current right after the write');
  assert.equal(loadTodosData(ISOLATED_DATA_DIR, cwd).items[0].title, 'Renamed leaf');
  assert.equal(todoReads, 0);
  // An outside write (another process) changes the file signature: one real read,
  // and a document returned by an earlier save is no longer current.
  const file = todosDocumentPath(ISOLATED_DATA_DIR, cwd);
  const onDisk = JSON.parse(originalRead.call(fs, file, 'utf8'));
  onDisk.items[0].title = 'Edited elsewhere';
  fs.writeFileSync(file, JSON.stringify(onDisk));
  assert.equal(isTodosDocCurrent(ISOLATED_DATA_DIR, cwd, saved), false);
  todoReads = 0;
  assert.equal(loadTodosData(ISOLATED_DATA_DIR, cwd).items[0].title, 'Edited elsewhere');
  assert.equal(todoReads, 1);
  // The primed cache must equal a cold parse of the same file.
  updateTodo(ISOLATED_DATA_DIR, cwd, created.item.id, { status: 'doing', body: 'text', plan: { markdown: '# p' } });
  const primed = loadTodosData(ISOLATED_DATA_DIR, cwd);
  fs.writeFileSync(file, originalRead.call(fs, file, 'utf8')); // new mtime -> cold parse
  assert.deepEqual(primed.items, loadTodosData(ISOLATED_DATA_DIR, cwd).items);
  console.log('todos-persist-cache.test.js ok');
} finally {
  fs.readFileSync = originalRead;
  fs.rmSync(cwd, { recursive: true, force: true });
}
