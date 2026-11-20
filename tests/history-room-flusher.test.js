import './helpers/isolated-data-dir.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHistoryFlusher,
  discardBufferedHistory,
  flushAllBufferedHistory,
  settleHistoryFlushes,
} from '../lib/persist/history-room-flusher.js';
import { ChatHistoryAdapterError } from '../lib/persist/chat-history-errors.js';

const rec = (text) => ({ kind: 'localUser', text });
const item = (text) => ({ rec: rec(text) });
const makeRoom = (id = 'chat-1') => ({ chatId: id, sessionKey: `s-${id}`, _persistBuf: [] });
const refusal = (code, details = {}) => new ChatHistoryAdapterError(code, code, details);

/** Flusher over a scripted adapter: `script` entries are consumed per call (a function, an error or undefined = ok). */
function scripted(script) {
  const calls = [];
  const timers = [];
  const warnings = [];
  const flusher = createHistoryFlusher({
    append: async (room, items, callOptions) => {
      calls.push({ texts: items.map((entry) => entry.rec.text), callOptions: { ...callOptions } });
      const step = script.shift();
      if (step instanceof Error) throw step;
      if (typeof step === 'function') return step(items);
      return { ok: true };
    },
    warn: (message) => warnings.push(message),
    setTimer: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return { flusher, calls, timers, warnings };
}

describe('history room flusher (durable retention until ACK)', () => {
  // Rooms holding dead letters stay tracked (they are not durable); release the shared default chat between tests.
  afterEach(() => { for (const id of ['chat-1', 'chat-soft', 'chat-fenced', 'chat-dead', 'chat-stable', 'chat-debounce', 'doomed', 'shutdown-room']) discardBufferedHistory(id); });

  it('acknowledges a batch only after the adapter returned and empties the buffer', async () => {
    const { flusher, calls } = scripted([]);
    const room = makeRoom();
    room._persistBuf.push(item('a'), item('b'));
    const outcome = await flusher.flush(room);
    assert.deepEqual(outcome, { ok: true, pending: 0, deadLettered: 0 });
    assert.deepEqual(calls.map((call) => call.texts), [['a', 'b']]);
    assert.equal(room._persistInflight, null);
  });

  it('keeps the SAME records and the retry token after history_commit_unknown, and re-sends them unchanged', async () => {
    const { flusher, calls, timers } = scripted([refusal('history_commit_unknown', { retryToken: 'tok-1', resumable: true }), undefined]);
    const room = makeRoom();
    room._persistBuf.push(item('one'), item('two'));
    const first = await flusher.flush(room);
    assert.equal(first.ok, false);
    assert.equal(first.pending, 2, 'nothing was dropped');
    assert.equal(first.error.code, 'history_commit_unknown');
    assert.equal(timers.length, 1, 'a background retry is scheduled even without new records');
    // New records arrive while the first batch is uncertain: they must NOT overtake or merge into it.
    room._persistBuf.push(item('three'));
    const second = await flusher.flush(room);
    assert.equal(second.ok, true);
    assert.deepEqual(calls.map((call) => call.texts), [['one', 'two'], ['one', 'two'], ['three']]);
    assert.equal(calls[0].callOptions.retryToken, undefined);
    assert.equal(calls[1].callOptions.retryToken, 'tok-1');
    assert.equal(calls[2].callOptions.retryToken, undefined, 'the next batch is a new append');
  });

  it('retries an unknown failure without a token as the same batch (never loses the records)', async () => {
    const { flusher, calls } = scripted([new Error('worker went away'), new Error('still away'), undefined]);
    const room = makeRoom();
    room._persistBuf.push(item('x'));
    assert.equal((await flusher.flush(room)).ok, false);
    assert.equal((await flusher.flush(room)).ok, false);
    assert.equal((await flusher.flush(room)).ok, true);
    assert.deepEqual(calls.map((call) => call.texts), [['x'], ['x'], ['x']]);
  });

  it('runs the scheduled background retry and clears the timer once the batch is acknowledged', async () => {
    const { flusher, timers, calls } = scripted([refusal('history_commit_unknown', { retryToken: 't' }), undefined]);
    const room = makeRoom();
    room._persistBuf.push(item('bg'));
    await flusher.flush(room);
    assert.equal(timers.length, 1);
    timers[0].fn();
    await room._persistFlushChain;
    assert.equal(room._persistInflight, null);
    assert.equal(calls.length, 2);
    assert.equal(flusher.pending(room), 0);
  });

  it('serializes concurrent flushes of one room (one in-flight batch)', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const order = [];
    const flusher = createHistoryFlusher({
      append: async (_room, items) => {
        order.push(`start:${items.map((entry) => entry.rec.text)}`);
        if (items[0].rec.text === 'slow') await gate;
        order.push(`end:${items.map((entry) => entry.rec.text)}`);
      },
    });
    const room = makeRoom();
    room._persistBuf.push(item('slow'));
    const first = flusher.flush(room);
    await Promise.resolve();
    await Promise.resolve();
    room._persistBuf.push(item('later'));
    const second = flusher.flush(room);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['start:slow', 'end:slow', 'start:later', 'end:later']);
  });

  it('acknowledges exactly the committed prefix of a non-resumable partial commit and sets the rest aside', async () => {
    const { flusher, warnings } = scripted([refusal('history_batch_incomplete', { resumable: false, committedEvents: 2, committedChunks: 1, totalChunks: 2, retryToken: 'b' })]);
    const room = makeRoom();
    room._persistBuf.push(item('1'), item('2'), item('3'), item('4'));
    const outcome = await flusher.flush(room);
    assert.equal(outcome.ok, false, 'the dead-lettered remainder is not acknowledged');
    assert.equal(outcome.pending, 0, 'nothing is pending any more');
    assert.equal(outcome.deadLettered, 2);
    assert.deepEqual(room._persistDeadLetter[0].items.map((entry) => entry.rec.text), ['3', '4']);
    assert.equal(room._persistDeadLetter[0].code, 'history_batch_incomplete');
    assert.equal(warnings.length, 1, 'the loss is logged, not silent');
  });

  it('treats a resumable partial commit as retry with the SAME token and full input (no duplicate chunks)', async () => {
    const { flusher, calls } = scripted([refusal('history_batch_incomplete', { resumable: true, committedEvents: 1, retryToken: 'b9' }), undefined]);
    const room = makeRoom();
    room._persistBuf.push(item('p'), item('q'));
    await flusher.flush(room);
    await flusher.flush(room);
    assert.deepEqual(calls.map((call) => [call.texts, call.callOptions.retryToken]), [[['p', 'q'], undefined], [['p', 'q'], 'b9']]);
  });

  it('acknowledges a fully committed batch whose read-back is terminal (resumable:false)', async () => {
    const { flusher } = scripted([refusal('history_committed_readback_failed', { resumable: false, cause: 'history_stale_epoch', commitState: 'committed' })]);
    const room = makeRoom();
    room._persistBuf.push(item('committed'));
    const outcome = await flusher.flush(room);
    assert.equal(outcome.ok, true);
    assert.equal(room._persistDeadLetter, undefined, 'it IS stored; there is nothing to set aside');
  });

  it('bisects a permanent refusal down to the offending record and keeps its neighbours', async () => {
    const script = [];
    const flusher = createHistoryFlusher({
      append: async (_room, items) => {
        if (items.some((entry) => entry.rec.text === 'huge')) throw refusal('history_record_too_large', { commitState: 'not_committed' });
        script.push(items.map((entry) => entry.rec.text));
      },
      warn: () => {},
    });
    const room = makeRoom();
    room._persistBuf.push(item('a'), item('huge'), item('b'));
    const outcome = await flusher.flush(room);
    assert.equal(outcome.ok, false, 'the offending record was set aside, not acknowledged');
    assert.deepEqual(script, [['a'], ['b']], 'the good records were committed one by one, in order');
    assert.deepEqual(room._persistDeadLetter[0].items.map((entry) => entry.rec.text), ['huge']);
  });

  it('sets invalid records aside before they can poison a batch', async () => {
    const { flusher, calls } = scripted([]);
    const room = makeRoom();
    room._persistBuf.push({ rec: { kind: 'bogus' } }, item('ok'));
    const outcome = await flusher.flush(room);
    assert.equal(outcome.ok, false, 'the invalid record was never acknowledged');
    assert.deepEqual(calls.map((call) => call.texts), [['ok']]);
    assert.equal(room._persistDeadLetter[0].code, 'history_record_invalid');
  });

  it('sets a batch aside as unknown when its retry token no longer identifies a plan', async () => {
    const { flusher, warnings } = scripted([refusal('history_batch_unknown', { retryToken: 'gone' })]);
    const room = makeRoom();
    room._persistBuf.push(item('u'));
    const outcome = await flusher.flush(room);
    assert.equal(outcome.ok, false, 'commit state unknown: not an acknowledgement');
    assert.equal(room._persistDeadLetter[0].code, 'history_batch_unknown');
    assert.equal(warnings.length, 1);
  });

  it('splits a very large buffer into bounded calls', async () => {
    const sizes = [];
    const flusher = createHistoryFlusher({ append: async (_room, items) => { sizes.push(items.length); } });
    const room = makeRoom();
    for (let index = 0; index < 1300; index += 1) room._persistBuf.push(item(`m${index}`));
    await flusher.flush(room);
    assert.deepEqual(sizes, [512, 512, 276]);
  });

  it('chat delete: waits for in-flight flushes and drops what a failing flush still retains', async () => {
    const { flusher } = scripted([new Error('down'), new Error('down')]);
    const room = makeRoom('doomed');
    room._persistBuf.push(item('keep-failing'));
    await flusher.flush(room);
    assert.equal(flusher.pending(room), 1);
    await settleHistoryFlushes('doomed');
    assert.equal(discardBufferedHistory('doomed'), 1);
    assert.equal(flusher.pending(room), 0);
    assert.equal(room._persistRetryTimer, null);
  });

  it('shutdown barrier reports what is still uncommitted', async () => {
    const { flusher } = scripted([new Error('down'), new Error('down')]);
    const room = makeRoom('shutdown-room');
    room._persistBuf.push(item('stuck'));
    room._flushHistory = () => flusher.flush(room);
    await flusher.flush(room);
    const barrier = await flushAllBufferedHistory({ timeoutMs: 200 });
    assert.equal(barrier.ok, false);
    assert.ok(barrier.pending >= 1);
    discardBufferedHistory('shutdown-room');
  });

  it('registers a room at enqueue so shutdown flushes a debounce-only buffer, and delete never resurrects it', async () => {
    const { flusher, calls } = scripted([]);
    const room = makeRoom('chat-debounce');
    room._persistBuf.push(item('late'));
    assert.equal(flusher.enqueue(room), true);
    const barrier = await flushAllBufferedHistory({ timeoutMs: 500 });
    assert.equal(barrier.ok, true);
    assert.deepEqual(calls.map((call) => call.texts), [['late']]);
    const doomed = makeRoom('chat-doomed');
    doomed._persistBuf.push(item('x'));
    flusher.enqueue(doomed);
    assert.equal(discardBufferedHistory('chat-doomed'), 1);
    assert.equal(flusher.enqueue(doomed), false);
    doomed._persistBuf.push(item('y'));
    await flusher.flush(doomed);
    assert.equal(calls.length, 1, 'no append after delete');
  });

  it('retries the exact original bytes even when the caller mutates its record between attempts', async () => {
    const { flusher, calls } = scripted([refusal('history_commit_unknown', { retryToken: 'tok-m', resumable: true }), undefined]);
    const room = makeRoom('chat-stable');
    const original = item('a');
    room._persistBuf.push(original);
    await flusher.flush(room);
    original.rec.text = 'b';
    await flusher.flush(room);
    assert.deepEqual(calls.map((call) => call.texts), [['a'], ['a']]);
    assert.equal(calls[1].callOptions.retryToken, 'tok-m');
  });

  it('does not acknowledge an explicit { ok: false } append result', async () => {
    const { flusher } = scripted([() => ({ ok: false, code: 'history_busy' })]);
    const room = makeRoom('chat-soft');
    room._persistBuf.push(item('keep'));
    const outcome = await flusher.flush(room);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.pending, 1);
    assert.equal(outcome.error.code, 'history_busy');
    assert.equal(room._persistInflight.items[0].rec.text, 'keep');
  });

  it('treats history_producer_fenced as terminal: input kept, no retry timer, no further append', async () => {
    const { flusher, calls, timers } = scripted([refusal('history_producer_fenced')]);
    const room = makeRoom('chat-fenced');
    room._persistBuf.push(item('f'));
    const first = await flusher.flush(room);
    assert.equal(first.ok, false);
    assert.equal(timers.length, 0);
    const second = await flusher.flush(room);
    assert.equal(second.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(second.pending, 1);
  });

  it('never evicts dead letters: a full list blocks the drain and keeps the next input buffered', async () => {
    const { flusher, calls } = scripted([]);
    const room = makeRoom('chat-dead');
    room._persistDeadLetter = Array.from({ length: 50 }, (_, n) => ({ code: 'x', items: [item(`d${n}`)] }));
    room._persistBuf.push(item('next'));
    const outcome = await flusher.flush(room);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'history_dead_letter_full');
    assert.equal(room._persistDeadLetter.length, 50);
    assert.equal(room._persistBuf.length, 1);
    assert.equal(calls.length, 0);
  });

  it('P7: a soft permanent refusal / permanent throw / unknown batch is never ok, on the next flush and at shutdown', async () => {
    const soft = createHistoryFlusher({ append: async () => ({ ok: false, code: 'history_unnamespaced_input' }), warn() {} });
    const room = makeRoom('chat-p7');
    room._persistBuf.push(item('x'));
    const first = await soft.flush(room);
    assert.equal(first.ok, false);
    assert.equal(first.deadLettered, 1);
    assert.equal(room._persistBuf.length, 0);
    assert.equal(room._persistDeadLetter.length, 1);
    const next = await soft.flush(room);
    assert.equal(next.ok, false, 'an empty follow-up flush must not launder the dead letter');
    assert.equal(next.error.code, 'history_dead_lettered');
    const barrier = await flushAllBufferedHistory({ timeoutMs: 500 });
    assert.equal(barrier.ok, false);
    assert.ok(barrier.deadLettered >= 1);
    const thrown = scripted([refusal('history_record_too_large')]);
    const room2 = makeRoom('chat-p7b');
    room2._persistBuf.push(item('y'));
    assert.equal((await thrown.flusher.flush(room2)).ok, false);
    const missing = scripted([refusal('history_batch_unknown', { retryToken: 't' })]);
    const room3 = makeRoom('chat-p7c');
    room3._persistBuf.push(item('z'));
    assert.equal((await missing.flusher.flush(room3)).ok, false);
    discardBufferedHistory('chat-p7');
    discardBufferedHistory('chat-p7b');
    discardBufferedHistory('chat-p7c');
    assert.equal((await flushAllBufferedHistory({ timeoutMs: 500 })).ok, true, 'an explicit discard resolves the dead letters');
  });
});
