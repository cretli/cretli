import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import {
  createChatHistoryStore, HISTORY_GROUP_MAX_MEMBER_BYTES, HISTORY_MAX_COMMAND_BYTES, HISTORY_MAX_RECORD_BYTES, HISTORY_READ_RESULT_BYTE_BUDGET,
} from '../lib/storage/chat-history-store.js';
import { toWireJson } from '../lib/storage/worker-wire.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { computeRequestDigest } from '../lib/storage/command-receipts.js';
import { readSdkHistoryStreamText } from '../lib/sdk/sdk-history-stream-coalesce.ts';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-chat-history-handlers.js', import.meta.url));
const NAMESPACE = Object.freeze({ datasetGeneration: 'generation-1', chatId: 'chat-1', chatEpoch: 'epoch-1' });
const PRODUCER = 'queue-device-1';
/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;
/** @type {Array<ReturnType<typeof createGroupCommitter>>} */
let committers;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-chat-history-store-'));
  hosts = [];
  committers = [];
});

afterEach(async () => {
  for (const committer of committers) await committer.close().catch(() => {});
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

/** @returns {Promise<{host:ReturnType<typeof createStorageWorkerHost>,store:ReturnType<typeof createChatHistoryStore>}>} */
async function startStore() {
  const host = createStorageWorkerHost({
    dbDir: root,
    handlersPath: HANDLERS_PATH,
    faultInjection: true,
    writeGate: WRITE_GATE_TEST_EXEMPTION,
    restartBackoffMs: { initial: 5, max: 20 },
  });
  hosts.push(host);
  await host.start();
  return { host, store: createChatHistoryStore({ host }) };
}

/** @param {number} clientSeq @param {string} [text] */
function item(clientSeq, text = `message-${clientSeq}`) {
  return { clientSeq, rec: { kind: 'localUser', text } };
}

/** @param {number} clientSeq @param {string} text @param {'delta'|'snapshot'} [mode] */
function stream(clientSeq, text, mode = 'delta') {
  return { clientSeq, rec: { kind: 'sdk', event: {
    type: 'assistant', streamTextMode: mode,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } } };
}

/** @param {string} commandId @param {ReturnType<typeof item>[]} events @param {Record<string,unknown>} [extra] */
function append(commandId, events, extra = {}) {
  return { ...NAMESPACE, producerId: PRODUCER, commandId, events, ...extra };
}

/** @param {Promise<unknown>} promise @param {string} code */
async function rejectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.details.commitState, code === 'unknown_commit' ? 'unknown' : 'not_committed');
    return true;
  });
}

/** @param {{events:Array<{seq:number}>}} page @returns {number[]} */
function sequences(page) {
  return page.events.map((event) => event.seq);
}

describe('chat history idempotency and durable acknowledgements', () => {
  it('replays a committed command after a lost reply and worker restart without a second delta', async () => {
    const { host, store } = await startStore();
    const request = append('lost-reply', [stream(1, 'hello')]);
    await host.command('test.arm', { commandId: request.commandId, mode: 'afterCommitExit' });
    let acknowledged = false;
    const pending = store.appendEvents(request).then((result) => { acknowledged = true; return result; });
    await rejectCode(pending, 'unknown_commit');
    assert.equal(acknowledged, false, 'a lost worker reply is never a durable ACK');
    const resolved = await store.resolveUnknown({ ...request, operation: 'appendEvents' });
    assert.equal(resolved.outcome, 'committed');
    const retry = await store.appendEvents(request);
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.result, resolved.result);
    assert.equal(host.getMetrics().restarts, 1);
    const page = await store.readLatest(NAMESPACE);
    assert.equal(readSdkHistoryStreamText(page.events[0].rec), 'hello');
    assert.deepEqual(sequences(page), [1]);
    assert.deepEqual(await host.query('test.counts', {}), { events: 1, receipts: 1 });
  });

  it('rolls back event, revision and receipt together when the worker exits before COMMIT', async () => {
    const { host, store } = await startStore();
    const request = append('before-commit', [item(1)]);
    await host.command('test.arm', { commandId: request.commandId, mode: 'beforeCommitExit' });
    await rejectCode(store.appendEvents(request), 'unknown_commit');
    assert.deepEqual(await store.resolveUnknown({ ...request, operation: 'appendEvents' }), { outcome: 'not_committed' });
    assert.deepEqual(await host.query('test.counts', {}), { events: 0, receipts: 0 });
    const retry = await store.appendEvents(request);
    assert.equal(retry.replayed, false);
    assert.deepEqual(retry.result.accepted.map((event) => event.seq), [1]);
    assert.equal((await store.readRevision(NAMESPACE)).revision, retry.result.revision);
  });

  it('keeps mutations invisible before COMMIT and every acknowledged event after reopening', async () => {
    const { host, store } = await startStore();
    await host.command('test.arm', {
      commandId: 'visibility', mode: 'observeBeforeCommit', dbPath: path.join(root, DEFAULT_STORAGE_DB_FILENAME),
    });
    const result = await store.appendEvents(append('visibility', [item(1), item(2)]));
    assert.deepEqual(await host.query('test.observations', {}), [{ events: 0, receipts: 0 }]);
    await host.close();
    const reopened = await startStore();
    assert.deepEqual(sequences(await reopened.store.readLatest(NAMESPACE)), result.result.accepted.map((event) => event.seq));
    assert.deepEqual(await reopened.host.query('test.counts', {}), { events: 2, receipts: 1 });
  });

  it('retains the group buffer and stable command/producer identity across a failed flush', async () => {
    const { host } = await startStore();
    const committer = createGroupCommitter({ host, windowMs: 1, retryDelayMs: 1 });
    committers.push(committer);
    const store = createChatHistoryStore({ host, groupCommitter: committer });
    const request = append('group-retry', [stream(1, 'once')]);
    await host.command('test.arm', { commandId: request.commandId, mode: 'busyCommit' });
    const result = await store.appendEvents(request);
    assert.equal(result.replayed, false);
    assert.ok(committer.getMetrics().counters.requeued >= 1);
    assert.deepEqual((await host.query('test.attempts', {})).filter((attempt) => attempt.commandId === request.commandId), [
      { commandId: request.commandId, producerId: PRODUCER },
      { commandId: request.commandId, producerId: PRODUCER },
    ]);
    assert.equal(readSdkHistoryStreamText((await store.readLatest(NAMESPACE)).events[0].rec), 'once');
    assert.deepEqual(await host.query('test.counts', {}), { events: 1, receipts: 1 });
  });
});

describe('chat history producers and coalescing', () => {
  it('deduplicates one queue identity across devices and preserves distinct clientSeq ordering', async () => {
    const { store } = await startStore();
    const requests = [
      append('device-a', [item(5)]), append('device-b', [item(5)]), append('device-c', [item(2), item(9)]),
    ];
    const results = await Promise.all(requests.map((request) => store.appendEvents(request)));
    assert.deepEqual(results.map((value) => value.result.accepted.map((entry) => entry.seq)), [[1], [1], [2, 3]]);
    assert.equal(results[1].result.accepted[0].duplicate, true);
    const page = await store.readLatest(NAMESPACE);
    assert.deepEqual(page.events.map((event) => event.clientSeq), [5, 2, 9]);
    assert.deepEqual(sequences(page), [1, 2, 3]);
    assert.equal(results[1].result.revision, results[0].result.revision, 'duplicates do not mutate history revision');
  });

  it('maps duplicate identities within one append to one assigned sequence and one mutation', async () => {
    const { store, host } = await startStore();
    const first = { ...item(1), createdAt: 1234 };
    const result = await store.appendEvents(append('same-command-duplicate', [first, first, item(2)]));
    assert.deepEqual(result.result.accepted.map((event) => event.seq), [1, 1, 2]);
    assert.deepEqual(result.result.accepted.map((event) => event.duplicate), [false, true, false]);
    assert.equal(result.result.revision, 2);
    const page = await store.readLatest(NAMESPACE);
    assert.equal(page.events[0].createdAt, 1234);
    assert.deepEqual(await host.query('test.counts', {}), { events: 2, receipts: 1 });
  });

  it('refuses an oversized append atomically before creating history or a receipt', async () => {
    const { store, host } = await startStore();
    await rejectCode(store.appendEvents(append('over-command-cap', [item(1, 'x'.repeat(40 * 1024)), item(2, 'y'.repeat(40 * 1024))])), 'conflict');
    assert.equal(await store.readRevision(NAMESPACE), null);
    assert.deepEqual(await host.query('test.counts', {}), { events: 0, receipts: 0 });
  });

  it('refuses a late invalid input without storing earlier valid inputs', async () => {
    const { store, host } = await startStore();
    await rejectCode(store.appendEvents(append('invalid-tail', [item(1), { clientSeq: 2, rec: { kind: 'sdk', event: null } }])), 'conflict');
    assert.equal(await store.readRevision(NAMESPACE), null);
    assert.deepEqual(await host.query('test.counts', {}), { events: 0, receipts: 0 });
  });

  it('returns a typed nonretryable refusal for a payload that cannot cross the JSON wire', async () => {
    const { store, host } = await startStore();
    const request = append('invalid-json', [{ clientSeq: 1, rec: { kind: 'localUser', text: 'unsent', unsupported: 1n } }]);
    await assert.rejects(store.appendEvents(request), (error) => {
      assert.equal(error.code, 'io');
      assert.equal(error.retryable, false);
      assert.equal(error.details.operation, 'payload_invalid');
      assert.equal(error.details.commitState, 'not_committed');
      return true;
    });
    assert.equal(request.events[0].rec.text, 'unsent');
    assert.equal(request.events[0].rec.unsupported, 1n);
    assert.equal(await store.readRevision(NAMESPACE), null);
    assert.deepEqual(await host.query('test.counts', {}), { events: 0, receipts: 0 });
  });

  it('refuses a forged receipt generation independently of the facade', async () => {
    const { host, store } = await startStore();
    const { commandId, ...payload } = append('wrong-envelope-generation', [item(1)]);
    await rejectCode(host.command('history.appendEvents', {
      receipt: { v: 1, datasetGeneration: 'wrong-generation', requestDigest: computeRequestDigest('history.appendEvents', payload) },
      payload,
    }, { commandId, requireReceipt: true }), 'conflict');
    assert.equal(await store.readRevision(NAMESPACE), null);
    assert.deepEqual(await host.query('test.counts', {}), { events: 0, receipts: 0 });
  });

  it('allocates monotonic unique sequences transactionally across concurrent tabs and producers', async () => {
    const { store } = await startStore();
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => store.appendEvents(
      append(`tab-${index}`, [item(1, `tab-${index}`)], { producerId: `producer-${index}` }),
    )));
    assert.deepEqual(results.flatMap((result) => result.result.accepted.map((event) => event.seq)).sort((a, b) => a - b),
      Array.from({ length: 24 }, (_, index) => index + 1));
    const page = await store.readLatest(NAMESPACE);
    assert.equal(new Set(page.events.map((event) => event.producerId)).size, 24);
    assert.equal(page.headSeq, 24);
  });

  it('keeps every coalesced input identity and grows revision while seq remains stable', async () => {
    const { store } = await startStore();
    const first = await store.appendEvents(append('stream-a', [stream(1, 'hello'), stream(2, ' world')]));
    assert.deepEqual(first.result.accepted.map((event) => event.seq), [1, 1]);
    const second = await store.appendEvents(append('stream-b', [stream(3, '!')]));
    assert.equal(second.result.headSeq, 1);
    assert.ok(second.result.revision > first.result.revision);
    const retry = await store.appendEvents(append('stream-dedupe', [stream(1, 'hello'), stream(2, ' world'), stream(3, '!')]));
    assert.deepEqual(retry.result.accepted.map((event) => event.seq), [1, 1, 1]);
    assert.ok(retry.result.accepted.every((event) => event.duplicate));
    assert.equal(retry.result.revision, second.result.revision);
    const page = await store.readLatest(NAMESPACE);
    assert.equal(page.events.length, 1);
    assert.equal(readSdkHistoryStreamText(page.events[0].rec), 'hello world!');
    assert.equal(page.revision, second.result.revision);
  });

  it('continues in a new event when coalescing would exceed the record cap', async () => {
    const { store, host } = await startStore();
    const delta = 'x'.repeat(50 * 1024);
    for (let clientSeq = 1; clientSeq <= 5; clientSeq += 1) {
      await store.appendEvents(append(`bounded-stream-${clientSeq}`, [stream(clientSeq, delta)]));
    }
    const before = await store.readLatest(NAMESPACE);
    assert.deepEqual(sequences(before), [1]);
    assert.equal(readSdkHistoryStreamText(before.events[0].rec), delta.repeat(5));
    const overflow = await store.appendEvents(append('coalesced-overflow', [stream(6, delta)]));
    assert.equal(overflow.result.accepted[0].seq, 2);
    assert.equal(overflow.result.accepted[0].duplicate, false);
    assert.equal(overflow.result.revision, before.revision + 1);
    const after = await store.readLatest(NAMESPACE);
    assert.deepEqual(sequences(after), [1, 2]);
    assert.equal(readSdkHistoryStreamText(after.events[0].rec), delta.repeat(5));
    assert.equal(readSdkHistoryStreamText(after.events[1].rec), delta);
    assert.deepEqual(await host.query('test.counts', {}), { events: 2, receipts: 6 });
  });

  it('preserves snapshot prefix growth, thinking boundaries and producer isolation', async () => {
    const { store } = await startStore();
    await store.appendEvents(append('snapshot-a', [stream(1, 'a', 'snapshot'), stream(2, 'ab', 'snapshot')]));
    await store.appendEvents(append('snapshot-b', [stream(3, 'a', 'snapshot')]));
    await store.appendEvents(append('thinking', [{ clientSeq: 4, rec: { kind: 'sdk', event: { type: 'thinking', text: 'reason' } } }]));
    await store.appendEvents(append('other-run', [stream(1, 'other')], { producerId: 'server-run-2' }));
    const page = await store.readLatest(NAMESPACE);
    assert.deepEqual(sequences(page), [1, 2, 3]);
    assert.deepEqual(page.events.map((event) => readSdkHistoryStreamText(event.rec)), ['ab', 'reason', 'other']);
  });

  it('rejects reused command and record identities with different digests without changing history', async () => {
    const { store } = await startStore();
    const original = append('digest', [item(1, 'original')]);
    const written = await store.appendEvents(original);
    await rejectCode(store.appendEvents(append('digest', [item(1, 'changed')])), 'conflict');
    await rejectCode(store.appendEvents(append('new-command', [item(1, 'changed')])), 'conflict');
    const page = await store.readLatest(NAMESPACE);
    assert.equal(page.events[0].rec.text, 'original');
    assert.equal(page.revision, written.result.revision);
  });

  it('rolls back earlier inputs in a command when a later input conflicts', async () => {
    const { store, host } = await startStore();
    const initial = await store.appendEvents(append('atomic-initial', [item(1, 'original')]));
    await rejectCode(store.appendEvents(append('atomic-conflict', [item(2, 'must roll back'), item(1, 'changed')])), 'conflict');
    const page = await store.readLatest(NAMESPACE);
    assert.deepEqual(sequences(page), [1]);
    assert.equal(page.revision, initial.result.revision);
    assert.deepEqual(await host.query('test.counts', {}), { events: 1, receipts: 1 });
    const accepted = await store.appendEvents(append('atomic-retry', [item(2, 'valid retry')]));
    assert.equal(accepted.result.accepted[0].seq, 2);
  });

  it('checks revision CAS atomically and permits only one concurrent mutation at a revision', async () => {
    const { store } = await startStore();
    const first = await store.appendEvents(append('initial', [item(1)]));
    const expectedRevision = first.result.revision;
    const outcomes = await Promise.allSettled([
      store.appendEvents(append('cas-a', [item(2)], { expectedRevision })),
      store.appendEvents(append('cas-b', [item(3)], { expectedRevision })),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.equal(failed.reason.code, 'conflict');
    assert.equal(failed.reason.details.expectedRevision, expectedRevision);
    assert.ok(failed.reason.details.actualRevision > expectedRevision);
    assert.equal((await store.readLatest(NAMESPACE)).events.length, 2);
  });
});

describe('chat history retention, epochs and explicit reconciliation', () => {
  it('refuses a reset generation that the receipt layer cannot address, without fencing the active queue', async () => {
    const { store, host } = await startStore();
    await store.appendEvents(append('valid-generation', [item(1)]));
    await rejectCode(store.reset({ ...NAMESPACE, commandId: 'invalid-reset-generation', newChatEpoch: 'epoch-2',
      newDatasetGeneration: 'g'.repeat(129) }), 'conflict');
    assert.equal((await store.reconnect({ ...NAMESPACE, producerId: PRODUCER })).chatEpoch, NAMESPACE.chatEpoch);
    const next = await store.appendEvents(append('after-invalid-reset', [item(2)]));
    assert.equal(next.result.accepted[0].seq, 2);
    assert.deepEqual(await host.query('test.counts', {}), { events: 2, receipts: 2 });
  });

  it('retains dedupe identities and receipts after trimming while sequence allocation remains monotonic', async () => {
    const { store, host } = await startStore();
    const first = await store.appendEvents(append('before-trim', [item(1), item(2), item(3)]));
    await store.trim({ ...NAMESPACE, commandId: 'trim', keepLast: 1 });
    assert.deepEqual(sequences(await store.readLatest(NAMESPACE)), [3]);
    const duplicate = await store.appendEvents(append('trimmed-duplicate', [item(1)]));
    assert.equal(duplicate.result.accepted[0].seq, 1);
    assert.equal(duplicate.result.accepted[0].duplicate, true);
    assert.deepEqual(sequences(await store.readLatest(NAMESPACE)), [3], 'a pruned acknowledged event is never fabricated again');
    const replay = await store.appendEvents(append('before-trim', [item(1), item(2), item(3)]));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.equal((await store.readRevision(NAMESPACE)).trimmedThroughSeq, 2);
    const next = await store.appendEvents(append('after-trim', [item(4)]));
    assert.equal(next.result.accepted[0].seq, 4);
    assert.equal((await store.readRevision(NAMESPACE)).trimmedThroughSeq, 3);
    assert.equal((await host.query('test.counts', {})).receipts, 4);
  });

  it('retains sequence and dedupe state when zero retention removes every event', async () => {
    const { store, host } = await startStore();
    const initialRequest = append('before-trim-zero', [item(1), item(2), item(3)]);
    const initial = await store.appendEvents(initialRequest);
    const trimmed = await store.trim({ ...NAMESPACE, commandId: 'trim-zero', keepLast: 0 });
    assert.equal(trimmed.result.removed, 3);
    assert.equal(trimmed.result.headSeq, 3);
    assert.equal(trimmed.result.trimmedThroughSeq, 3);
    assert.deepEqual(sequences(await store.readLatest(NAMESPACE)), []);
    const replay = await store.appendEvents(initialRequest);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, initial.result);
    const duplicate = await store.appendEvents(append('trim-zero-duplicate', [item(1)]));
    assert.equal(duplicate.result.accepted[0].seq, 1);
    assert.equal(duplicate.result.accepted[0].duplicate, true);
    assert.equal(duplicate.result.revision, trimmed.result.revision);
    assert.deepEqual(sequences(await store.readLatest(NAMESPACE)), []);
    const next = await store.appendEvents(append('after-trim-zero', [item(4)]));
    assert.equal(next.result.accepted[0].seq, 4);
    assert.equal(next.result.headSeq, 4);
    assert.equal(next.result.trimmedThroughSeq, 4);
    assert.equal(next.result.retentionLimit, 0);
    assert.deepEqual(sequences(await store.readLatest(NAMESPACE)), []);
    assert.deepEqual(await host.query('test.counts', {}), { events: 0, receipts: 4 });
  });

  it('enforces the default 2000-event retention without reusing sequences or pruned dedupe identities', async () => {
    const { store, host } = await startStore();
    for (let batch = 0; batch < 9; batch += 1) {
      await store.appendEvents(append(`retention-${batch}`, Array.from({ length: 256 }, (_, index) => item(batch * 256 + index + 1))));
    }
    const latest = await store.readLatest({ ...NAMESPACE, limit: 2000 });
    assert.equal(latest.events.length, 2000);
    assert.equal(latest.headSeq, 2304);
    assert.equal(latest.trimmedThroughSeq, 304);
    assert.deepEqual(sequences(latest), Array.from({ length: 2000 }, (_, index) => index + 305));
    const old = await store.appendEvents(append('default-retention-dedupe', [item(1)]));
    assert.equal(old.result.accepted[0].seq, 1);
    assert.equal(old.result.accepted[0].duplicate, true);
    const next = await store.appendEvents(append('default-retention-next', [item(2305)]));
    assert.equal(next.result.accepted[0].seq, 2305);
    assert.equal((await store.readRevision(NAMESPACE)).trimmedThroughSeq, 305);
    assert.deepEqual(await host.query('test.counts', {}), { events: 2000, receipts: 11 });
  });

  it('requires explicit review to reconcile a legacy queue and never mutates its unsent content', async () => {
    const { store } = await startStore();
    const legacyEvents = [{ rec: { kind: 'localUser', text: 'offline message' }, clientSeq: 900 }];
    const snapshot = structuredClone(legacyEvents);
    await assert.rejects(store.appendEvents({ chatId: NAMESPACE.chatId, commandId: 'legacy-auto', events: legacyEvents }), (error) => {
      assert.equal(error.code, 'conflict');
      assert.equal(error.details.conflictKind, 'history_reconciliation_required');
      assert.equal(error.details.commitState, 'not_committed');
      return true;
    });
    const request = { ...NAMESPACE, commandId: 'legacy-review', producerId: 'reconciled-queue', reconciliationId: 'review-1', events: legacyEvents };
    await rejectCode(store.reconcileLegacyQueue({ ...request, reviewed: false }), 'conflict');
    assert.equal(await store.readRevision(NAMESPACE), null);
    const accepted = await store.reconcileLegacyQueue({ ...request, reviewed: true });
    assert.equal(accepted.result.accepted.length, 1);
    assert.equal(accepted.result.historicalDedupeCertain, false);
    assert.notEqual(accepted.result.accepted[0].clientSeq, 900, 'legacy metadata is not guessed to be a v2 dedupe identity');
    const replay = await store.reconcileLegacyQueue({ ...request, reviewed: true });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, accepted.result);
    assert.deepEqual(legacyEvents, snapshot);
    const page = await store.readLatest(NAMESPACE);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].rec.legacyClientSeq, 900);
    assert.equal(page.events[0].rec.reconciliationId, request.reconciliationId);
  });

  it('rotates reset epochs and dataset generations, fences old producers and refuses stale reconnects', async () => {
    const { store } = await startStore();
    const old = await store.appendEvents(append('old', [item(1)]));
    const current = { ...NAMESPACE, chatEpoch: 'epoch-2' };
    await store.reset({ ...NAMESPACE, commandId: 'reset-epoch', newChatEpoch: current.chatEpoch, expectedRevision: old.result.revision });
    assert.deepEqual(sequences(await store.readLatest(current)), []);
    await rejectCode(store.reconnect({ ...NAMESPACE, producerId: PRODUCER }), 'conflict');
    await rejectCode(store.appendEvents(append('stale-epoch', [item(2)])), 'conflict');
    await rejectCode(store.appendEvents(append('retired-old-producer', [item(2)], current)), 'conflict');
    const fresh = await store.appendEvents(append('fresh-epoch', [item(1)], { ...current, producerId: 'new-queue' }));
    assert.equal(fresh.result.accepted[0].seq, 1);
    const reconnected = await store.reconnect({ ...current, producerId: 'new-queue' });
    assert.equal(reconnected.chatEpoch, current.chatEpoch);
    assert.equal(reconnected.revision, fresh.result.revision);
    const recovered = { ...current, datasetGeneration: 'generation-2', chatEpoch: 'epoch-3' };
    await store.reset({ ...current, commandId: 'reset-generation', newDatasetGeneration: recovered.datasetGeneration, newChatEpoch: recovered.chatEpoch });
    await rejectCode(store.reconnect({ ...current, producerId: 'new-queue' }), 'conflict');
    await rejectCode(store.appendEvents(append('stale-generation', [item(2)], { ...current, producerId: 'new-queue' })), 'conflict');
    const state = await store.readRevision(recovered);
    assert.equal(state.revision, 0);
    assert.equal(state.headSeq, 0);
    assert.equal(state.datasetGeneration, recovered.datasetGeneration);
  });

  it('retains producer tombstones so retired and fenced queues cannot register again', async () => {
    const { store } = await startStore();
    for (const mode of ['retired', 'fenced']) {
      const producerId = `queue-${mode}`;
      await store.appendEvents(append(`initial-${mode}`, [item(1)], { producerId }));
      await store.retireProducer({ ...NAMESPACE, producerId, commandId: `retire-${mode}`, mode });
      await rejectCode(store.appendEvents(append(`again-${mode}`, [item(2)], { producerId })), 'conflict');
      await rejectCode(store.reconnect({ ...NAMESPACE, producerId }), 'conflict');
    }
    assert.equal((await store.readLatest(NAMESPACE)).events.length, 2);
  });

  it('can fence an unseen producer and preserves that fence when the worker reopens', async () => {
    const { store, host } = await startStore();
    await store.appendEvents(append('create-chat', [item(1)]));
    await store.retireProducer({ ...NAMESPACE, producerId: 'never-seen', commandId: 'fence-unseen', mode: 'fenced' });
    await host.close();
    const reopened = await startStore();
    await rejectCode(reopened.store.appendEvents(append('blocked-unseen', [item(1)], { producerId: 'never-seen' })), 'conflict');
    assert.deepEqual(sequences(await reopened.store.readLatest(NAMESPACE)), [1]);
  });

  it('refuses reuse of an empty epoch pair after later resets', async () => {
    const { store } = await startStore();
    await store.appendEvents(append('epoch-seed', [item(1)]));
    await store.reset({ ...NAMESPACE, commandId: 'to-empty-epoch', newChatEpoch: 'empty-epoch' });
    const empty = { ...NAMESPACE, chatEpoch: 'empty-epoch' };
    await store.reset({ ...empty, commandId: 'away-from-empty', newChatEpoch: 'current-epoch' });
    const current = { ...NAMESPACE, chatEpoch: 'current-epoch' };
    await rejectCode(store.reset({ ...current, commandId: 'reuse-empty', newChatEpoch: empty.chatEpoch }), 'conflict');
    assert.equal((await store.readRevision(current)).revision, 0);
    assert.deepEqual(sequences(await store.readLatest(current)), []);
  });
});

describe('chat history keyset reads', () => {
  it('pages forward and backward without gaps while another tab appends concurrently', async () => {
    const { store } = await startStore();
    await store.appendEvents(append('page-seed', Array.from({ length: 12 }, (_, index) => item(index + 1))));
    const first = await store.readPage({ ...NAMESPACE, afterSeq: 0, limit: 4 });
    assert.deepEqual(sequences(first), [1, 2, 3, 4]);
    assert.equal(first.hasMore, true);
    const [second] = await Promise.all([
      store.readPage({ ...NAMESPACE, afterSeq: 4, beforeSeq: 13, limit: 4 }),
      store.appendEvents(append('page-concurrent', [item(1), item(2)], { producerId: 'other-tab' })),
    ]);
    const third = await store.readPage({ ...NAMESPACE, afterSeq: 8, beforeSeq: 13, limit: 4 });
    assert.deepEqual([...sequences(first), ...sequences(second), ...sequences(third)], Array.from({ length: 12 }, (_, index) => index + 1));
    assert.equal(third.hasMore, false);
    const latest = await store.readLatest({ ...NAMESPACE, limit: 4 });
    assert.deepEqual(sequences(latest), [11, 12, 13, 14]);
    assert.equal(latest.hasMore, true);
    const earlier = await store.readPage({ ...NAMESPACE, beforeSeq: 11, limit: 4 });
    assert.deepEqual(sequences(earlier), [7, 8, 9, 10]);
    assert.equal(earlier.hasMore, true);
    const oldest = await store.readPage({ ...NAMESPACE, beforeSeq: 5, limit: 4 });
    assert.deepEqual(sequences(oldest), [1, 2, 3, 4]);
    assert.equal(oldest.hasMore, false);
  });

  it('returns isolated empty/latest windows and rejects a page from another epoch', async () => {
    const { store } = await startStore();
    assert.deepEqual(sequences(await store.readLatest(NAMESPACE)), []);
    await store.appendEvents(append('chat-one', [item(1), item(2)]));
    const otherChat = { ...NAMESPACE, chatId: 'chat-2' };
    await store.appendEvents(append('chat-two', [item(1, 'other chat')], otherChat));
    assert.deepEqual(sequences(await store.readPage({ ...NAMESPACE, afterSeq: 999, limit: 5 })), []);
    assert.equal((await store.readLatest(otherChat)).events[0].rec.text, 'other chat');
    await rejectCode(store.readLatest({ ...NAMESPACE, chatEpoch: 'stale-epoch' }), 'conflict');
    assert.equal((await store.readRevision(otherChat)).headSeq, 1);
  });
});

/** Text whose record (`{kind,text,clientSeq}`) serializes to exactly `bytes` bytes. */
function textForRecordBytes(clientSeq, bytes) {
  const base = toWireJson({ kind: 'localUser', text: '', clientSeq }).bytes;
  return 'x'.repeat(bytes - base);
}

describe('chat history large records (P2-2 policy)', () => {
  it('saves a 64-256 KiB record intact via the facade, with idempotent replay', async () => {
    const { store } = await startStore();
    const text = 'z'.repeat(HISTORY_MAX_COMMAND_BYTES + 40 * 1024);
    const request = append('large-record', [item(1, text)]);
    const first = await store.appendEvents(request);
    assert.equal(first.replayed, false);
    const retry = await store.appendEvents(request);
    assert.equal(retry.replayed, true);
    const page = await store.readLatest(NAMESPACE);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].rec.text, text);
  });

  it('accepts a record of exactly the record cap and refuses one byte more, atomically', async () => {
    const { store, host } = await startStore();
    const exact = textForRecordBytes(1, HISTORY_MAX_RECORD_BYTES);
    await store.appendEvents(append('record-exact', [item(1, exact)]));
    assert.equal((await store.readLatest(NAMESPACE)).events[0].rec.text.length, exact.length);
    await rejectCode(store.appendEvents(append('record-over', [item(2, `${textForRecordBytes(2, HISTORY_MAX_RECORD_BYTES)}x`)])), 'conflict');
    assert.deepEqual(await host.query('test.counts', {}), { events: 1, receipts: 1 });
  });

  it('keeps the 64 KiB budget for multi-event commands', async () => {
    const { store } = await startStore();
    await rejectCode(store.appendEvents(append('multi-over', [item(1, 'a'.repeat(33 * 1024)), item(2, 'b'.repeat(33 * 1024))])), 'conflict');
  });

  it('ships a large record alone through a group committer sized by HISTORY_GROUP_MAX_MEMBER_BYTES', async () => {
    const { host } = await startStore();
    const committer = createGroupCommitter({ host, windowMs: 1, maxMemberBytes: HISTORY_GROUP_MAX_MEMBER_BYTES });
    committers.push(committer);
    const store = createChatHistoryStore({ host, groupCommitter: committer });
    const big = textForRecordBytes(1, HISTORY_MAX_RECORD_BYTES);
    const results = await Promise.all([
      store.appendEvents(append('group-big', [item(1, big)])),
      store.appendEvents(append('group-small', [item(2, 'small')], { producerId: 'other-tab' })),
    ]);
    assert.deepEqual(results.map((value) => value.replayed), [false, false]);
    const events = (await store.readPage({ ...NAMESPACE, afterSeq: 0, limit: 10 })).events;
    assert.deepEqual(events.map((event) => event.rec.text.length), [big.length, 5]);
  });

  it('continues an over-cap stream in a new event instead of losing delta content', async () => {
    const { store } = await startStore();
    const chunk = 'q'.repeat(150 * 1024);
    await store.appendEvents(append('stream-a', [stream(1, chunk)]));
    await store.appendEvents(append('stream-b', [stream(2, chunk)]));
    const page = await store.readLatest(NAMESPACE);
    assert.equal(page.events.length, 2);
    assert.equal(page.events.map((event) => readSdkHistoryStreamText(event.rec)).join('').length, chunk.length * 2);
  });
});

describe('chat history byte-bounded pages (P2-1)', () => {
  const WORKER_RESULT_LIMIT = 4 * 1024 * 1024;

  /** @param {Awaited<ReturnType<typeof startStore>>['store']} store @param {number} count @param {number} bytes */
  async function seedLarge(store, count, bytes) {
    for (let index = 1; index <= count; index += 1) {
      await store.appendEvents(append(`large-${index}`, [item(index, `${index % 10}${'é\n"\\😀'.repeat(Math.floor(bytes / 12))}`)]));
    }
  }

  it('returns a page below the worker result limit with hasMore instead of result_too_large', async () => {
    const { store } = await startStore();
    await seedLarge(store, 30, 200 * 1024);
    const latest = await store.readLatest({ ...NAMESPACE, limit: 100 });
    assert.ok(latest.events.length > 0 && latest.events.length < 30);
    assert.equal(latest.hasMore, true);
    assert.ok(toWireJson(latest).bytes <= WORKER_RESULT_LIMIT);
    assert.ok(toWireJson(latest.events).bytes <= HISTORY_READ_RESULT_BYTE_BUDGET);
    assert.equal(latest.events.at(-1).seq, 30, 'latest window is anchored at the head');
  });

  it('walks every window (latest, before, after) exactly once with progress', async () => {
    const { store } = await startStore();
    await seedLarge(store, 24, 300 * 1024 / 2);
    const backward = [];
    let cursor = await store.readLatest({ ...NAMESPACE, limit: 50 });
    for (let guard = 0; guard < 40; guard += 1) {
      backward.unshift(...sequences(cursor));
      if (!cursor.hasMore) break;
      assert.ok(cursor.events.length >= 1, 'every page makes progress');
      cursor = await store.readPage({ ...NAMESPACE, beforeSeq: cursor.events[0].seq, limit: 50 });
    }
    assert.deepEqual(backward, Array.from({ length: 24 }, (_, index) => index + 1));
    const forward = [];
    let next = await store.readPage({ ...NAMESPACE, afterSeq: 0, limit: 50 });
    for (let guard = 0; guard < 40; guard += 1) {
      forward.push(...sequences(next));
      if (!next.hasMore) break;
      next = await store.readPage({ ...NAMESPACE, afterSeq: next.events.at(-1).seq, limit: 50 });
    }
    assert.deepEqual(forward, backward);
  });

  it('charges UTF-8 and escaped bytes: a small byteBudget cuts whole events and signals hasMore', async () => {
    const { store } = await startStore();
    await store.appendEvents(append('utf8', Array.from({ length: 10 }, (_, index) => item(index + 1, `ż${'"\\\n😀'.repeat(20)}${index}`))));
    const budget = 1500;
    const page = await store.readPage({ ...NAMESPACE, afterSeq: 0, limit: 10, byteBudget: budget });
    assert.ok(page.events.length >= 1 && page.events.length < 10);
    assert.equal(page.hasMore, true);
    assert.ok(toWireJson(page.events).bytes <= budget);
    const tiny = await store.readPage({ ...NAMESPACE, afterSeq: 0, limit: 10, byteBudget: 1 });
    assert.deepEqual(sequences(tiny), [1], 'the first event is always returned');
    assert.equal(tiny.hasMore, true);
    assert.equal(page.events[0].rec.text, `ż${'"\\\n😀'.repeat(20)}0`);
  });

  it('refuses an invalid or oversized byteBudget', async () => {
    const { store } = await startStore();
    await store.appendEvents(append('seed-budget', [item(1)]));
    await rejectCode(store.readPage({ ...NAMESPACE, byteBudget: 0 }), 'conflict');
    await rejectCode(store.readPage({ ...NAMESPACE, byteBudget: HISTORY_READ_RESULT_BYTE_BUDGET + 1 }), 'conflict');
  });
});
