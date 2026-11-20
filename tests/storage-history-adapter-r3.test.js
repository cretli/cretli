/**
 * Stage 2a round 3: byte-paged read-back of a committed append (F7) and durable
 * cleanup of plans known not to have committed (F8). Synthetic data in temp dirs only.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootParts, chatIdOf, makeRoot, userRec } from './fixtures/storage-history-adapter-harness.js';
import { StorageError } from '../lib/storage/errors.js';

/** @type {string} */
let root;
/** @type {Array<{ close: () => Promise<void> }>} */
let opened = [];
beforeEach(() => { root = makeRoot('cretli-history-r3-'); opened = []; });
afterEach(async () => {
  for (const item of opened.reverse()) await item.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

const delta = (text) => ({
  kind: 'sdk', harness: 'test', event: { type: 'assistant', streamTextMode: 'delta', message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const textOf = (rec) => rec.event.message.content[0].text;
const bigRecs = (count, label) => Array.from({ length: count }, (_, index) => ({ rec: userRec(`${label}${index}:${'p'.repeat(40 * 1024)}`) }));
const textsOf = (events) => events.map((event) => event.rec.text.split(':')[0]);
const refusal = (kind, retryable = false) => new StorageError('conflict', 'refused', { retryable, details: { operation: 'history', conflictKind: kind, commitState: 'not_committed' } });

/** All stored events of a chat via the public pager. */
async function readAll(adapter, chat) {
  const out = [];
  for (let after = 0; ;) {
    const page = await adapter.getChatHistorySince(chat, after, 100);
    out.push(...page.events);
    if (!page.hasMore || page.events.length === 0) return out;
    after = page.events[page.events.length - 1].seq;
  }
}

describe('F7: read-back follows byte-truncated readSeqs', () => {
  it('real byte paging: 80 x 100 KiB deltas coalesce into 40 stored events, the result equals the stored records', async () => {
    let readSeqsCalls = 0;
    let truncatedPages = 0;
    const wrap = (store) => ({
      ...store,
      readSeqs: async (args) => {
        readSeqsCalls += 1;
        const page = await store.readSeqs(args);
        if (page.truncated) truncatedPages += 1;
        return page;
      },
    });
    const parts = await bootParts({ root, wrapStore: wrap });
    opened.push(parts);
    const chat = chatIdOf(1);
    const input = Array.from({ length: 80 }, (_, index) => ({ rec: delta(`${String.fromCharCode(97 + (index % 26))}${index}`.padEnd(100 * 1024, 'x')) }));
    const result = await parts.adapter.appendChatHistoryEvents(chat, 'c', input);
    assert.equal(result.ok, true);
    assert.equal(result.appended.length, 40, 'pairs coalesced up to the record cap');
    assert.ok(truncatedPages >= 1, 'the store really truncated by bytes');
    assert.ok(readSeqsCalls >= 2, 'follow-up reads were issued');
    const stored = await readAll(parts.adapter, chat);
    assert.deepEqual(result.appended.map((row) => row.seq), stored.map((row) => row.seq));
    for (const [index, row] of result.appended.entries()) {
      assert.deepEqual(row.rec, stored[index].rec, `appended seq ${row.seq} is the stored record`);
      assert.equal(textOf(row.rec).length, 200 * 1024, 'the coalesced content, not the 100 KiB input delta');
    }
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });

  it('mock: a truncated page is continued with the seqs it did not return', async () => {
    const seen = [];
    const wrap = (store) => ({
      ...store,
      readSeqs: async (args) => {
        seen.push(args.seqs.length);
        const page = await store.readSeqs({ ...args, seqs: args.seqs.slice(0, 1) });
        return { ...page, truncated: args.seqs.length > 1 };
      },
    });
    const parts = await bootParts({ root, wrapStore: wrap });
    opened.push(parts);
    const chat = chatIdOf(2);
    const result = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('a') }, { rec: userRec('b') }, { rec: userRec('c') }], { coalesce: false });
    assert.deepEqual(result.appended.map((row) => row.rec.text), ['a', 'b', 'c']);
    assert.deepEqual(seen, [3, 2, 1]);
  });

  it('mock: an accepted seq that disappeared is reported, never synthesised from the input; the committed plan is acknowledged', async () => {
    const wrap = (store) => ({ ...store, readSeqs: async (args) => ({ ...(await store.readSeqs(args)), events: [], truncated: false }) });
    const parts = await bootParts({ root, wrapStore: wrap });
    opened.push(parts);
    const chat = chatIdOf(3);
    const error = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('gone') }]).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_committed_readback_failed');
    assert.equal(error.details.commitState, 'committed');
    assert.equal(error.details.cause, 'history_seq_missing');
    assert.equal(error.details.resumable, false);
    assert.equal(error.details.acceptedSeqs.length, 1);
    assert.equal(parts.pendingBuffer.stats().entries, 0, 'a retry could not recover it, so the plan is closed');
    assert.deepEqual((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.map((row) => row.rec.text), ['gone'], 'committed exactly once');
  });

  it('mock: a truncated page without progress fails explicitly, keeps the plan and a retry completes it', async () => {
    let stuck = true;
    const wrap = (store) => ({ ...store, readSeqs: async (args) => (stuck ? { events: [], truncated: true } : store.readSeqs(args)) });
    const parts = await bootParts({ root, wrapStore: wrap });
    opened.push(parts);
    const chat = chatIdOf(4);
    const input = [{ rec: userRec('np') }];
    const error = await parts.adapter.appendChatHistoryEvents(chat, '', input).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_committed_readback_failed');
    assert.equal(error.details.cause, 'history_readback_no_progress');
    assert.equal(error.details.resumable, true);
    assert.equal(parts.pendingBuffer.stats().entries, 1);
    stuck = false;
    const done = await parts.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: error.details.retryToken });
    assert.deepEqual(done.appended.map((row) => row.rec.text), ['np']);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
  });
});

describe('F8: a not-committed plan is discarded durably before the caller hears "failed"', () => {
  /** Pending buffer whose bulk ack / quarantine fail on demand. */
  const faultyPending = (control) => (buffer) => ({
    ...buffer,
    ackMany: async (ids) => {
      if (control.failAck) throw new Error('ack io down');
      return buffer.ackMany(ids);
    },
    quarantineMany: async (ids, reason) => {
      if (control.failQuarantine === 'all') throw new Error('quarantine io down');
      if (control.failQuarantine === 'after-first') {
        await buffer.quarantine(ids[0], reason);
        throw new Error('quarantine io down');
      }
      return buffer.quarantineMany(ids, reason);
    },
  });
  const failFirstChunk = (state) => (store) => ({
    ...store,
    appendEvents: async (args) => {
      if (state.refuse) throw refusal('busy_for_test', true);
      return store.appendEvents(args);
    },
  });

  it('first chunk busy-exhausted + ack failure: explicit uncertainty with the token, retry commits at most once', async () => {
    const control = { failAck: true };
    const state = { refuse: true };
    const parts = await bootParts({ root, wrapStore: failFirstChunk(state), wrapPendingBuffer: faultyPending(control) });
    opened.push(parts);
    const chat = chatIdOf(5);
    const input = bigRecs(2, 'f');
    const error = await parts.adapter.appendChatHistoryEvents(chat, '', input).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_cleanup_uncertain');
    assert.equal(error.details.resumable, true);
    assert.equal(error.details.commitState, 'uncertain');
    assert.equal(typeof error.details.retryToken, 'string');
    assert.equal(parts.pendingBuffer.stats().entries, 2, 'the plan is kept');
    state.refuse = false;
    control.failAck = false;
    const done = await parts.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: error.details.retryToken });
    assert.equal(done.ok, true);
    assert.deepEqual(textsOf(await readAll(parts.adapter, chat)), ['f0', 'f1'], 'exactly one write');
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });

  it('same fault, then a restart: recovery replays the kept plan once and the old token is gone', async () => {
    const control = { failAck: true };
    const state = { refuse: true };
    const first = await bootParts({ root, wrapStore: failFirstChunk(state), wrapPendingBuffer: faultyPending(control) });
    const chat = chatIdOf(6);
    const input = bigRecs(2, 'g');
    const error = await first.adapter.appendChatHistoryEvents(chat, '', input).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_cleanup_uncertain');
    await first.close();
    const second = await bootParts({ root });
    opened.push(second);
    const recovery = await second.backend.recoverPending();
    assert.deepEqual([recovery.replayed, recovery.unresolved.length, recovery.quarantined.length], [2, 0, 0]);
    assert.deepEqual(textsOf(await readAll(second.adapter, chat)), ['g0', 'g1']);
    await assert.rejects(second.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: error.details.retryToken }), (cause) => cause.code === 'history_batch_unknown');
    assert.equal((await readAll(second.adapter, chat)).length, 2, 'never a second write');
  });

  it('F4: after a restart the loaded regular plan is frozen (get/list/listBatch): mutation throws, disk bytes stay canonical, recovery replays the original once', async () => {
    const control = { failAck: true };
    const state = { refuse: true };
    const first = await bootParts({ root, wrapStore: failFirstChunk(state), wrapPendingBuffer: faultyPending(control) });
    const chat = chatIdOf(14);
    const error = await first.adapter.appendChatHistoryEvents(chat, '', bigRecs(2, 'm')).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_cleanup_uncertain');
    await first.close();
    const entriesDir = path.join(root, 'pending', 'entries');
    const snapshot = () => Object.fromEntries(fs.readdirSync(entriesDir).sort().map((name) => [name, fs.readFileSync(path.join(entriesDir, name)).toString('base64')]));
    const before = snapshot();
    assert.equal(Object.keys(before).length, 2);
    const second = await bootParts({ root });
    opened.push(second);
    const listed = second.pendingBuffer.list();
    const views = [...listed, ...listed.map((row) => second.pendingBuffer.get(row.commandId)), ...second.pendingBuffer.listBatch(listed[0].batch.id)];
    for (const view of views) {
      assert.equal(Object.isFrozen(view), true);
      assert.equal(Object.isFrozen(view.payload), true);
      assert.throws(() => { view.payload.events[0].rec.text = 'tampered'; }, TypeError);
      assert.throws(() => { view.payload.events.push({}); }, TypeError);
    }
    assert.deepEqual(snapshot(), before, 'the canonical bytes are untouched');
    const recovery = await second.backend.recoverPending();
    assert.deepEqual([recovery.replayed, recovery.unresolved.length, recovery.quarantined.length], [2, 0, 0]);
    assert.deepEqual(textsOf(await readAll(second.adapter, chat)), ['m0', 'm1']);
    assert.equal(second.pendingBuffer.stats().entries, 0);
  });

  it('first chunk refused with a healthy cleanup: original error, nothing pending, nothing replayed after a restart', async () => {
    const state = { refuse: true };
    const first = await bootParts({ root, wrapStore: failFirstChunk(state) });
    const chat = chatIdOf(7);
    const error = await first.adapter.appendChatHistoryEvents(chat, '', bigRecs(2, 'h')).then(() => null, (cause) => cause);
    assert.equal(error.details.commitState, 'not_committed');
    assert.equal(first.pendingBuffer.stats().entries, 0);
    await first.close();
    const second = await bootParts({ root });
    opened.push(second);
    assert.deepEqual((await second.backend.recoverPending()).replayed, 0);
    assert.equal((await readAll(second.adapter, chat)).length, 0);
  });

  it('definitive refusal of a later chunk + quarantine failure: plan and prefix kept, resumable; a retry finishes the cleanup', async () => {
    const control = { failQuarantine: 'all' };
    const state = { calls: 0, armed: true };
    const wrap = (store) => ({
      ...store,
      appendEvents: async (args) => {
        state.calls += 1;
        if (state.armed && (state.calls === 2 || state.calls === 4)) throw refusal('history_producer_fenced');
        return store.appendEvents(args);
      },
    });
    const parts = await bootParts({ root, wrapStore: wrap, wrapPendingBuffer: faultyPending(control) });
    opened.push(parts);
    const chat = chatIdOf(8);
    const input = bigRecs(3, 'q');
    const error = await parts.adapter.appendChatHistoryEvents(chat, '', input).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_batch_incomplete');
    assert.equal(error.details.resumable, true, 'the rest is not yet out of the replay set');
    assert.equal(error.details.cleanup, 'failed');
    assert.equal(error.details.committedChunks, 1);
    assert.equal(error.details.acceptedSeqs.length, 1);
    assert.equal(parts.pendingBuffer.stats().entries, 3);
    control.failQuarantine = undefined;
    const again = await parts.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: error.details.retryToken }).then(() => null, (cause) => cause);
    assert.equal(again.code, 'history_batch_incomplete');
    assert.equal(again.details.resumable, false);
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    assert.deepEqual(textsOf(await readAll(parts.adapter, chat)), ['q0']);
  });

  it('quarantine failing after the first entry left the plan: not replayable, reported non-resumable, restart replays nothing', async () => {
    const control = { failQuarantine: 'after-first' };
    const state = { calls: 0 };
    const wrap = (store) => ({
      ...store,
      appendEvents: async (args) => {
        state.calls += 1;
        if (state.calls >= 2) throw refusal('history_producer_fenced');
        return store.appendEvents(args);
      },
    });
    const first = await bootParts({ root, wrapStore: wrap, wrapPendingBuffer: faultyPending(control) });
    const chat = chatIdOf(9);
    const error = await first.adapter.appendChatHistoryEvents(chat, '', bigRecs(3, 'z')).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_batch_incomplete');
    assert.equal(error.details.resumable, false);
    await first.close();
    const second = await bootParts({ root });
    opened.push(second);
    const recovery = await second.backend.recoverPending();
    assert.equal(recovery.replayed, 0, 'the leftover suffix is cleaned up, never replayed');
    assert.deepEqual(textsOf(await readAll(second.adapter, chat)), ['z0']);
  });

  it('single delete refused as not committed + ack failure: uncertain with commandId token; retry deletes once', async () => {
    const control = { failAck: false };
    const state = { refuse: false };
    const wrap = (store) => ({
      ...store,
      deleteChat: async (args) => {
        if (state.refuse) throw refusal('busy_for_test', true);
        return store.deleteChat(args);
      },
    });
    const parts = await bootParts({ root, wrapStore: wrap, wrapPendingBuffer: faultyPending(control) });
    opened.push(parts);
    const chat = chatIdOf(10);
    await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('keep') }]);
    state.refuse = true;
    control.failAck = true;
    const error = await parts.adapter.deleteChatHistory(chat).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_cleanup_uncertain');
    assert.equal(error.details.operation, 'deleteChat');
    assert.equal(error.details.retryToken, error.details.commandId);
    assert.equal(parts.pendingBuffer.stats().entries, 1);
    await assert.rejects(parts.adapter.deleteChatHistory(chatIdOf(11), { retryToken: error.details.retryToken }), (cause) => cause.code === 'history_batch_mismatch');
    state.refuse = false;
    control.failAck = false;
    await parts.adapter.deleteChatHistory(chat, { retryToken: error.details.retryToken });
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 0);
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    await assert.rejects(parts.adapter.deleteChatHistory(chat, { retryToken: error.details.retryToken }), (cause) => cause.code === 'history_batch_unknown');
  });

  it('single copy refused as not committed with a healthy cleanup: the refusal, nothing pending', async () => {
    const wrap = (store) => ({ ...store, copyChat: async () => { throw refusal('busy_for_test', true); } });
    const parts = await bootParts({ root, wrapStore: wrap });
    opened.push(parts);
    const error = await parts.adapter.copyChatHistory(chatIdOf(12), chatIdOf(13), 'c').then(() => null, (cause) => cause);
    assert.equal(error.details.commitState, 'not_committed');
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });
});
