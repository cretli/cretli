/**
 * R5: (P1) a partial pending plan left by a failed record/cleanup is never taken for a committed ACK suffix without
 * receipt proof; (P2) record/ack admission is bounded before a snapshot is retained. Synthetic data, temp dirs only.
 */
import './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { bootParts, makeRoot, chatIdOf, userRec } from './fixtures/storage-history-adapter-harness.js';
import { createHistoryPendingBuffer } from '../lib/persist/history-pending-buffer.js';
import os from 'node:os';
import path from 'node:path';

const original = { rename: fsp.rename, rm: fsp.rm };
let root;
let parts;
beforeEach(() => { root = makeRoot('cretli-r5-'); });
afterEach(async () => {
  Object.assign(fsp, original);
  try { await parts?.close(); } catch { /* already closed */ }
  parts = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Fail the rename of batch index 0 and the cleanup of batch index 1 (the double fault of the review). */
function injectDoubleFault() {
  let suffixFile;
  fsp.rename = async (from, to) => {
    if (String(to).includes('/entries/')) {
      const row = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (row.batch?.index === 0) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      if (row.batch?.index === 1) suffixFile = to;
    }
    return original.rename(from, to);
  };
  fsp.rm = async (file, options) => {
    if (file === suffixFile) throw Object.assign(new Error('injected cleanup failure'), { code: 'EIO' });
    return original.rm(file, options);
  };
}
const twoChunks = () => [{ rec: userRec('a'.repeat(40000)) }, { rec: userRec('b'.repeat(40000)) }];

describe('R5-P1 partial plan recovery', () => {
  it('double fault: refusal names the stable batch identity; restart quarantines the unproven suffix instead of ACKing it', async () => {
    parts = await bootParts({ root });
    injectDoubleFault();
    let failure;
    try { await parts.adapter.appendChatHistoryEvents(chatIdOf(42), '', twoChunks(), { coalesce: false }); } catch (error) { failure = error; }
    assert.equal(failure?.code, 'history_cleanup_uncertain');
    assert.ok(failure.details.batchId && failure.details.retryToken === failure.details.batchId);
    // Only the file that may exist stays fenced; index 0 never reached disk.
    assert.deepEqual(parts.pendingBuffer.list().map((e) => e.batch.index), [1]);
    // The retry token cannot drive an incomplete plan: unsafe replay is refused, never replayed under new ids.
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chatIdOf(42), '', twoChunks(), { retryToken: failure.details.retryToken, coalesce: false }), (e) => e.code === 'history_batch_unknown' || e.code === 'history_batch_mismatch');
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chatIdOf(42), '', twoChunks(), { coalesce: false }), (e) => e.code === 'history_cleanup_uncertain');
    Object.assign(fsp, original);
    await parts.close();
    parts = await bootParts({ root });
    assert.deepEqual(parts.pendingBuffer.list().map((e) => e.batch.index), [1]);
    const recovery = await parts.backend.recoverPending();
    assert.equal(recovery.quarantined.length, 1);
    assert.equal(recovery.quarantined[0].reason, 'batch_suffix_unproven');
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    assert.equal(fs.readdirSync(path.join(root, 'pending', 'quarantine')).length >= 1, true);
  });

  it('a real ACK suffix (every remaining fragment has a committed receipt) is still acknowledged', async () => {
    parts = await bootParts({ root });
    // Commit a plan fully, but make every acknowledgement fail so all fragment files stay; then cut index 0 (the crash shape).
    fsp.rm = async (file, options) => {
      if (String(file).includes('/entries/')) throw Object.assign(new Error('ack rm down'), { code: 'EIO' });
      return original.rm(file, options);
    };
    try { await parts.adapter.appendChatHistoryEvents(chatIdOf(43), '', twoChunks(), { coalesce: false }); } catch { /* ack failure is allowed to surface */ }
    Object.assign(fsp, original);
    const all = parts.pendingBuffer.list();
    assert.ok(all.length >= 2, 'a two-chunk plan is expected');
    await parts.pendingBuffer.ackMany([all[0].commandId]);
    await parts.close();
    parts = await bootParts({ root });
    assert.equal(parts.pendingBuffer.list().length, all.length - 1);
    const recovery = await parts.backend.recoverPending();
    assert.deepEqual(recovery.quarantined, []);
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });
});

describe('R5-P1 unexpected group failure', () => {
  it('a throw while the group is being settled still fences files whose removal is not proven', async () => {
    const buffer = createHistoryPendingBuffer({ dir: path.join(root, 'p'), now: () => 1 });
    await buffer.open();
    const entry = (id) => ({ commandId: id, producerId: 'server:test', operation: 'appendEvents', chatId: 'chat-1', payload: { events: [{ clientSeq: 1 }] }, batch: { id: 'b1', index: 0, count: 1, digest: 'd' } });
    fsp.rm = async () => { throw Object.assign(new Error('rm down'), { code: 'EIO' }); };
    fsp.rename = async (from, to) => { await original.rename(from, to); throw Object.assign(new Error('late failure'), { code: 'EIO' }); };
    await assert.rejects(buffer.recordMany([entry('c1')]), (e) => e.code === 'history_cleanup_uncertain' && e.details.retryToken === 'b1');
    assert.equal(buffer.stats().entries, 1);
    await buffer.close?.();
  });
});

describe('R5-P2 bounded admission', () => {
  const entry = (id, text = 'x') => ({ commandId: id, producerId: 'server:test', operation: 'appendEvents', chatId: 'chat-1', payload: { events: [{ clientSeq: 1, rec: { text } }] } });

  it('queued bursts are refused before they are retained, input untouched, reservation released afterwards', async () => {
    const buffer = createHistoryPendingBuffer({ dir: path.join(root, 'p'), maxEntries: 8, maxTotalBytes: 64 * 1024 });
    await buffer.open();
    const inputs = Array.from({ length: 20 }, (_, i) => entry(`c${i}`));
    const copies = JSON.stringify(inputs);
    const results = await Promise.allSettled(inputs.map((item) => buffer.record(item)));
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 8);
    assert.equal(refused.length, 12);
    assert.ok(refused.every((r) => r.reason.code === 'history_pending_full'));
    assert.equal(JSON.stringify(inputs), copies);
    assert.equal(buffer.stats().entries, 8);
    await buffer.ackMany(buffer.list().map((e) => e.commandId));
    await buffer.record(entry('after')); // the refusals released every reservation
    assert.equal(buffer.stats().entries, 1);
  });

  it('a single oversized request is refused atomically and does not consume quota', async () => {
    const buffer = createHistoryPendingBuffer({ dir: path.join(root, 'p'), maxTotalBytes: 20 * 1024 });
    await buffer.open();
    await assert.rejects(buffer.recordMany([entry('big', 'y'.repeat(40 * 1024))]), (e) => e.code === 'history_pending_full' || e.code === 'history_pending_entry_too_large');
    await buffer.record(entry('small'));
    assert.equal(buffer.stats().entries, 1);
  });

  it('ACK queue is count-bounded and a refused ACK keeps the pending file', async () => {
    const buffer = createHistoryPendingBuffer({ dir: path.join(root, 'p'), maxEntries: 4 });
    await buffer.open();
    await buffer.recordMany([entry('a'), entry('b'), entry('c'), entry('d')]);
    const acks = ['a', 'b', 'c', 'd', 'a', 'b'].map((id) => buffer.ack(id).then(() => 'ok', (e) => e.code));
    const out = await Promise.all(acks);
    assert.ok(out.includes('history_pending_full'));
    assert.equal(buffer.stats().entries, 0);
  });
});
