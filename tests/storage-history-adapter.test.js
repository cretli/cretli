import { scratchDataDir } from './fixtures/storage-history-scratch-data.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FAULT_HANDLERS_PATH, GENERATION, assistantRec, bootParts, chatIdOf, makeCoordinator, makeRoot, userRec,
} from './fixtures/storage-history-adapter-harness.js';

const { createDefaultLegacyHistoryAdapter } = await import('../lib/persist/chat-history-backend-legacy.js');
const { HISTORY_MAX_LARGE_RECORD_BYTES } = await import('../lib/storage/chat-history-store.js');

assert.ok(scratchDataDir.includes('cretli-history-scratch-data-'), 'legacy persistence must run on scratch data');

/** @type {string} */
let root;
/** @type {Awaited<ReturnType<typeof bootParts>>[]} */
let booted;

beforeEach(() => {
  root = makeRoot();
  booted = [];
});
afterEach(async () => {
  for (const parts of booted) await parts.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {Parameters<typeof bootParts>[0]} [options] */
async function boot(options = {}) {
  const parts = await bootParts({ root, ...options });
  booted.push(parts);
  return parts;
}

/** Drop wall-clock fields so two backends can be compared. */
function normalize(value) {
  // `committed`, `replayed`, `receipts` and `duplicates` are the SQLite ACK evidence legacy cannot give; `identity` is the
  // per-chat generation/epoch/revision a SQLite read or write reports (legacy files have none).
  const ackOnly = new Set(['updatedAt', 'committed', 'replayed', 'receipts', 'duplicates', 'identity']);
  return JSON.parse(JSON.stringify(value, (key, item) => (ackOnly.has(key) ? undefined : item)));
}

const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const T3 = '2026-01-01T00:00:03.000Z';
const usageRec = (input, extra = {}) => ({ kind: 'sdk', harness: 'test', event: { type: 'usage', usage: { inputTokens: input, outputTokens: 5, totalTokens: input + 5, cacheReadTokens: 10 }, ...extra } });
const contextRec = { kind: 'sdk', harness: 'test', event: { type: 'context_usage', usage: { totalTokens: 321 }, model: 'm-1', contextWindowTokens: 1000 } };
const errorRec = { kind: 'sdk', harness: 'test', event: { type: 'status', status: 'error', message: 'boom' } };
const thinkingRec = (text) => ({ kind: 'sdk', event: { type: 'thinking', text } });

/**
 * One scripted conversation, run against any adapter. Every observable result
 * is returned so legacy and SQLite can be compared field by field.
 * @param {ReturnType<typeof createDefaultLegacyHistoryAdapter>} api
 */
async function runScenario(api) {
  const [A, B, C] = [chatIdOf(1), chatIdOf(2), chatIdOf(3)];
  const out = {};
  out.append1 = await api.appendChatHistoryEvents(A, 'cursor-1', [
    { rec: userRec('first', T1) }, { rec: assistantRec('Hel') }, { rec: assistantRec('lo ') }, { rec: assistantRec('world') },
    { rec: thinkingRec('hmm') }, { rec: usageRec(100) }, { rec: userRec('second', T2) }, { rec: assistantRec('answer', 'snapshot') },
    { rec: contextRec }, { rec: usageRec(300, { lastCallUsage: { totalTokens: 120 }, lastCallModel: 'm-2', lastCallContextWindowTokens: 2000 }) },
  ]);
  // The next delta merges into the retained tail of the previous call (legacy and store agree for one producer).
  out.append2 = await api.appendChatHistoryEvents(A, 'cursor-2', [{ rec: assistantRec('!') }, { rec: errorRec }, { rec: userRec('third', T3) }]);
  out.since0 = await api.getChatHistorySince(A, 0, 1000);
  out.since3 = await api.getChatHistorySince(A, 3, 2);
  out.sinceEnd = await api.getChatHistorySince(A, 9999, 10);
  out.missing = await api.getChatHistorySince(chatIdOf(99), 0, 10);
  out.event2 = await api.getChatHistoryEvent(A, 2);
  out.eventGap = await api.getChatHistoryEvent(A, 500);
  out.page = await api.getChatHistoryPage(A, { limit: 3 });
  out.pageBefore = await api.getChatHistoryPage(A, { beforeSeq: out.page.events[0].seq, limit: 2 });
  out.http = await api.readChatHistoryFromHttpQuery(A, { tail: '4' });
  out.httpSeq = await api.readChatHistoryFromHttpQuery(A, { seq: '3' });
  out.batch = await api.readChatHistoryBatch([{ id: A, since: 1, limit: 3 }, { id: 'not-allowed' }, { id: B }], new Set([A, B]));
  // The legacy loader hands out its cache entry, which later appends mutate in place: snapshot it.
  const loaded = structuredClone(await api.loadChatHistory(A));
  out.usage = loaded.usageSummary;
  out.loaded = { cursorSessionId: loaded.cursorSessionId, headSeq: loaded.headSeq, events: loaded.events };
  out.usageApi = (await api.getChatHistoryUsage(A)).usageSummary;
  out.copy = await api.copyChatHistory(A, B, 'cursor-b');
  out.copyUntil = await api.copyChatHistoryUntil(A, C, 'cursor-c', T2);
  out.copyB = structuredClone(await api.loadChatHistory(B));
  out.appendB = await api.appendChatHistoryEvents(B, '', [{ rec: userRec('after fork') }]);
  out.heads = await api.listChatHistoryHeadSeqs();
  await api.deleteChatHistory(C);
  out.afterDelete = await api.getChatHistorySince(C, 0, 10);
  out.headsAfterDelete = Object.keys(await api.listChatHistoryHeadSeqs()).sort();
  out.notice = await api.appendChatNotice(A, 'Cycle started', { action: 'cycle', level: 'info', at: T3 });
  out.noticeEmpty = await api.appendChatNotice(A, '   ');
  out.invalid = await api.appendChatHistoryEvents('../evil', '', [{ rec: userRec('x') }]);
  out.invalidRec = await api.appendChatHistoryEvents(A, '', [{ rec: { kind: 'nope' } }]);
  return out;
}

describe('parity with the legacy history backend', () => {
  it('returns the same observable results for a scripted conversation (seq, gaps, coalescing, pages, usage, fork, delete)', async () => {
    const legacy = createDefaultLegacyHistoryAdapter();
    const { adapter } = await boot();
    const expected = normalize(await runScenario(legacy));
    const actual = normalize(await runScenario(adapter));
    for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], `scenario step ${key}`);
    // Sanity of the fixture itself: it exercises coalescing gaps and a partial fork.
    assert.ok(expected.since0.headSeq > expected.since0.events.length - 1);
    assert.equal(expected.copyUntil.ok, true);
  });

  it('extends a tail page to the opening user turn and a stream boundary exactly like legacy, reading older rows in chunks', async () => {
    const legacy = createDefaultLegacyHistoryAdapter();
    const { adapter } = await boot();
    const toolRec = (n) => ({ kind: 'sdk', event: { type: 'tool_call', name: `tool-${n}` } });
    const build = async (api, chat) => {
      // Two turns; the second run has 300 fragments, so a 3-event tail needs several 250-event older chunks.
      await api.appendChatHistoryEvents(chat, 's', [{ rec: userRec('turn 1') }, { rec: toolRec(0) }, { rec: userRec('turn 2') }]);
      for (let batch = 0; batch < 6; batch += 1) {
        await api.appendChatHistoryEvents(chat, 's', Array.from({ length: 50 }, (_, i) => ({ rec: toolRec(batch * 50 + i) })));
      }
      // A thinking stream split by a tool call so stream coalescing leaves several same-kind neighbours.
      await api.appendChatHistoryEvents(chat, 's', [{ rec: toolRec(900) }, { rec: thinkingRec('a') }, { rec: toolRec(901) }, { rec: toolRec(902) }]);
      return { tail: await api.getChatHistoryPage(chat, { limit: 3 }), mid: await api.getChatHistoryPage(chat, { limit: 5, beforeSeq: 100 }) };
    };
    const [a, b] = [chatIdOf(5), chatIdOf(6)];
    const expected = normalize(await build(legacy, a));
    const actual = normalize(await build(adapter, b));
    assert.deepEqual(actual.tail.events.map((e) => e.seq), expected.tail.events.map((e) => e.seq));
    assert.deepEqual(actual.mid.events.map((e) => e.seq), expected.mid.events.map((e) => e.seq));
    assert.deepEqual([actual.tail.oldestSeq, actual.tail.hasOlder, actual.mid.hasOlder], [expected.tail.oldestSeq, expected.tail.hasOlder, expected.mid.hasOlder]);
    assert.ok(expected.tail.events.length > 100, 'the fixture really forces an extension past one chunk');
    assert.equal(actual.tail.events[0].rec.text, 'turn 2', 'the page opens at the user turn of its run');
  });

  it('keeps the legacy shapes for hostile chat ids without reaching the store', async () => {
    const { adapter } = await boot();
    assert.deepEqual(await adapter.appendChatHistoryEvents('../x', '', []), { ok: false, error: 'Invalid chatId', code: 'history_invalid_chat_id', chatId: '../x' });
    assert.equal(await adapter.loadChatHistory('a/b'), null);
    assert.deepEqual(await adapter.getChatHistorySince('a/b', 0, 5), { ok: true, chatId: 'a/b', cursorSessionId: '', headSeq: 0, events: [], hasMore: false });
    assert.equal(adapter.backendKind, 'sqlite');
  });

  it('pages a very large retained window by bytes and keeps 2000-event retention without cutting records', async () => {
    const { adapter, store, backend } = await boot();
    const chat = chatIdOf(7);
    for (let batch = 0; batch < 9; batch += 1) {
      await adapter.appendChatHistoryEvents(chat, '', Array.from({ length: 250 }, (_, i) => ({ rec: userRec(`m${batch * 250 + i}`) })));
    }
    const all = await adapter.getChatHistorySince(chat, 0, 2000);
    assert.equal(all.events.length, 2000, 'retention keeps the newest 2000');
    assert.equal(all.events[0].seq, 251);
    assert.equal(all.headSeq, 2250);
    const big = 'x'.repeat(240 * 1024);
    for (let i = 0; i < 20; i += 1) await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec(`${i}:${big}`) }]);
    const since = await adapter.getChatHistorySince(chat, 0, 2000);
    assert.equal(since.hasMore, true, 'a byte-bounded page reports more instead of exceeding the worker result limit');
    assert.ok(Buffer.byteLength(JSON.stringify(since)) < 4 * 1024 * 1024);
    // A full load above its cap is a typed refusal, not a silent cut.
    await assert.rejects(adapter.loadChatHistory(chat, { maxBytes: 1024 * 1024 }), (error) => error.code === 'history_load_too_large');
    const loaded = await adapter.loadChatHistory(chat, { maxBytes: 64 * 1024 * 1024 });
    assert.equal(loaded.events.length, 2000);
    assert.equal(store.constructor, Object);
    assert.equal(typeof backend.diagnose().pending.entries, 'number');
  });
});

describe('metadata contract (cursorSessionId, updatedAt, deletion, fork)', () => {
  it('stores and replaces cursorSessionId, keeps it across empty cursors and resets it on fork/delete', async () => {
    const { adapter, store } = await boot();
    const chat = chatIdOf(10);
    await adapter.appendChatHistoryEvents(chat, 'session-1', [{ rec: userRec('a') }]);
    assert.equal((await adapter.getChatHistorySince(chat, 0, 10)).cursorSessionId, 'session-1');
    await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('b') }]);
    assert.equal((await adapter.getChatHistorySince(chat, 0, 10)).cursorSessionId, 'session-1', 'an empty cursor does not clear it');
    await adapter.appendChatHistoryEvents(chat, 'session-2', [{ rec: userRec('c') }]);
    assert.equal((await adapter.getChatHistoryPage(chat, { limit: 5 })).cursorSessionId, 'session-2');
    const forkId = chatIdOf(11);
    await adapter.copyChatHistory(chat, forkId, 'forked-session');
    assert.equal((await adapter.getChatHistorySince(forkId, 0, 10)).cursorSessionId, 'forked-session');
    await adapter.deleteChatHistory(chat);
    assert.equal((await adapter.getChatHistorySince(chat, 0, 10)).cursorSessionId, '');
    assert.equal(await adapter.loadChatHistory(chat), null, 'a deleted chat loads as missing');
    assert.equal(Object.hasOwn(await adapter.listChatHistoryHeadSeqs(), chat), false);
    const row = await store.readRevision({ datasetGeneration: GENERATION, chatId: chat, chatEpoch: 'x', anyEpoch: true });
    assert.equal(row.deleted, true, 'the tombstone keeps the chat identity so stale writers stay fenced');
    await assert.rejects(adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('late write of the deleted chat') }]),
      (error) => error.details?.conflictKind === 'history_producer_fenced');
  });

  it('refuses an oversized cursorSessionId atomically', async () => {
    const { adapter } = await boot();
    await assert.rejects(adapter.appendChatHistoryEvents(chatIdOf(12), 'x'.repeat(5000), [{ rec: userRec('a') }]), (error) => error.details?.conflictKind === 'history_invalid_cursor_session');
    assert.equal((await adapter.getChatHistorySince(chatIdOf(12), 0, 10)).events.length, 0);
  });

  it('reports a fork as a copy that keeps seq and headSeq but strips queue clientSeq', async () => {
    const { adapter } = await boot();
    const chat = chatIdOf(13);
    await adapter.appendChatHistoryEvents(chat, 's', [{ rec: userRec('seed') }]);
    const pinA = (await adapter.getChatHistorySince(chat, 0, 1)).identity;
    await adapter.appendChatHistoryEvents(chat, 's', [{ rec: userRec('q1'), clientSeq: 7 }, { rec: userRec('q2'), clientSeq: 8 }], { queueProducerId: 'queue-device-a', datasetGeneration: pinA.datasetGeneration, chatEpoch: pinA.chatEpoch });
    const source = await adapter.getChatHistorySince(chat, 0, 10);
    assert.deepEqual(source.events.map((event) => event.rec.clientSeq), [undefined, 7, 8], 'the live browser needs its clientSeq to match acks');
    await adapter.copyChatHistory(chat, chatIdOf(14), 's2');
    const fork = await adapter.getChatHistorySince(chatIdOf(14), 0, 10);
    assert.deepEqual(fork.events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(fork.events.some((event) => 'clientSeq' in event.rec), false);
    assert.equal(fork.headSeq, 3);
  });
});

describe('producer identity, namespaced inputs and idempotency', () => {
  it('refuses un-namespaced client inputs instead of replaying them and dedupes per producer', async () => {
    const { adapter } = await boot();
    const chat = chatIdOf(20);
    const refused = await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('old queue'), clientSeq: 1 }]);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'history_unnamespaced_input');
    assert.equal((await adapter.getChatHistorySince(chat, 0, 10)).events.length, 0, 'nothing was written');
    await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('seed') }]);
    const pin = (await adapter.getChatHistorySince(chat, 0, 1)).identity;
    const pinned = (queueProducerId) => ({ queueProducerId, datasetGeneration: pin.datasetGeneration, chatEpoch: pin.chatEpoch });
    await assert.rejects(adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('x'), clientSeq: 1 }], { queueProducerId: 'queue-A' }),
      (error) => error.code === 'history_stale_client_identity' && error.details.commitState === 'not_committed', 'no generation/epoch: refused, never auto-adopted');
    await assert.rejects(adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('x'), clientSeq: 1 }], { queueProducerId: 'queue-A', chatEpoch: pin.chatEpoch }),
      (error) => error.code === 'history_stale_client_identity', 'epoch without generation is refused');
    await assert.rejects(adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('x'), clientSeq: 1 }], { queueProducerId: 'queue-A', datasetGeneration: pin.datasetGeneration }),
      (error) => error.code === 'history_stale_client_identity', 'generation without epoch is refused');
    const first = await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('x'), clientSeq: 1 }], pinned('queue-A'));
    const again = await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('x'), clientSeq: 1 }], pinned('queue-A'));
    const other = await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('y'), clientSeq: 1 }], pinned('queue-B'));
    assert.equal(first.appended[0].seq, again.appended[0].seq, 'the same producer input is one event');
    assert.equal(again.duplicates, 1);
    assert.notEqual(other.appended[0].seq, first.appended[0].seq, 'another producer with the same counter is another input');
    await assert.rejects(adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('changed'), clientSeq: 1 }], pinned('queue-A')),
      (error) => error.details?.conflictKind === 'history_input_digest_mismatch');
    const mixed = await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('a'), clientSeq: 2 }, { rec: userRec('b') }], pinned('queue-A'));
    assert.equal(mixed.code, 'history_unnamespaced_input');
  });

  it('allocates durable server clientSeq per producer and never shows it to readers', async () => {
    const { adapter, pendingBuffer, store } = await boot();
    const chat = chatIdOf(21);
    await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('a') }, { rec: userRec('b') }], { producerId: 'server:run:r1:attempt:a1' });
    await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('c') }], { producerId: 'server:run:r1:attempt:a1' });
    const page = await store.readPage({ datasetGeneration: GENERATION, chatId: chat, chatEpoch: 'x', anyEpoch: true, limit: 10 });
    assert.deepEqual(page.events.map((event) => event.clientSeq), [0, 1, 2], 'one monotonic counter per producer');
    assert.equal(page.events.every((event) => event.producerId === 'server:run:r1:attempt:a1'), true);
    const read = await adapter.getChatHistorySince(chat, 0, 10);
    assert.equal(read.events.some((event) => 'clientSeq' in event.rec), false);
    assert.equal(pendingBuffer.stats().entries, 0, 'acknowledged commands leave the pending buffer');
    await assert.rejects(adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('d') }], { producerId: 'queue-not-server' }).then((r) => { if (r.ok === false) throw Object.assign(new Error(r.error), { code: r.code }); }),
      (error) => error.code === 'history_unnamespaced_input');
  });

  it('reports each notification only after the durable commit', async () => {
    const seen = [];
    const { adapter, pendingBuffer } = await boot({ onCommitted: (event) => { seen.push({ ...event, pendingAtNotify: pendingBuffer.stats().entries }); } });
    const chat = chatIdOf(22);
    const result = await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('n') }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].operation, 'append');
    assert.equal(seen[0].headSeq, result.headSeq);
    assert.equal(seen[0].pendingAtNotify, 0, 'notification follows the ACK and the pending cleanup');
    assert.equal(result.committed, true);
    assert.equal(result.receipts[0].datasetGeneration, GENERATION);
  });
});

describe('group commit with 64-256 KiB records', () => {
  it('commits concurrent large records through the group committer and refuses one above the 3 MiB large-record cap atomically', async () => {
    const { adapter, pendingBuffer } = await boot();
    const sizes = [64, 100, 160, 200, 250].map((kib) => kib * 1024);
    const chats = sizes.map((_, index) => chatIdOf(30 + index));
    const results = await Promise.all(sizes.map((size, index) => adapter.appendChatHistoryEvents(chats[index], '', [{ rec: userRec(`s${index}:${'z'.repeat(size)}`) }])));
    assert.equal(results.every((result) => result.ok && result.committed), true);
    for (const [index, size] of sizes.entries()) {
      const read = await adapter.getChatHistorySince(chats[index], 0, 10);
      assert.equal(read.events.length, 1);
      assert.ok(read.events[0].rec.text.length >= size);
    }
    const tooBig = chatIdOf(40);
    await assert.rejects(adapter.appendChatHistoryEvents(tooBig, '', [{ rec: userRec('y'.repeat(HISTORY_MAX_LARGE_RECORD_BYTES + 1024)) }]),
      (error) => ['history_record_too_large', 'history_command_too_large'].includes(error.details?.conflictKind) || error.code === 'history_pending_entry_too_large');
    assert.equal((await adapter.getChatHistorySince(tooBig, 0, 10)).events.length, 0, 'no truncation and no partial write');
    assert.equal(pendingBuffer.stats().entries, 0, 'a known-not-committed refusal does not stay pending');
    // A batch whose total exceeds the 64 KiB command budget is split into several durable commands, in order.
    const many = await adapter.appendChatHistoryEvents(chatIdOf(41), '', Array.from({ length: 10 }, (_, i) => ({ rec: userRec(`${i}:${'q'.repeat(30 * 1024)}`) })));
    assert.equal(many.appended.length, 10);
    assert.equal(many.receipts.length > 1, true);
    assert.deepEqual((await adapter.getChatHistorySince(chatIdOf(41), 0, 100)).events.map((event) => event.rec.text.split(':')[0]), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
});

describe('retry after unknown commit, lost replies and worker crashes', () => {
  /** @param {string} mode */
  function armOnce(mode) {
    let armed = true;
    return (store, host) => ({
      ...store,
      appendEvents: async (args) => {
        if (armed) {
          armed = false;
          await host.command('test.arm', { commandId: args.commandId, mode });
        }
        return store.appendEvents(args);
      },
    });
  }

  it('worker killed after COMMIT before the reply: resolved from the receipt, exactly one event', async () => {
    const parts = await boot({ handlersPath: FAULT_HANDLERS_PATH, faultInjection: true, wrapStore: armOnce('afterCommitExit') });
    const chat = chatIdOf(50);
    const result = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('committed before the crash') }]);
    assert.equal(result.ok, true);
    assert.equal(result.replayed, true, 'the answer came from the receipt');
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
    assert.equal((await parts.host.query('test.counts')).receipts, 1);
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });

  it('worker killed BEFORE commit: proven not committed, the same command is retried once', async () => {
    const parts = await boot({ handlersPath: FAULT_HANDLERS_PATH, faultInjection: true, wrapStore: armOnce('beforeCommitExit') });
    const chat = chatIdOf(51);
    const result = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('survives a crash before commit') }]);
    assert.equal(result.ok, true);
    assert.equal(result.replayed, false);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
    const attempts = await parts.host.query('test.attempts');
    const commandIds = new Set(attempts.map((attempt) => attempt.commandId));
    assert.equal(commandIds.size, 1, 'every attempt used the identity fixed before dispatch');
  });

  it('a pending command replayed after a restart (reply lost with the process) cannot duplicate', async () => {
    const first = await boot();
    const chat = chatIdOf(52);
    const [producer] = ['server:run:crash:attempt:1'];
    const clientSeq = await first.pendingBuffer.reserveClientSeq(producer, 1);
    const payload = {
      datasetGeneration: GENERATION, chatId: chat, chatEpoch: 'ep.manual', producerId: producer,
      events: [{ clientSeq, rec: userRec('exactly once') }], coalesce: true,
    };
    const entry = await first.pendingBuffer.record({ commandId: 'hist.append.manual-1', producerId: producer, operation: 'appendEvents', chatId: chat, payload });
    // The command commits, then the process dies before the pending entry is removed.
    await first.baseStore.appendEvents({ ...payload, commandId: entry.commandId });
    await first.close();
    booted.splice(booted.indexOf(first), 1);
    const second = await boot();
    assert.equal(second.pendingBuffer.stats().entries, 1, 'the entry survived the restart');
    const summary = await second.backend.recoverPending();
    assert.deepEqual({ replayed: summary.replayed, committed: summary.committed, quarantined: summary.quarantined.length }, { replayed: 1, committed: 0, quarantined: 0 });
    assert.equal((await second.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
    assert.equal(second.pendingBuffer.stats().entries, 0);
    // Replaying again is a no-op.
    assert.equal((await second.backend.recoverPending()).replayed, 0);
  });

  it('a pending command that never reached the worker is committed exactly once by recovery, with its notification', async () => {
    const notified = [];
    const first = await boot();
    const chat = chatIdOf(53);
    const producer = 'server:run:never:attempt:1';
    const payload = { datasetGeneration: GENERATION, chatId: chat, chatEpoch: 'ep.never', producerId: producer, events: [{ clientSeq: 0, rec: userRec('never dispatched') }], coalesce: true };
    await first.pendingBuffer.record({ commandId: 'hist.append.never-1', producerId: producer, operation: 'appendEvents', chatId: chat, payload });
    await first.close();
    booted.splice(booted.indexOf(first), 1);
    const second = await boot({ onCommitted: (event) => notified.push(event) });
    const summary = await second.backend.recoverPending();
    assert.equal(summary.committed, 1);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].recovered, true);
    assert.equal((await second.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
  });

  it('an unreconcilable commit outcome keeps the command pending and says so', async () => {
    const parts = await boot({
      wrapStore: (store) => ({
        ...store,
        appendEvents: async () => { throw Object.assign(new Error('lost'), { code: 'unknown_commit', details: { commitState: 'unknown' } }); },
        resolveUnknown: async () => { throw Object.assign(new Error('no receipt path'), { code: 'unknown_commit', details: { reconcilable: false } }); },
      }),
    });
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chatIdOf(54), '', [{ rec: userRec('unsure') }]), (error) => error.code === 'history_commit_unknown');
    assert.equal(parts.pendingBuffer.stats().entries, 1, 'never dropped while the outcome is unknown');
    assert.equal(parts.adapter.diagnose().pending.entries, 1);
  });
});

describe('stale generation / epoch, fencing and startup barrier', () => {
  it('refuses a pinned stale epoch and a stale generation without committing anything', async () => {
    const { adapter, store } = await boot();
    const chat = chatIdOf(60);
    await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('one') }]);
    const state = await store.readRevision({ datasetGeneration: GENERATION, chatId: chat, chatEpoch: 'x', anyEpoch: true });
    await store.reset({ datasetGeneration: GENERATION, chatId: chat, chatEpoch: state.chatEpoch, commandId: 'reset-1', newChatEpoch: 'epoch-after-reset' });
    await assert.rejects(adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('stale') , clientSeq: 1 }], { queueProducerId: 'queue-old', datasetGeneration: GENERATION, chatEpoch: state.chatEpoch }),
      (error) => error.details?.conflictKind === 'history_stale_epoch');
    // The server's own producer was fenced by the reset: its next write is refused until a new producer is used.
    await assert.rejects(adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('fenced') }]), (error) => error.details?.conflictKind === 'history_producer_fenced');
    const fresh = await adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('new producer') }], { producerId: 'server:run:after-reset:attempt:1' });
    assert.equal(fresh.appended[0].seq, 1, 'a reset restarts sequence numbering under the new epoch');
    const wrongGeneration = (await bootOther(store, 'gen-other-9'));
    await assert.rejects(wrongGeneration.appendChatHistoryEvents(chat, '', [{ rec: userRec('other generation') }], { producerId: 'server:run:g:attempt:1' }), (error) => error.code === 'history_generation_mismatch');
    assert.equal((await adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
  });

  /** @param {object} store @param {string} generation */
  async function bootOther(store, generation) {
    const { createSqliteHistoryBackend } = await import('../lib/persist/chat-history-backend-sqlite.js');
    const { createHistoryPendingBuffer } = await import('../lib/persist/history-pending-buffer.js');
    const { createChatHistoryAdapter } = await import('../lib/persist/chat-history-adapter.js');
    const pendingBuffer = createHistoryPendingBuffer({ dir: path.join(root, `pending-${generation}`) });
    await pendingBuffer.open();
    return createChatHistoryAdapter({ backend: createSqliteHistoryBackend({ store, datasetGeneration: generation, pendingBuffer }), kind: 'sqlite' });
  }

  it('a zombie owner (taken over by a newer coordinator) cannot commit', async () => {
    const control = path.join(root, 'control');
    const alive = new Set([1111, 2222]);
    const a = makeCoordinator(control, { pid: 1111, alive });
    const b = makeCoordinator(control, { pid: 2222, alive });
    const parts = await boot({ coordinator: a });
    const chat = chatIdOf(61);
    await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('owner write') }]);
    alive.delete(1111);
    b.acquire();
    await b.activate(parts.host);
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('zombie write') }]), (error) => error.code === 'conflict' || error.code === 'busy');
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1, 'the zombie write is not in the store');
    assert.equal(parts.pendingBuffer.stats().entries, 0, 'a refused write is not left to replay');
    b.close();
  });

  it('a restore pause refuses new writes but keeps reads', async () => {
    const parts = await boot();
    const chat = chatIdOf(62);
    await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('before pause') }]);
    await parts.coordinator.pauseForRestore({ timeoutMs: 1000 });
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('during pause') }]), (error) => error.code === 'busy' || error.code === 'conflict');
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
  });
});
