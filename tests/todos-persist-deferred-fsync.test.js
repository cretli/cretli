import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { todosDocumentPath } from '../lib/persist/todos-persist.js';
import { getTodoMaterialStore, refHash } from '../lib/todo-material-store.js';
import {
  flushCoalescedWrites,
  flushDeferredFsyncs,
  getDeferredFsyncStatus,
  hasPendingDeferredFsync,
  scheduleDeferredFsync,
} from '../lib/persist/atomic-write.js';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cr-todos-dfs-'));
function workspace(name) {
  const dataDir = path.join(tmpRoot, name);
  const project = path.join(tmpRoot, `${name}-proj`);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { dataDir, project };
}

// Shutdown flush: a save leaves one debounced fsync owed; the flush performs it synchronously.
{
  const { dataDir, project } = workspace('flush');
  const todo = addTodo(dataDir, project, { title: 'a', status: 'ready' }).item;
  updateTodo(dataDir, project, todo.id, { body: 'x' });
  const file = todosDocumentPath(dataDir, project);
  assert.equal(hasPendingDeferredFsync(file), true);
  assert.deepEqual(flushDeferredFsyncs(), { synced: 1, failed: 0 });
  assert.equal(hasPendingDeferredFsync(file), false);
  updateTodo(dataDir, project, todo.id, { body: 'y' });
  assert.equal(hasPendingDeferredFsync(file), true);
  flushCoalescedWrites(); // the shutdown hook in server.js
  assert.equal(hasPendingDeferredFsync(file), false);
  console.log('OK: shutdown flush clears owed todo fsyncs');
}

// F1: an fsync already in flight (timer fired) is still owed to the shutdown flush.
{
  const file = path.join(tmpRoot, 'inflight.json');
  writeFileSync(file, '{}');
  const realOpen = fs.promises.open;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fs.promises.open = async (...args) => { await gate; return realOpen(...args); };
  try {
    scheduleDeferredFsync(file, 0);
    await new Promise((resolve) => setTimeout(resolve, 30)); // timer fired, async fsync is stuck on the gate
    assert.equal(hasPendingDeferredFsync(file), true, 'in-flight fsync must stay tracked');
    assert.deepEqual(flushDeferredFsyncs(), { synced: 1, failed: 0 });
    assert.equal(hasPendingDeferredFsync(file), false);
  } finally {
    release();
    fs.promises.open = realOpen;
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hasPendingDeferredFsync(file), false);
  console.log('OK: shutdown flush covers an in-flight async fsync');
}

// F2: a real fsync error (EIO) keeps the debt and is reported; ENOENT is not an error.
{
  const file = path.join(tmpRoot, 'eio.json');
  writeFileSync(file, '{}');
  const realOpenSync = fs.openSync;
  fs.openSync = (target, ...rest) => {
    if (path.resolve(String(target)) === file) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return realOpenSync(target, ...rest);
  };
  const realError = console.error;
  console.error = () => {};
  try {
    scheduleDeferredFsync(file, 60000);
    assert.deepEqual(flushDeferredFsyncs(), { synced: 0, failed: 1 });
    assert.equal(hasPendingDeferredFsync(file), true, 'failed fsync keeps the debt');
    assert.ok(getDeferredFsyncStatus().failures >= 1);
  } finally {
    fs.openSync = realOpenSync;
    console.error = realError;
  }
  assert.deepEqual(flushDeferredFsyncs(), { synced: 1, failed: 0 });
  scheduleDeferredFsync(path.join(tmpRoot, 'gone.json'), 60000);
  assert.deepEqual(flushDeferredFsyncs(), { synced: 1, failed: 0 }); // vanished file owes nothing
  console.log('OK: fsync errors keep the debt; ENOENT ignored');
}

// F5: SIGKILL inside a real write (after the temp file, before the rename) keeps the previous committed version.
for (const mode of ['mid-write', 'after-commit']) {
  const { dataDir, project } = workspace(`kill-${mode}`);
  const helper = fileURLToPath(new URL('./helpers/todos-kill-child.js', import.meta.url));
  const res = spawnSync(process.execPath, [helper, dataDir, project, mode], { env: { ...process.env, CRETLI_DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.equal(res.signal, 'SIGKILL', res.stderr);
  const file = todosDocumentPath(dataDir, project);
  const doc = loadTodosData(dataDir, project);
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].body, mode === 'mid-write' ? 'committed' : 'after-commit');
  if (mode === 'mid-write') assert.ok(readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp')), 'temp of the killed write is left behind');
  console.log(`OK: SIGKILL ${mode} keeps the last committed version`);
}

// F3/F4: material fast path.
{
  process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
  const { dataDir, project } = workspace('material');
  const material = { mode: 'worktree', baseCommit: 'a'.repeat(40), lastCheckpoint: { commit: 'b'.repeat(40) } };
  const store = getTodoMaterialStore(dataDir);
  const mk = (title) => {
    const t = addTodo(dataDir, project, { title, status: 'done' }).item;
    updateTodo(dataDir, project, t.id, { leafMaterial: { ...material, baseCommit: title.repeat(40).slice(0, 40) } });
    return t;
  };
  const one = mk('c');
  const two = mk('d');
  const file = todosDocumentPath(dataDir, project);
  const refs = () => JSON.parse(readFileSync(file, 'utf8')).items.map((i) => i.leafMaterial?.$ref);
  updateTodo(dataDir, project, one.id, { title: 'c2' }); // steady state: both refs known, nothing dropped
  assert.equal(hasPendingDeferredFsync(file), true, 'steady-state write uses the deferred fsync fast path');
  flushDeferredFsyncs();
  const hashOne = refHash({ $ref: refs()[0] });
  // F4: same-length garbage in the content file is repaired, not trusted.
  const contentFile = store.contentPath(hashOne);
  const original = readFileSync(contentFile);
  writeFileSync(contentFile, Buffer.alloc(original.length, 120));
  updateTodo(dataDir, project, one.id, { title: 'c3' });
  assert.deepEqual(readFileSync(contentFile), original, 'tampered content was republished');
  // F3: a write that drops a reference is durable before GC (no owed fsync, document already synced).
  flushDeferredFsyncs();
  updateTodo(dataDir, project, two.id, { status: 'ready', leafMaterial: null });
  assert.equal(hasPendingDeferredFsync(file), false, 'reference-dropping write is committed durably, not deferred');
  console.log('OK: material fast path (known refs, tamper repair, durable on reference drop)');
  delete process.env.CRETLI_TODO_MATERIAL_EXTERNAL;
}

// F3 (two processes): B durably adds material H, A (whose last write had no H) drops it; the predecessor is
// unknown to A, so the write must be durable (no owed fsync) before GC may delete H.
{
  process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
  const { dataDir, project } = workspace('twoproc');
  const a = addTodo(dataDir, project, { title: 'a', status: 'ready' }).item;
  updateTodo(dataDir, project, a.id, { body: 'steady' });
  flushDeferredFsyncs();
  const helper = fileURLToPath(new URL('./helpers/todos-material-child.js', import.meta.url));
  const res = spawnSync(process.execPath, [helper, dataDir, project], { env: { ...process.env, CRETLI_DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const bId = res.stdout.trim();
  const file = todosDocumentPath(dataDir, project);
  assert.equal(hasPendingDeferredFsync(file), false);
  updateTodo(dataDir, project, bId, { status: 'ready', leafMaterial: null }); // A drops B's reference
  assert.equal(hasPendingDeferredFsync(file), false, 'dropping a reference written by another process must be durable');
  updateTodo(dataDir, project, a.id, { body: 'again' }); // untouched since A's own write: fast path is back
  assert.equal(hasPendingDeferredFsync(file), true);
  flushDeferredFsyncs();
  console.log('OK: reference dropped after another process wrote it takes the durable path');
  delete process.env.CRETLI_TODO_MATERIAL_EXTERNAL;
}

// CAS still detects a stale revision.
{
  const { dataDir, project } = workspace('cas');
  const todo = addTodo(dataDir, project, { title: 'c', status: 'ready' }).item;
  const revision = loadTodosData(dataDir, project).items[0].updatedAt;
  updateTodo(dataDir, project, todo.id, { body: 'first', expectedUpdatedAt: revision });
  assert.throws(
    () => updateTodo(dataDir, project, todo.id, { body: 'second', expectedUpdatedAt: revision }),
    (e) => e.code === 'CONFLICT',
  );
  console.log('OK: stale expectedUpdatedAt still conflicts');
}

// Benchmark: 200 updates on a ~2.6 MB document keep the worst main-thread block under 500 ms.
{
  const { dataDir, project } = workspace('bench');
  const body = 'x'.repeat(30000);
  let first = null;
  for (let i = 0; i < 88; i += 1) {
    const t = addTodo(dataDir, project, { title: `t${i}`, body, status: 'ready' }).item;
    first = first || t;
  }
  const size = Buffer.byteLength(JSON.stringify(loadTodosData(dataDir, project)));
  assert.ok(size > 2.5e6, `fixture is ${size} bytes`);
  let max = 0;
  for (let i = 0; i < 200; i += 1) {
    const start = process.hrtime.bigint();
    updateTodo(dataDir, project, first.id, { body: `${body}${i}` });
    max = Math.max(max, Number(process.hrtime.bigint() - start) / 1e6);
  }
  console.log(`bench: max block ${max.toFixed(1)} ms over 200 updates (${(size / 1e6).toFixed(2)} MB)`);
  assert.ok(max < 500, `max block ${max} ms`);
  flushDeferredFsyncs();
  console.log('OK: 200-update benchmark under 500 ms');
}
