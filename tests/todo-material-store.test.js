import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import {
  addTodo, loadTodosData, updateTodo, workspaceKeyFromCwd,
} from '../lib/persist/todos-legacy-adapter.js';
import {
  createTodoMaterialStore, collectLiveHashes, getTodoMaterialStore, isTodoMaterialRef, refHash,
  registerTodoMaterialStore, resetTodoMaterialStores, sha256Hex, verifyReferenceClosure,
} from '../lib/todo-material-store.js';
import { applyExternalization, main as cliMain, planExternalization } from '../scripts/externalize-todo-material.js';

const MATERIAL = Object.freeze({
  mode: 'project',
  baseCapturedAt: '2026-01-01T00:00:00.000Z',
  baseManifest: { 'a.js': 'h1', 'b.js': 'h2' },
});

let dataDir = '';
let cwd = '';
let clock = Date.now();
const now = () => clock;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-material-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-material-ws-'));
  clock = Date.now();
  resetTodoMaterialStores();
  delete process.env.CRETLI_TODO_MATERIAL_EXTERNAL;
});
afterEach(() => {
  delete process.env.CRETLI_TODO_MATERIAL_EXTERNAL;
  resetTodoMaterialStores();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const docFile = () => path.join(dataDir, 'todos', `${workspaceKeyFromCwd(cwd)}.json`);
const mk = (hooks) => createTodoMaterialStore({ dataDir, now, hooks });

/** Create a done todo carrying material through the real save path. */
function makeDoneTodo(material = MATERIAL) {
  const created = addTodo(dataDir, cwd, { title: 'leaf', idempotencyKey: `k-${Math.random()}` });
  const id = (created.item || created.todo || created.doc.items.at(-1)).id;
  updateTodo(dataDir, cwd, id, { leafMaterial: material });
  updateTodo(dataDir, cwd, id, { status: 'done' });
  return id;
}

describe('todo-material-store', () => {
  test('publish/read round trip and ref shape', () => {
    const store = mk();
    const ref = store.publish(MATERIAL);
    assert.ok(isTodoMaterialRef(ref));
    assert.equal(ref.bytes, Buffer.byteLength(JSON.stringify(MATERIAL)));
    assert.deepEqual(store.read(ref), MATERIAL);
    assert.ok(fs.existsSync(path.join(store.root, refHash(ref).slice(0, 2), refHash(ref))));
    store.consumePin(ref);
    assert.equal(store.listPins().length, 0);
  });

  test('read detects corruption and missing files', () => {
    const store = mk();
    const ref = store.publish(MATERIAL);
    fs.writeFileSync(store.contentPath(refHash(ref)), '{"mode":"x"}');
    assert.throws(() => store.read(ref), { code: 'TODO_MATERIAL_CORRUPT' });
    fs.unlinkSync(store.contentPath(refHash(ref)));
    assert.throws(() => store.read(ref), { code: 'TODO_MATERIAL_MISSING' });
  });

  test('pin exists before the content (crash after pin leaves a pin and no content)', () => {
    const store = mk({ step(name) { if (name === 'pin-synced') throw new Error('crash'); } });
    assert.throws(() => store.publish(MATERIAL), /crash/);
    assert.equal(store.listPins().length, 1);
    assert.equal(store.listContent().length, 0);
  });

  for (const stepName of ['temp-written', 'renamed', 'dir-synced']) {
    test(`crash after ${stepName}: no reference committed, recovery and GC collect everything`, () => {
      const crashing = mk({ step(name) { if (name === stepName) throw new Error('crash'); } });
      assert.throws(() => crashing.publish(MATERIAL), /crash/);
      // A restarted process (new epoch) sees an unreferenced pin and maybe content.
      clock += 11 * 60 * 1000;
      const fresh = mk();
      const rec = fresh.recover({ liveRefs: new Set() });
      assert.equal(rec.removedPins.length, 1);
      clock += 25 * 3600 * 1000;
      fresh.recover();
      fresh.gc({ liveRefs: new Set(), now: clock });
      for (const e of fresh.listContent()) assert.fail(`leftover ${e.file}`);
    });
  }

  test('crash after reference commit before consume keeps the content (referenced)', () => {
    const store = mk();
    const ref = store.publish(MATERIAL); // "committed" in a document, but consume never ran
    clock += 11 * 60 * 1000;
    const fresh = mk();
    fresh.recover();
    clock += 48 * 3600 * 1000;
    const out = fresh.gc({ liveRefs: new Set([refHash(ref)]), now: clock });
    assert.deepEqual(out.deleted, []);
    assert.deepEqual(fresh.read(ref), MATERIAL);
  });

  test('expired pin: writer cannot commit or consume', () => {
    const store = mk();
    const ref = store.publish(MATERIAL);
    clock += 11 * 60 * 1000;
    assert.throws(() => store.assertPublished(ref), { code: 'TODO_MATERIAL_PIN_LOST' });
    assert.throws(() => store.consumePin(ref), { code: 'TODO_MATERIAL_PIN_LOST' });
    // Recovery removes the expired pin; the writer republishes with a fresh one.
    store.recover();
    const again = store.publish(MATERIAL);
    store.assertPublished(again);
    store.consumePin(again);
  });

  test('GC refuses live pins, referenced and young files; deletes the rest', () => {
    const store = mk();
    const pinned = store.publish({ ...MATERIAL, n: 1 });
    const referenced = store.publish({ ...MATERIAL, n: 2 });
    const doomed = store.publish({ ...MATERIAL, n: 3 });
    store.consumePin(referenced);
    store.consumePin(doomed);
    const mtime = new Date(clock);
    for (const e of store.listContent()) fs.utimesSync(e.file, mtime, mtime);
    // Young: everything is protected.
    let out = store.gc({ liveRefs: new Set([refHash(referenced)]), now: clock + 1000 });
    assert.deepEqual(out.deleted, []);
    assert.ok(out.skipped.some((s) => s.reason === 'young'));
    // Old, but the first is pinned and the second is referenced.
    clock += 25 * 3600 * 1000;
    // The pin lease (10 min) expired too, so renew it by republishing.
    const renewed = store.publish({ ...MATERIAL, n: 1 });
    assert.equal(renewed.$ref, pinned.$ref);
    out = store.gc({ liveRefs: new Set([refHash(referenced)]), now: clock });
    assert.deepEqual(out.deleted, [refHash(doomed)]);
    assert.ok(out.skipped.some((s) => s.hash === refHash(pinned) && s.reason === 'pinned'));
    assert.ok(out.skipped.some((s) => s.hash === refHash(referenced) && s.reason === 'referenced'));
  });

  test('GC rolls the deleting mark back when a reference appears', () => {
    const store = mk();
    const ref = store.publish(MATERIAL);
    store.consumePin(ref);
    clock += 25 * 3600 * 1000;
    let calls = 0;
    const out = store.gc({ liveRefs: () => (++calls >= 3 ? new Set([refHash(ref)]) : new Set()), now: clock, graceMs: 0 });
    assert.deepEqual(out.deleted, []);
    assert.equal(out.skipped[0].reason, 'appeared');
    assert.deepEqual(store.read(ref), MATERIAL);
  });

  test('publish puts a crashed GC\'s .deleting leftover back under the lock instead of waiting', () => {
    const store = mk();
    const ref = store.publish(MATERIAL);
    store.consumePin(ref);
    const hash = refHash(ref);
    fs.renameSync(store.contentPath(hash), `${store.contentPath(hash)}.deleting`);
    const again = store.publish(MATERIAL);
    assert.deepEqual(store.read(again), MATERIAL);
    assert.equal(fs.existsSync(`${store.contentPath(hash)}.deleting`), false);
  });

  test('recover restores an interrupted GC mark that is referenced and removes an unreferenced one', () => {
    const store = mk();
    const keep = store.publish({ ...MATERIAL, n: 1 });
    const drop = store.publish({ ...MATERIAL, n: 2 });
    store.consumePin(keep); store.consumePin(drop);
    for (const ref of [keep, drop]) fs.renameSync(store.contentPath(refHash(ref)), `${store.contentPath(refHash(ref))}.deleting`);
    const rec = store.recover({ liveRefs: new Set([refHash(keep)]) });
    assert.deepEqual(rec.restored, [refHash(keep)]);
    assert.deepEqual(rec.removedDeleting, [refHash(drop)]);
    assert.deepEqual(store.read(keep), { ...MATERIAL, n: 1 });
  });
});

describe('todos persist with external material', () => {
  test('flag off: document is inline and unchanged', () => {
    const id = makeDoneTodo();
    const raw = JSON.parse(fs.readFileSync(docFile(), 'utf8'));
    assert.deepEqual(raw.items.find((i) => i.id === id).leafMaterial, MATERIAL);
    assert.equal(fs.existsSync(path.join(dataDir, 'todo-material')), false);
  });

  test('flag on: done material becomes a reference, document shrinks, load round-trips', () => {
    const id = makeDoneTodo({ ...MATERIAL, baseManifest: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}.js`, `hash${i}`])) });
    const inlineSize = fs.statSync(docFile()).size;
    process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
    const doc = loadTodosData(dataDir, cwd);
    updateTodo(dataDir, cwd, id, { title: 'leaf renamed' });
    const raw = JSON.parse(fs.readFileSync(docFile(), 'utf8'));
    const stored = raw.items.find((i) => i.id === id);
    assert.ok(isTodoMaterialRef(stored.leafMaterial));
    assert.ok(fs.statSync(docFile()).size < inlineSize / 2);
    assert.deepEqual(loadTodosData(dataDir, cwd).items.find((i) => i.id === id).leafMaterial, doc.items.find((i) => i.id === id).leafMaterial);
    assert.equal(getTodoMaterialStore(dataDir).listPins().length, 0);
    assert.deepEqual(verifyReferenceClosure(dataDir), { refs: 1, missing: [], corrupt: [] });
    assert.equal(collectLiveHashes(dataDir).size, 1);
  });

  test('flag on: only done items are externalized', () => {
    process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
    const created = addTodo(dataDir, cwd, { title: 'open', idempotencyKey: 'open-1' });
    const id = (created.item || created.todo || created.doc.items.at(-1)).id;
    updateTodo(dataDir, cwd, id, { leafMaterial: MATERIAL });
    const raw = JSON.parse(fs.readFileSync(docFile(), 'utf8'));
    assert.deepEqual(raw.items.find((i) => i.id === id).leafMaterial, MATERIAL);
  });

  test('reader surfaces a missing or corrupt referenced file instead of dropping material', () => {
    const id = makeDoneTodo();
    process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
    updateTodo(dataDir, cwd, id, { title: 'again' });
    const stored = JSON.parse(fs.readFileSync(docFile(), 'utf8')).items.find((i) => i.id === id).leafMaterial;
    const file = getTodoMaterialStore(dataDir).contentPath(refHash(stored));
    // Force a fresh parse by touching the document.
    const touch = () => { const t = fs.readFileSync(docFile(), 'utf8'); fs.writeFileSync(docFile(), `${t}\n`); };
    fs.writeFileSync(file, '{}');
    touch();
    assert.throws(() => loadTodosData(dataDir, cwd), { code: 'TODO_MATERIAL_CORRUPT' });
    fs.unlinkSync(file);
    touch();
    assert.throws(() => loadTodosData(dataDir, cwd), { code: 'TODO_MATERIAL_MISSING' });
  });

  test('a crash inside the commit before the document write leaves the old document intact and the pin held', () => {
    const id = makeDoneTodo();
    const before = fs.readFileSync(docFile(), 'utf8');
    process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
    registerTodoMaterialStore(dataDir, createTodoMaterialStore({
      dataDir, hooks: { step(name) { if (name === 'fence-validated') throw new Error('crash before reference commit'); } },
    }));
    assert.throws(() => updateTodo(dataDir, cwd, id, { title: 'x' }), /crash before reference commit/);
    assert.equal(fs.readFileSync(docFile(), 'utf8'), before);
  });

  test('durable document write order: temp fsync, rename, directory fsync, then pin release', () => {
    const id = makeDoneTodo();
    process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
    const calls = [];
    const docName = path.basename(docFile());
    registerTodoMaterialStore(dataDir, createTodoMaterialStore({
      dataDir,
      ops: {
        writeFileDurable: (f, c) => {
          if (path.basename(f).startsWith(docName)) calls.push('temp-fsync');
          fs.writeFileSync(f, c, { flag: 'wx' });
        },
        renameSync: (a, b) => { if (path.basename(b) === docName) calls.push('rename'); fs.renameSync(a, b); },
        fsyncDir: (d) => { if (path.basename(d) === 'todos') calls.push('dir-fsync'); },
        unlinkSync: (f) => { if (f.endsWith('.pin')) calls.push('pin-release'); fs.unlinkSync(f); },
      },
    }));
    updateTodo(dataDir, cwd, id, { title: 'durable' });
    assert.deepEqual(calls.slice(0, 4), ['temp-fsync', 'rename', 'dir-fsync', 'pin-release']);
    assert.ok(isTodoMaterialRef(JSON.parse(fs.readFileSync(docFile(), 'utf8')).items.find((i) => i.id === id).leafMaterial));
  });

  test('persist republishes when the pin expired before the fence was taken', () => {
    const id = makeDoneTodo();
    process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
    let fired = false;
    const writer = createTodoMaterialStore({
      dataDir, now,
      hooks: {
        step(name) {
          // Pause between publish and the fence: lease runs out, recovery and GC run in another process.
          if (name === 'dir-synced' && !fired) {
            fired = true;
            clock += 11 * 60 * 1000;
            const other = createTodoMaterialStore({ dataDir, now });
            other.recover();
            clock += 25 * 3600 * 1000;
            other.gc({ liveRefs: new Set(), graceMs: 0 });
          }
        },
      },
    });
    registerTodoMaterialStore(dataDir, writer);
    updateTodo(dataDir, cwd, id, { title: 'republished' });
    const stored = JSON.parse(fs.readFileSync(docFile(), 'utf8')).items.find((i) => i.id === id).leafMaterial;
    assert.deepEqual(verifyReferenceClosure(dataDir), { refs: 1, missing: [], corrupt: [] });
    assert.deepEqual(writer.read(stored), MATERIAL);
  });
});

describe('publish content replacement is race-free', () => {
  /** Hash of MATERIAL and the shard path helpers. */
  const hashOf = () => sha256Hex(JSON.stringify(MATERIAL));

  test('(a) GC deletes the orphan between the publisher\'s exists check and its read: absent, not corruption', () => {
    const seed = mk();
    seed.consumePin(seed.publish(MATERIAL));
    const target = seed.contentPath(hashOf());
    const other = mk();
    let fired = false;
    const publisher = createTodoMaterialStore({
      dataDir, now,
      ops: {
        readFileSync: (f) => {
          if (f === target && !fired) {
            fired = true;
            // The publisher's pin lease runs out, recovery drops it and GC deletes the orphan.
            clock += 25 * 3600 * 1000;
            other.recover();
            other.gc({ liveRefs: new Set(), graceMs: 0 });
          }
          return fs.readFileSync(f);
        },
      },
    });
    const ref = publisher.publish(MATERIAL);
    assert.equal(fired, true);
    assert.deepEqual(publisher.read(ref), MATERIAL);
  });

  test('(b) another publisher restores the hash and a document references it before the replacement: no delete, no damage', () => {
    const seed = mk();
    const ref0 = seed.publish(MATERIAL);
    seed.consumePin(ref0);
    const target = seed.contentPath(hashOf());
    fs.writeFileSync(target, '{"corrupt":true}');
    const second = mk();
    const events = [];
    let fired = false;
    const first = createTodoMaterialStore({
      dataDir, now,
      ops: {
        readFileSync: (f) => {
          const bytes = fs.readFileSync(f);
          if (f === target && !fired) {
            fired = true;
            // Paused after seeing corrupt bytes: a second publisher repairs the hash and a document commits it.
            const ref = second.publish(MATERIAL);
            second.commit([ref], () => events.push('document-references-hash'));
          }
          return bytes;
        },
        unlinkSync: (f) => { if (f === target) events.push('target-unlinked'); fs.unlinkSync(f); },
        renameSync: (a, b) => { if (b === target) events.push(['rename-over-target', fs.existsSync(target)]); fs.renameSync(a, b); },
      },
    });
    first.publish(MATERIAL);
    assert.deepEqual(events, ['document-references-hash']);
    assert.deepEqual(first.read({ $ref: `sha256:${hashOf()}`, bytes: Buffer.byteLength(JSON.stringify(MATERIAL)) }), MATERIAL);
    assert.deepEqual(fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith('.tmp')), [], 'no temp file left behind');
  });

  test('(c) corrupt content is replaced by an atomic rename; the target is never missing or unlinked', () => {
    const seed = mk();
    seed.consumePin(seed.publish(MATERIAL));
    const target = seed.contentPath(hashOf());
    fs.writeFileSync(target, 'garbage');
    const seen = [];
    const store = createTodoMaterialStore({
      dataDir, now,
      ops: {
        unlinkSync: (f) => { if (f === target) seen.push('unlink-target'); fs.unlinkSync(f); },
        renameSync: (a, b) => {
          if (b === target) seen.push(['rename', fs.existsSync(target)]);
          fs.renameSync(a, b);
        },
      },
    });
    const ref = store.publish(MATERIAL);
    assert.deepEqual(seen, [['rename', true]]);
    assert.deepEqual(store.read(ref), MATERIAL);
  });

  test('(d) publishBuffer (rollback restore path) repairs corrupt content and rejects a hash mismatch', () => {
    const seed = mk();
    seed.consumePin(seed.publish(MATERIAL));
    const target = seed.contentPath(hashOf());
    fs.writeFileSync(target, 'garbage');
    const store = mk();
    const ref = store.publishBuffer(Buffer.from(JSON.stringify(MATERIAL)), hashOf());
    assert.deepEqual(store.read(ref), MATERIAL);
    store.consumePin(ref);
    assert.throws(() => store.publishBuffer(Buffer.from('other'), hashOf()), { code: 'TODO_MATERIAL_CORRUPT' });
  });
});

/** Non-re-entrant in-process mutex standing in for the workspace file lock, shared by several stores. */
function makeMutex() {
  let busy = false;
  return {
    withLock(work) {
      if (busy) throw Object.assign(new Error('lock busy'), { code: 'MOCK_LOCK_BUSY' });
      busy = true;
      try { return work(); } finally { busy = false; }
    },
  };
}

describe('workspace-lock interleavings', () => {
  test('writer paused after publish, lease expires, recover+GC run: commit fails and the writer republishes (no dangling ref)', () => {
    const writer = mk();
    const other = mk();
    const ref = writer.publish(MATERIAL);
    clock += 11 * 60 * 1000;
    other.recover();
    clock += 25 * 3600 * 1000;
    other.gc({ liveRefs: new Set(), graceMs: 0 });
    let written = false;
    assert.throws(() => writer.commit([ref], () => { written = true; }), (e) => ['TODO_MATERIAL_PIN_LOST', 'TODO_MATERIAL_MISSING'].includes(e.code));
    assert.equal(written, false);
    const again = writer.publish(MATERIAL);
    writer.commit([again], () => { written = true; });
    assert.equal(written, true);
    assert.deepEqual(writer.read(again), MATERIAL);
    assert.equal(writer.listPins().length, 0);
  });

  test('GC between a writer\'s publish and commit cannot delete pinned content', () => {
    const writer = mk();
    const other = mk();
    const ref = writer.publish(MATERIAL);
    const out = other.gc({ liveRefs: new Set(), graceMs: 0 });
    assert.deepEqual(out.deleted, []);
    assert.equal(out.skipped[0].reason, 'pinned');
    let written = false;
    writer.commit([ref], () => { written = true; });
    assert.equal(written, true);
    assert.deepEqual(other.read(ref), MATERIAL);
  });

  test('GC cannot delete content referenced by a document committed after the pre-pass (references re-read per candidate)', () => {
    const store = mk();
    const ref = store.publish(MATERIAL);
    store.consumePin(ref);
    clock += 25 * 3600 * 1000;
    let calls = 0;
    // The pre-pass sees no reference; by the time the candidate's critical section runs one was committed.
    const out = store.gc({ liveRefs: () => (++calls === 1 ? new Set() : new Set([refHash(ref)])), now: clock, graceMs: 0 });
    assert.deepEqual(out.deleted, []);
    assert.equal(out.skipped[0].reason, 'referenced');
    assert.deepEqual(store.read(ref), MATERIAL);
  });

  test('a writer holding the lock blocks GC and recovery steps; nothing is deleted meanwhile', () => {
    const mutex = makeMutex();
    const writer = createTodoMaterialStore({ dataDir, now, withLock: mutex.withLock });
    const other = createTodoMaterialStore({ dataDir, now, withLock: mutex.withLock });
    const orphan = other.publish({ ...MATERIAL, n: 9 });
    other.consumePin(orphan);
    const expiring = other.publish({ ...MATERIAL, n: 8 });
    clock += 25 * 3600 * 1000;
    const ref = writer.publish(MATERIAL);
    const outcome = {};
    writer.commit([ref], () => {
      for (const op of ['gc', 'recover']) {
        try { other[op]({ liveRefs: new Set(), graceMs: 0 }); outcome[op] = 'ran'; } catch (e) { outcome[op] = e.code; }
      }
    });
    assert.deepEqual(outcome, { gc: 'MOCK_LOCK_BUSY', recover: 'MOCK_LOCK_BUSY' });
    assert.deepEqual(other.read(orphan), { ...MATERIAL, n: 9 });
    assert.equal(other.listPins().some(({ pin }) => pin && pin.hash === refHash(expiring)), true, 'expired pin survived while the writer held the lock');
  });

  test('two gc/recover calls serialize: recover is refused inside a GC critical section and the .deleting mark survives', () => {
    const mutex = makeMutex();
    let other;
    let outcome;
    const collector = createTodoMaterialStore({
      dataDir, now, withLock: mutex.withLock,
      hooks: {
        step(name, info) {
          if (name !== 'gc-marked') return;
          try { other.recover({ liveRefs: new Set() }); outcome = 'ran'; } catch (e) { outcome = e.code; }
          outcome = [outcome, fs.existsSync(`${other.contentPath(info.hash)}.deleting`)];
        },
      },
    });
    other = createTodoMaterialStore({ dataDir, now, withLock: mutex.withLock });
    const ref = other.publish(MATERIAL);
    other.consumePin(ref);
    clock += 25 * 3600 * 1000;
    // The .deleting mark is visible to recovery only if it could run; it must not.
    const out = collector.gc({ liveRefs: new Set(), now: clock, graceMs: 0 });
    assert.deepEqual(outcome, ['MOCK_LOCK_BUSY', true]);
    assert.deepEqual(out.deleted, [refHash(ref)]);
  });

  test('critical sections are short: GC takes the lock once per candidate, not across the scan', () => {
    let depth = 0;
    let acquisitions = 0;
    const withLock = (work) => { acquisitions += 1; depth += 1; try { return work(); } finally { depth -= 1; } };
    const store = createTodoMaterialStore({ dataDir, now, withLock });
    for (let n = 0; n < 3; n += 1) store.consumePin(store.publish({ ...MATERIAL, n }));
    const base = acquisitions;
    clock += 25 * 3600 * 1000;
    store.gc({ liveRefs: new Set(), now: clock, graceMs: 0 });
    assert.equal(acquisitions - base, 3);
    assert.equal(depth, 0);
  });

  test('a stalled lock holder in another process blocks GC (real workspace lock), then GC proceeds', async () => {
    const { spawn } = await import('node:child_process');
    const store = createTodoMaterialStore({ dataDir, now, lockTimeoutMs: 150 });
    const ref = store.publish(MATERIAL);
    store.consumePin(ref);
    clock += 25 * 3600 * 1000;
    const lockModule = new URL('../lib/persist/workspace-watchers-persist.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { withWorkspaceWatchersFileLock } from ${JSON.stringify(lockModule)};
       withWorkspaceWatchersFileLock(() => { console.log('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); }, { dataDir: ${JSON.stringify(dataDir)} });`,
    ], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CRETLI_DATA_DIR: dataDir } });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { if (String(d).includes('locked')) resolve(); });
      child.on('error', reject);
      child.on('exit', () => resolve());
    });
    try {
      assert.throws(() => store.gc({ liveRefs: new Set(), now: clock, graceMs: 0 }), (e) => /lock/i.test(String(e.message)));
      assert.deepEqual(store.read(ref), MATERIAL);
    } finally {
      await new Promise((resolve) => { child.on('exit', resolve); if (child.exitCode !== null) resolve(); });
    }
    const slow = createTodoMaterialStore({ dataDir, now });
    assert.deepEqual(slow.gc({ liveRefs: new Set(), now: clock, graceMs: 0 }).deleted, [refHash(ref)]);
  });

  test('an unreadable todos document aborts GC before anything is deleted', () => {
    const store = mk();
    const ref = store.publish(MATERIAL);
    store.consumePin(ref);
    fs.mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'todos', `${'a'.repeat(64)}.json`), '{ not json');
    clock += 25 * 3600 * 1000;
    assert.throws(() => store.gc({ now: clock, graceMs: 0 }), { code: 'TODO_MATERIAL_DOCS_UNREADABLE' });
    assert.throws(() => collectLiveHashes(dataDir), { code: 'TODO_MATERIAL_DOCS_UNREADABLE' });
    assert.deepEqual(store.read(ref), MATERIAL);
    // A document without an items array is equally unsafe to skip.
    fs.writeFileSync(path.join(dataDir, 'todos', `${'a'.repeat(64)}.json`), '{"items":"nope"}');
    assert.throws(() => store.gc({ now: clock, graceMs: 0 }), { code: 'TODO_MATERIAL_DOCS_UNREADABLE' });
  });

  test('every new directory is fsynced in its parent', () => {
    const synced = [];
    const store = createTodoMaterialStore({ dataDir, now, ops: { fsyncDir: (d) => { synced.push(d); fs.closeSync(fs.openSync(d, 'r')); } } });
    const ref = store.publish(MATERIAL);
    const hash = refHash(ref);
    const root = path.join(dataDir, 'todo-material');
    assert.ok(synced.includes(path.resolve(dataDir)), 'data dir (holds the new material root)');
    assert.ok(synced.includes(root), 'material root (holds pins/ and the shard)');
    assert.ok(synced.includes(path.join(root, 'pins')));
    assert.ok(synced.includes(path.join(root, hash.slice(0, 2))));
    assert.ok(synced.indexOf(root) < synced.indexOf(path.join(root, hash.slice(0, 2))));
  });
});

describe('externalize-todo-material CLI', () => {
  const quiet = { log() {}, error: (l) => process.env.MAT_DEBUG && console.error(l) };

  function backupOf() {
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-material-bak-'));
    fs.cpSync(path.join(dataDir, 'todos'), path.join(backup, 'todos'), { recursive: true });
    return backup;
  }

  test('dry run reports and writes nothing', () => {
    makeDoneTodo();
    const before = fs.readFileSync(docFile(), 'utf8');
    const lines = [];
    assert.equal(cliMain(['--data-dir', dataDir], { log: (l) => lines.push(l), error() {} }), 0);
    assert.equal(fs.readFileSync(docFile(), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(dataDir, 'todo-material')), false);
    assert.ok(lines.some((l) => /DRY RUN/.test(l)));
    const plan = planExternalization(dataDir);
    assert.equal(plan.totals.candidates, 1);
    assert.ok(plan.totals.bytesToMove > 0);
  });

  test('apply refuses without a backup, with a mismatching backup, and a missing directory', () => {
    makeDoneTodo();
    const before = fs.readFileSync(docFile(), 'utf8');
    assert.equal(cliMain(['--data-dir', dataDir, '--apply'], quiet), 2);
    assert.equal(cliMain(['--data-dir', dataDir, '--apply', '--confirm-backup', path.join(os.tmpdir(), 'no-such-backup-dir')], quiet), 2);
    const backup = backupOf();
    try {
      const copy = path.join(backup, 'todos', path.basename(docFile()));
      fs.writeFileSync(copy, `${fs.readFileSync(copy, 'utf8')} `);
      assert.equal(cliMain(['--data-dir', dataDir, '--apply', '--confirm-backup', backup], quiet), 2);
      assert.equal(fs.readFileSync(docFile(), 'utf8'), before);
      assert.equal(fs.existsSync(path.join(dataDir, 'todo-material')), false);
    } finally { fs.rmSync(backup, { recursive: true, force: true }); }
  });

  test('apply externalizes with a matching backup; --inline-back restores identical bytes', () => {
    makeDoneTodo();
    const original = fs.readFileSync(docFile(), 'utf8');
    const backup = backupOf();
    try {
      assert.equal(cliMain(['--data-dir', dataDir, '--apply', '--confirm-backup', backup], quiet), 0);
      const externalized = fs.readFileSync(docFile(), 'utf8');
      assert.notEqual(externalized, original);
      assert.ok(isTodoMaterialRef(JSON.parse(externalized).items[0].leafMaterial));
      assert.deepEqual(verifyReferenceClosure(dataDir), { refs: 1, missing: [], corrupt: [] });
      // Rollback needs a fresh backup of the now-externalized state.
      fs.rmSync(path.join(backup, 'todos'), { recursive: true });
      fs.cpSync(path.join(dataDir, 'todos'), path.join(backup, 'todos'), { recursive: true });
      assert.equal(cliMain(['--data-dir', dataDir, '--apply', '--inline-back', '--confirm-backup', backup], quiet), 0);
      assert.equal(fs.readFileSync(docFile(), 'utf8'), original);
    } finally { fs.rmSync(backup, { recursive: true, force: true }); }
  });

  test('apply refuses while a writer is active', () => {
    makeDoneTodo();
    const backup = backupOf();
    try {
      fs.mkdirSync(path.join(dataDir, 'delegation-owner.lock'));
      fs.writeFileSync(path.join(dataDir, 'delegation-owner.lock', 'owner.json'), JSON.stringify({ pid: process.pid }));
      assert.throws(() => applyExternalization({ dataDir, confirmBackup: backup }), { code: 'ACTIVE_WRITER' });
    } finally { fs.rmSync(backup, { recursive: true, force: true }); }
  });
});

describe('registration', () => {
  test('todo-material files are registry-managed (offline backup set)', async () => {
    const { enumerateManaged } = await import('../lib/backup/offline/managed-files.js');
    const store = mk();
    const ref = store.publish(MATERIAL);
    store.consumePin(ref);
    const rels = enumerateManaged(dataDir).files.map((f) => f.rel);
    assert.ok(rels.includes(`todo-material/${refHash(ref).slice(0, 2)}/${refHash(ref)}`));
  });

  test('migration source manifest refuses a dangling reference and covers material otherwise', async () => {
    const { planTodosMigration } = await import('../lib/storage/todos-migration.js');
    makeDoneTodo();
    process.env.CRETLI_TODO_MATERIAL_EXTERNAL = '1';
    updateTodo(dataDir, cwd, loadTodosData(dataDir, cwd).items[0].id, { title: 'renamed' });
    const plan = planTodosMigration({ dataDir, datasetGeneration: 'gen-test-0001', minQuietMs: 0 });
    assert.equal(plan.ok, true);
    const ref = JSON.parse(fs.readFileSync(docFile(), 'utf8')).items[0].leafMaterial;
    fs.unlinkSync(getTodoMaterialStore(dataDir).contentPath(refHash(ref)));
    assert.throws(() => planTodosMigration({ dataDir, datasetGeneration: 'gen-test-0001', minQuietMs: 0 }), (e) => e.code === 'todos_material_closure' || /closure|missing/i.test(String(e.message)));
  });
});

describe('rollback export is self-contained', () => {
  test('export ships the referenced closure; activation restores it when the live store is empty', async () => {
    const { openTodosRuntime } = await import('../lib/persist/todos-runtime.js');
    const { applyTodosMigration, planTodosMigration, exportTodosRollback, activateTodosRollback, verifyTodosRollbackExport } = await import('../lib/storage/todos-migration.js');
    const { WRITE_GATE_TEST_EXEMPTION } = await import('../lib/storage/maintenance-coordinator.js');
    const { TODOS_GENERATION } = await import('./fixtures/todos-sqlite-harness.js');
    const key = 'b'.repeat(64);
    const store = getTodoMaterialStore(dataDir);
    const ref = store.publish(MATERIAL);
    store.consumePin(ref);
    const ts = '2026-01-01T00:00:00.000Z';
    fs.mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'todos', `${key}.json`), JSON.stringify({
      version: 3, updatedAt: ts, idempotency: {},
      items: [{ id: 'd1', title: 'done', body: '', status: 'done', createdAt: ts, updatedAt: ts, leafMaterial: ref }],
    }));
    const plan = planTodosMigration({ dataDir, datasetGeneration: TODOS_GENERATION, minQuietMs: 0 });
    assert.ok(plan.manifestHash);
    applyTodosMigration({ dataDir, datasetGeneration: TODOS_GENERATION, minQuietMs: 0, confirmPlanHash: plan.planHash });
    const runtime = await openTodosRuntime({ dataDir, writeGate: WRITE_GATE_TEST_EXEMPTION });
    await runtime.close();
    const exportDir = path.join(dataDir, 'rollback-1');
    const exported = exportTodosRollback({ dataDir, outDir: exportDir });
    assert.deepEqual(exported.manifest.material, [{ hash: refHash(ref), bytes: ref.bytes }]);
    assert.equal(fs.readFileSync(path.join(exportDir, 'todo-material', refHash(ref).slice(0, 2), refHash(ref)), 'utf8'), JSON.stringify(MATERIAL));
    verifyTodosRollbackExport({ exportDir, dataDir });
    // A tampered export file is refused.
    const shipped = path.join(exportDir, 'todo-material', refHash(ref).slice(0, 2), refHash(ref));
    fs.writeFileSync(shipped, '{}');
    assert.throws(() => verifyTodosRollbackExport({ exportDir, dataDir }), (e) => e.code === 'todos_material_closure');
    fs.writeFileSync(shipped, JSON.stringify(MATERIAL));
    // The live store is lost: activation must restore the closure from the export before publishing documents.
    fs.rmSync(path.join(dataDir, 'todo-material'), { recursive: true });
    resetTodoMaterialStores();
    const activated = activateTodosRollback({ dataDir, exportDir });
    assert.equal(activated.marker.backend, 'legacy-rollback');
    assert.deepEqual(getTodoMaterialStore(dataDir).read(ref), MATERIAL);
    assert.equal(getTodoMaterialStore(dataDir).listPins().length, 0);
  });

  test('export fsyncs material files, shard dirs, the material dir and the export root before publishing', async () => {
    const { openTodosRuntime } = await import('../lib/persist/todos-runtime.js');
    const { applyTodosMigration, planTodosMigration, exportTodosRollback } = await import('../lib/storage/todos-migration.js');
    const { WRITE_GATE_TEST_EXEMPTION } = await import('../lib/storage/maintenance-coordinator.js');
    const { TODOS_GENERATION } = await import('./fixtures/todos-sqlite-harness.js');
    const store = getTodoMaterialStore(dataDir);
    const ref = store.publish(MATERIAL);
    store.consumePin(ref);
    const ts = '2026-01-01T00:00:00.000Z';
    fs.mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'todos', `${'c'.repeat(64)}.json`), JSON.stringify({
      version: 3, updatedAt: ts, idempotency: {},
      items: [{ id: 'd1', title: 'done', body: '', status: 'done', createdAt: ts, updatedAt: ts, leafMaterial: ref }],
    }));
    const plan = planTodosMigration({ dataDir, datasetGeneration: TODOS_GENERATION, minQuietMs: 0 });
    applyTodosMigration({ dataDir, datasetGeneration: TODOS_GENERATION, minQuietMs: 0, confirmPlanHash: plan.planHash });
    await (await openTodosRuntime({ dataDir, writeGate: WRITE_GATE_TEST_EXEMPTION })).close();
    const exportDir = path.join(dataDir, 'rollback-2');
    const partial = `${exportDir}.partial`;
    const synced = [];
    exportTodosRollback({
      dataDir, outDir: exportDir,
      fsyncDirectory: (dir) => {
        synced.push(dir);
        // Files are already on disk when their directories are flushed; the export is not published yet.
        assert.ok(fs.existsSync(path.join(partial, 'todo-material', refHash(ref).slice(0, 2), refHash(ref))));
        assert.equal(fs.existsSync(exportDir), false);
      },
    });
    const materialDir = path.join(partial, 'todo-material');
    assert.deepEqual(synced.slice(-3), [path.join(materialDir, refHash(ref).slice(0, 2)), materialDir, partial]);
  });
});
