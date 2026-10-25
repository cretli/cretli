/**
 * R4: bounded microbatch of the v1 pending files (record/ack coalescing, one directory fsync per group).
 * Synthetic data in temp dirs only; fsp is spied on, never durability-disabled.
 */
import './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHistoryPendingBuffer } from '../lib/persist/history-pending-buffer.js';

let root;
let entriesDir;
const original = { open: fsp.open, rename: fsp.rename, rm: fsp.rm };
const hashFile = (id) => `${createHash('sha256').update(id, 'utf8').digest('hex')}.json`;
const entry = (id, extra = {}) => ({ commandId: id, producerId: 'server:test', operation: 'appendEvents', chatId: 'chat-1', payload: { events: [{ clientSeq: 1 }] }, ...extra });

async function boot(options = {}) {
  const buffer = createHistoryPendingBuffer({ dir: path.join(root, 'pending'), ...options });
  await buffer.open();
  return buffer;
}
/** Count fsyncs of the entries directory (opened 'r' on exactly that path). */
function spyDirSync(failTimes = 0) {
  const state = { opens: 0, failLeft: failTimes };
  fsp.open = async (target, ...rest) => {
    if (target !== entriesDir) return original.open(target, ...rest);
    state.opens += 1;
    const handle = await original.open(target, ...rest);
    if (state.failLeft > 0) {
      state.failLeft -= 1;
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => { await realSync(); throw Object.assign(new Error('injected dir sync failure'), { code: 'EIO' }); };
    }
    return handle;
  };
  return state;
}
const files = () => fs.readdirSync(entriesDir).sort();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-pending-mb-'));
  entriesDir = path.join(root, 'pending', 'entries');
});
afterEach(() => {
  Object.assign(fsp, original);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pending buffer microbatch', () => {
  it('coalesces 64 concurrent records into ONE directory fsync, unique orders, survives restart', async () => {
    const buffer = await boot();
    const sync = spyDirSync();
    const results = await Promise.all(Array.from({ length: 64 }, (_, i) => buffer.record(entry(`hist.append.c${i}`))));
    assert.equal(sync.opens, 1);
    assert.equal(new Set(results.map((r) => r.order)).size, 64);
    assert.deepEqual(results.map((r) => r.order), [...results.map((r) => r.order)].sort((a, b) => a - b), 'order follows call order');
    assert.equal(buffer.stats().entries, 64);
    assert.equal(files().length, 64);
    const second = await boot();
    assert.equal(second.stats().entries, 64, 'v1 files are unchanged and reload');
    assert.equal(second.stats().totalBytes, buffer.stats().totalBytes);
  });

  it('refuses duplicate ids (within a request and across a group) before any IO; others succeed', async () => {
    const buffer = await boot();
    const sync = spyDirSync();
    const [a, dupInside, dupAcross, ok] = await Promise.allSettled([
      buffer.record(entry('x1')), buffer.recordMany([entry('y1'), entry('y1')]), buffer.record(entry('x1')), buffer.record(entry('z1')),
    ]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(ok.status, 'fulfilled');
    assert.equal(dupInside.reason.code, 'history_pending_full');
    assert.equal(dupAcross.reason.code, 'history_pending_full');
    assert.equal(sync.opens, 1);
    assert.deepEqual(files().length, 2);
  });

  it('quota is checked per request in order against the running group; a refusal does not poison the rest', async () => {
    const buffer = await boot({ maxEntries: 10 });
    const settled = await Promise.allSettled([
      buffer.recordMany(Array.from({ length: 8 }, (_, i) => entry(`a${i}`))),
      buffer.recordMany(Array.from({ length: 5 }, (_, i) => entry(`b${i}`))),
      buffer.recordMany([entry('c0'), entry('c1')]),
    ]);
    assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal(settled[1].reason.code, 'history_pending_full');
    assert.equal(buffer.stats().entries, 10);
    assert.equal(files().length, 10);
  });

  it('one failing request is rolled back completely (all its paths); the others are committed', async () => {
    const buffer = await boot();
    const badName = hashFile('bad-1');
    fsp.rename = async (from, to) => {
      if (path.basename(to) === badName) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return original.rename(from, to);
    };
    const settled = await Promise.allSettled([buffer.record(entry('good-1')), buffer.recordMany([entry('bad-0'), entry('bad-1')]), buffer.record(entry('good-2'))]);
    assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal(settled[1].reason.code, 'EIO');
    assert.equal(buffer.get('bad-0'), null);
    assert.deepEqual(files(), [hashFile('good-1'), hashFile('good-2')].sort(), 'no temp file, no renamed sibling of the failed request');
    assert.equal(buffer.stats().entries, 2);
  });

  it('directory fsync failure: the whole group is discarded (renamed files too) and proven by a second fsync', async () => {
    const buffer = await boot();
    const sync = spyDirSync(1);
    const settled = await Promise.allSettled([buffer.record(entry('d1')), buffer.record(entry('d2'))]);
    assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected']);
    assert.equal(settled[0].reason.code, 'EIO');
    assert.equal(sync.opens, 2);
    assert.deepEqual(files(), []);
    assert.equal(buffer.stats().entries, 0);
    await buffer.record(entry('d3'));
    assert.equal(buffer.stats().entries, 1, 'the buffer keeps working after a proven discard');
  });

  it('unprovable cleanup fails closed: identities stay indexed, recording is refused until they are acknowledged', async () => {
    const buffer = await boot();
    spyDirSync(2);
    const settled = await Promise.allSettled([buffer.record(entry('u1')), buffer.record(entry('u2'))]);
    for (const item of settled) {
      assert.equal(item.status, 'rejected');
      assert.equal(item.reason.code, 'history_cleanup_uncertain');
      assert.equal(item.reason.details.commitState, 'uncertain');
    }
    assert.deepEqual(buffer.list().map((e) => e.commandId).sort(), ['u1', 'u2'], 'still visible to recovery');
    await assert.rejects(buffer.record(entry('u3')), (error) => error.code === 'history_cleanup_uncertain');
    Object.assign(fsp, original);
    await buffer.ackMany(['u1']);
    await buffer.ack('u2');
    await buffer.record(entry('u3'));
    assert.equal(buffer.stats().entries, 1);
  });

  it('single acks coalesce into one fsync; a logical batch keeps sequential unlink + fsync (suffix on crash)', async () => {
    const buffer = await boot();
    await Promise.all(Array.from({ length: 20 }, (_, i) => buffer.record(entry(`s${i}`))));
    await buffer.recordMany([0, 1, 2].map((i) => entry(`b${i}`, { batch: { id: 'batch-1', index: i, count: 3, digest: 'd' } })));
    const sync = spyDirSync();
    const removed = [];
    fsp.rm = async (file, ...rest) => { removed.push(path.basename(file)); return original.rm(file, ...rest); };
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => buffer.ack(`s${i}`)));
    assert.ok(results.every((r) => r === true));
    assert.equal(sync.opens, 1);
    removed.length = 0;
    sync.opens = 0;
    assert.equal(await buffer.ackMany(['b0', 'b1', 'b2']), 3);
    assert.equal(sync.opens, 3);
    assert.deepEqual(removed, ['b0', 'b1', 'b2'].map(hashFile));
    assert.equal(buffer.stats().entries, 0);
    assert.equal(await buffer.ack('missing'), false);
  });

  it('two acks of the same logical batch never share a fsync group', async () => {
    const buffer = await boot();
    await buffer.recordMany([0, 1].map((i) => entry(`q${i}`, { batch: { id: 'batch-2', index: i, count: 2, digest: 'd' } })));
    const sync = spyDirSync();
    await Promise.all([buffer.ack('q0'), buffer.ack('q1')]);
    assert.equal(sync.opens, 2);
    assert.equal(buffer.stats().entries, 0);
  });

  it('a failed ack keeps the entry indexed and reports the error', async () => {
    const buffer = await boot();
    await buffer.record(entry('k1'));
    spyDirSync(1);
    await assert.rejects(buffer.ack('k1'), (error) => error.code === 'EIO');
    assert.equal(buffer.get('k1')?.commandId, 'k1');
    Object.assign(fsp, original);
    assert.equal(await buffer.ack('k1'), true);
  });

  it('groups are bounded: 600 entries are split into several groups, all durable', async () => {
    const buffer = await boot();
    const sync = spyDirSync();
    await Promise.all(Array.from({ length: 600 }, (_, i) => buffer.record(entry(`g${i}`))));
    assert.ok(sync.opens >= 3 && sync.opens <= 6, `fsyncs ${sync.opens}`);
    assert.equal(files().length, 600);
  });
});
