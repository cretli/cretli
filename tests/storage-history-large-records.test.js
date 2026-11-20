/**
 * Large records (256 KiB .. 3 MiB) through the whole history path: fragment
 * protocol in the worker store, the async adapter (single pending entry,
 * deterministic fragment/finalize commands), the offline importer and the
 * rollback export. Synthetic data in temp dirs only; no live store is read.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FAULT_HANDLERS_PATH, GENERATION, bootParts, chatIdOf, makeRoot, userRec,
} from './fixtures/storage-history-adapter-harness.js';
import { assistantRec, makeTempDir } from './fixtures/storage-history-synthetic.js';
import { StorageError } from '../lib/storage/errors.js';
import {
  HISTORY_GROUP_MAX_MEMBER_BYTES, HISTORY_MAX_COMMAND_BYTES, HISTORY_MAX_LARGE_RECORD_BYTES, HISTORY_MAX_RECORD_BYTES,
  HISTORY_MAX_SINGLE_EVENT_COMMAND_BYTES, HISTORY_READ_RESULT_BYTE_BUDGET, HISTORY_STAGE_LIST_PAGE_MAX,
} from '../lib/storage/chat-history-store.js';
import {
  HISTORY_LARGE_FRAGMENT_BYTES, HISTORY_STAGE_MAX_PER_CHAT, planLargeRecord,
} from '../lib/storage/history-large-record.js';
import { DEFAULT_GROUP_MAX_BATCH_BYTES } from '../lib/storage/group-commit.js';
import { DEFAULT_MAX_RESULT_BYTES, DEFAULT_MAX_REQUEST_BYTES } from '../lib/storage/worker-host.js';
import { toWireJson } from '../lib/storage/worker-wire.js';
import { applyLegacyImport, planLegacyImport } from '../lib/storage/history-import.js';
import { applyRollbackExport, planRollbackExport, verifyRollbackExport } from '../lib/storage/history-rollback.js';
import { readLegacyHistoryFile } from '../lib/storage/history-legacy-format.js';

const WIDEST = Number.MAX_SAFE_INTEGER - 1;
/** Exact size of the largest legacy record of the (read-only, metadata-only) preflight. */
const PREFLIGHT_MAX_RECORD = 2686612;
/** @type {string} */
let root;
/** @type {Array<{ close: () => Promise<void> }>} */
let booted = [];

beforeEach(() => { root = makeRoot('cretli-history-large-'); booted = []; });
afterEach(async () => {
  for (const parts of booted.reverse()) await parts.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {Parameters<typeof bootParts>[0] extends infer O ? Partial<O> : never} [options] */
async function boot(options = {}) {
  const parts = await bootParts({ root, ...options });
  booted.push(parts);
  return parts;
}

/**
 * A localUser record whose store-measured size (wire JSON with the widest clientSeq) is exactly `target`.
 * `flavor: 'unicode'` mixes multi-byte text so fragment boundaries fall inside UTF-8 sequences.
 * @param {number} target @param {'ascii' | 'unicode'} [flavor]
 */
function recOfStoredBytes(target, flavor = 'ascii') {
  const unit = flavor === 'unicode'
    ? 'Zażółć gęślą jaźń 🙂 日本語 "q" \\b \n\t\u0001   \ud800 \udfff é '
    : 'abcdefghij';
  const measureText = (value) => toWireJson({ ...userRec(value), clientSeq: WIDEST }).bytes;
  const base = measureText('');
  const perUnit = (measureText(unit.repeat(100)) - base) / 100;
  let text = unit.repeat(Math.max(0, Math.floor((target - base) / perUnit) - 1));
  // Every remaining byte is one ASCII character, so one padding step lands exactly on the target.
  text += 'x'.repeat(target - measureText(text));
  assert.equal(measureText(text), target);
  return userRec(text);
}

const storedBytes = (rec, clientSeq = WIDEST) => toWireJson({ ...rec, clientSeq }).bytes;
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Store identity helper. */
const identity = (chatId, chatEpoch = 'ep.1') => ({ datasetGeneration: GENERATION, chatId, chatEpoch });

/**
 * Stage fragments by hand (store level).
 * @param {any} store @param {ReturnType<typeof identity>} who @param {string} producerId @param {number} clientSeq
 * @param {ReturnType<typeof planLargeRecord>} plan
 * @param {{ order?: number[], tag?: string, mutate?: (index: number, data: string) => string }} [options]
 */
async function stage(store, who, producerId, clientSeq, plan, options = {}) {
  const order = options.order ?? plan.fragments.map((_, index) => index);
  const tag = options.tag ?? `stage:${producerId}:${clientSeq}`;
  for (const index of order) {
    const data = options.mutate ? options.mutate(index, plan.fragments[index]) : plan.fragments[index];
    await store.stageFragment({
      ...who, producerId, clientSeq, index, count: plan.large.fragments, totalBytes: plan.large.bytes, sha256: plan.large.sha256, data, commandId: `${tag}:${index}`,
    });
  }
}

/** @param {any} store @param {ReturnType<typeof identity>} who @param {string} producerId @param {number} clientSeq @param {ReturnType<typeof planLargeRecord>} plan @param {string} commandId */
const finalize = (store, who, producerId, clientSeq, plan, commandId) => store.appendEvents({
  ...who, producerId, commandId, events: [{ clientSeq, large: plan.large }],
});

const rejectKind = (promise, kind) => assert.rejects(promise, (error) => error.details?.conflictKind === kind && error.details?.commitState === 'not_committed', kind);
const stagedCount = async (store) => (await store.listStages({ datasetGeneration: GENERATION })).stages.length;

describe('limits stay as approved', () => {
  it('keeps the regular command/record/batch/worker limits and puts the large cap in its own constant', async () => {
    assert.equal(HISTORY_MAX_COMMAND_BYTES, 64 * 1024);
    assert.equal(HISTORY_MAX_RECORD_BYTES, 256 * 1024);
    assert.equal(HISTORY_MAX_SINGLE_EVENT_COMMAND_BYTES, 264 * 1024);
    assert.equal(DEFAULT_GROUP_MAX_BATCH_BYTES, 256 * 1024);
    assert.equal(DEFAULT_MAX_RESULT_BYTES, 4 * 1024 * 1024);
    assert.equal(DEFAULT_MAX_REQUEST_BYTES, 4 * 1024 * 1024);
    assert.equal(HISTORY_MAX_LARGE_RECORD_BYTES, 3 * 1024 * 1024);
    assert.ok(PREFLIGHT_MAX_RECORD < HISTORY_MAX_LARGE_RECORD_BYTES);
    assert.ok(HISTORY_MAX_LARGE_RECORD_BYTES + 400 < HISTORY_READ_RESULT_BYTE_BUDGET, 'one finalized record fits one worker result with headroom');
    // A fragment command fits the regular 64 KiB budget with the full envelope, so no limit had to grow.
    const plan = planLargeRecord(recOfStoredBytes(HISTORY_MAX_LARGE_RECORD_BYTES));
    const command = { ...identity(chatIdOf(1)), producerId: `server:run:${'a'.repeat(100)}:attempt:${'b'.repeat(36)}`, clientSeq: WIDEST, index: plan.large.fragments - 2, count: plan.large.fragments, totalBytes: plan.large.bytes, sha256: plan.large.sha256, data: plan.fragments[0] };
    const bytes = toWireJson(command).bytes;
    assert.ok(bytes < HISTORY_MAX_COMMAND_BYTES - 8 * 1024, `fragment command ${bytes} B`);
    assert.ok(bytes < HISTORY_GROUP_MAX_MEMBER_BYTES);
    assert.equal(plan.fragments[0].length, Math.ceil(HISTORY_LARGE_FRAGMENT_BYTES / 3) * 4);
  });

  it('an inline (regular) append above 256 KiB is still refused by the store: only the fragment protocol reaches the large cap', async () => {
    const { baseStore } = await boot();
    const who = identity(chatIdOf(2));
    await rejectKind(baseStore.appendEvents({ ...who, producerId: 'p1', commandId: 'inline-over', events: [{ clientSeq: 1, rec: recOfStoredBytes(300 * 1024) }] }), 'history_command_too_large');
  });
});

describe('adapter: large records round trip losslessly', () => {
  const sizes = [
    ['256 KiB + 1', HISTORY_MAX_RECORD_BYTES + 1],
    ['1 MiB', 1024 * 1024],
    ['preflight max 2686612 B', PREFLIGHT_MAX_RECORD],
    ['the large cap', HISTORY_MAX_LARGE_RECORD_BYTES],
  ];
  for (const [label, target] of sizes) {
    it(`stores and reads back ${label} identically through every read path`, async () => {
      const parts = await boot();
      const chat = chatIdOf(10);
      const rec = recOfStoredBytes(target, 'unicode');
      const result = await parts.adapter.appendChatHistoryEvents(chat, 'cursor-1', [{ rec: userRec('before') }, { rec }, { rec: userRec('after') }]);
      assert.equal(result.ok, true);
      assert.equal(result.appended.length, 3);
      assert.deepEqual(result.appended.map((entry) => entry.seq), [1, 2, 3]);
      assert.ok(sameJson(result.appended[1].rec, rec), 'append result carries the record unchanged');
      const page = await parts.adapter.getChatHistorySince(chat, 0, 10);
      assert.equal(page.events.length, 3);
      assert.ok(sameJson(page.events[1].rec, rec), 'readPage');
      const single = await parts.adapter.getChatHistoryEvent(chat, 2);
      assert.ok(sameJson(single.event.rec, rec), 'exact event lookup');
      const full = await parts.adapter.loadChatHistory(chat);
      assert.ok(sameJson(full.events[1].rec, rec), 'full load');
      assert.equal(full.headSeq, 3);
      assert.equal(parts.pendingBuffer.stats().entries, 0);
      assert.equal(await stagedCount(parts.baseStore), 0, 'finalization removed the fragments');
      const row = new DatabaseSync(path.join(parts.dbDir, 'cretli-store.sqlite'), { readOnly: true });
      try {
        const stored = row.prepare('SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM chat_history_events WHERE seq = 2').get();
        assert.ok(stored.bytes <= HISTORY_MAX_LARGE_RECORD_BYTES);
      } finally {
        row.close();
      }
    });
  }

  it('refuses one byte above the large cap atomically, with the pending input untouched', async () => {
    const parts = await boot();
    const chat = chatIdOf(11);
    const over = recOfStoredBytes(HISTORY_MAX_LARGE_RECORD_BYTES + 1);
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('prefix') }, { rec: over }]),
      (error) => error.code === 'history_record_too_large' && error.details.commitState === 'not_committed');
    assert.equal(parts.pendingBuffer.stats().entries, 0, 'nothing was recorded');
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 0, 'the valid prefix did not commit either');
    assert.equal(await stagedCount(parts.baseStore), 0);
  });

  it('keeps lone surrogates, escapes and fragment boundaries inside UTF-8 sequences intact (raw bytes of the stored JSON)', async () => {
    const parts = await boot();
    const chat = chatIdOf(12);
    // Two-byte letters after a one-byte prefix put a UTF-8 sequence across every 32 KiB fragment edge.
    const text = `a${'ż'.repeat(100000)}\ud800 lone \udfff ${'🙂'.repeat(30000)} "quoted" \\ back \u0000 nul`;
    const rec = { ...userRec(text), futureField: { nested: [1, 2.5, null, { '日本': '✓' }] } };
    assert.ok(storedBytes(rec) > HISTORY_MAX_RECORD_BYTES);
    await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }]);
    const read = (await parts.adapter.getChatHistorySince(chat, 0, 10)).events[0].rec;
    assert.equal(read.text, text);
    assert.ok(sameJson(read, rec));
    assert.equal(read.text.charCodeAt(read.text.indexOf('\ud800')), 0xd800, 'the lone surrogate survived');
  });

  it('keeps event order for mixed small and large inputs in one logical append (read-back is byte-paged under the 4 MiB result limit)', async () => {
    const parts = await boot();
    const chat = chatIdOf(14);
    const large = [recOfStoredBytes(1024 * 1024), recOfStoredBytes(1536 * 1024, 'unicode'), recOfStoredBytes(2 * 1024 * 1024)];
    const inputs = [userRec('s0'), large[0], userRec('s1'), userRec('s2'), large[1], large[2], userRec('s3')].map((rec) => ({ rec }));
    const result = await parts.adapter.appendChatHistoryEvents(chat, '', inputs);
    assert.equal(result.ok, true);
    assert.deepEqual(result.appended.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(result.receipts.length >= 5, 'regular chunks and one finalizing command per large record');
    const stored = (await parts.adapter.loadChatHistory(chat)).events.map((event) => event.rec);
    assert.ok(sameJson(stored, inputs.map((input) => input.rec)));
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });

  it('pages a chat with several large records by bytes without cutting any (worker result stays within 4 MiB)', async () => {
    const parts = await boot();
    const chat = chatIdOf(13);
    const recs = [1024 * 1024, PREFLIGHT_MAX_RECORD, 1500 * 1024, HISTORY_MAX_RECORD_BYTES + 5].map((bytes, index) => ({ ...recOfStoredBytes(bytes), label: index }));
    for (const rec of recs) await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }]);
    const seen = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await parts.baseStore.readPage({ ...identity(chat, (await parts.baseStore.readRevision({ ...identity(chat), anyEpoch: true })).chatEpoch), afterSeq: after, limit: 100 });
      assert.ok(toWireJson(page).bytes < DEFAULT_MAX_RESULT_BYTES, 'every page is a legal worker result');
      pages += 1;
      for (const event of page.events) seen.push(event);
      if (!page.hasMore) break;
      after = page.events.at(-1).seq;
    }
    assert.equal(seen.length, 4);
    assert.ok(pages >= 2, 'the window was cut by bytes, not by dropping records');
    seen.forEach((event, index) => assert.equal(event.rec.label, index));
    const seqs = await parts.baseStore.readSeqs({ ...identity(chat, seen[0] ? (await parts.baseStore.readRevision({ ...identity(chat), anyEpoch: true })).chatEpoch : ''), seqs: [1, 2, 3, 4] });
    assert.equal(seqs.truncated, true);
    assert.ok(toWireJson(seqs).bytes < DEFAULT_MAX_RESULT_BYTES);
  });
});

describe('store: fragment protocol invariants', () => {
  it('fragments are invisible as history until the single finalizing command; out-of-order and duplicate fragments are idempotent', async () => {
    const { baseStore, adapter } = await boot();
    const chat = chatIdOf(20);
    const who = identity(chat);
    const rec = recOfStoredBytes(700 * 1024, 'unicode');
    const plan = planLargeRecord(rec);
    const order = plan.fragments.map((_, index) => index).reverse();
    await stage(baseStore, who, 'queue-a', 7, plan, { order, tag: 'first' });
    // Same fragments again under other command ids: content-idempotent, no mismatch.
    await stage(baseStore, who, 'queue-a', 7, plan, { tag: 'second' });
    const listed = (await baseStore.listStages({ datasetGeneration: GENERATION })).stages;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].received, plan.large.fragments);
    assert.deepEqual((await adapter.getChatHistorySince(chat, 0, 10)).events, [], 'staged bytes are not history');
    assert.equal((await baseStore.listHeads({})).chats.length, 0, 'staging does not create a chat');
    const done = await finalize(baseStore, who, 'queue-a', 7, plan, 'final-1');
    assert.deepEqual(done.result.accepted, [{ clientSeq: 7, seq: 1, revision: 1, duplicate: false }]);
    assert.equal(await stagedCount(baseStore), 0, 'staging disappeared in the finalizing transaction');
    const again = await finalize(baseStore, who, 'queue-a', 7, plan, 'final-2');
    assert.equal(again.result.accepted[0].duplicate, true, 'a retry under another command id is a duplicate (no staging needed)');
    assert.equal(again.result.revision, 1);
    const page = await baseStore.readPage({ ...who, limit: 10 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].rec.clientSeq, 7);
    assert.equal(page.events[0].rec.text, rec.text);
  });

  it('refuses a missing fragment, a flipped byte, a different header and a bad fragment without creating the event', async () => {
    const { baseStore } = await boot();
    const who = identity(chatIdOf(21));
    const plan = planLargeRecord(recOfStoredBytes(400 * 1024));
    await stage(baseStore, who, 'queue-b', 1, plan, { order: plan.fragments.map((_, index) => index).filter((index) => index !== 3), tag: 'drop' });
    await rejectKind(finalize(baseStore, who, 'queue-b', 1, plan, 'drop-final'), 'history_large_incomplete');
    // Completing the stage afterwards makes the very same finalize succeed: refusal changed nothing.
    await stage(baseStore, who, 'queue-b', 1, plan, { order: [3], tag: 'late' });
    // A conflicting fragment at an existing index is a mismatch, never an overwrite.
    const tampered = plan.fragments[0].replace(/^./, plan.fragments[0][0] === 'A' ? 'B' : 'A');
    await rejectKind(baseStore.stageFragment({ ...who, producerId: 'queue-b', clientSeq: 1, index: 0, count: plan.large.fragments, totalBytes: plan.large.bytes, sha256: plan.large.sha256, data: tampered, commandId: 'tamper' }), 'history_stage_mismatch');
    await rejectKind(baseStore.stageFragment({ ...who, producerId: 'queue-b', clientSeq: 1, index: 0, count: plan.large.fragments, totalBytes: plan.large.bytes, sha256: '0'.repeat(64), data: plan.fragments[0], commandId: 'header' }), 'history_stage_mismatch');
    await rejectKind(baseStore.stageFragment({ ...who, producerId: 'queue-b', clientSeq: 1, index: 0, count: plan.large.fragments, totalBytes: plan.large.bytes, sha256: plan.large.sha256, data: 'not base64!', commandId: 'b64' }), 'history_invalid_large');
    await rejectKind(baseStore.stageFragment({ ...who, producerId: 'queue-b', clientSeq: 1, index: plan.large.fragments, count: plan.large.fragments, totalBytes: plan.large.bytes, sha256: plan.large.sha256, data: plan.fragments[0], commandId: 'range' }), 'history_invalid_large');
    await rejectKind(baseStore.stageFragment({ ...who, producerId: 'queue-b', clientSeq: 1, index: 1, count: plan.large.fragments, totalBytes: plan.large.bytes, sha256: plan.large.sha256, data: plan.fragments.at(-1), commandId: 'size' }), 'history_invalid_large');
    // A descriptor that disagrees with the staged header is refused too.
    await rejectKind(baseStore.appendEvents({ ...who, producerId: 'queue-b', commandId: 'wrong-final', events: [{ clientSeq: 1, large: { ...plan.large, sha256: 'f'.repeat(64) } }] }), 'history_stage_mismatch');
    // Same length, different content: only the hash can tell; staged under another key so the header matches it.
    const flipped = planLargeRecord(recOfStoredBytes(400 * 1024, 'unicode'));
    await stage(baseStore, who, 'queue-b', 2, flipped, { tag: 'flip', mutate: (index, data) => (index === 1 ? Buffer.from(Buffer.from(data, 'base64').map((byte, at) => (at === 5 ? byte ^ 1 : byte))).toString('base64') : data) });
    await rejectKind(finalize(baseStore, who, 'queue-b', 2, flipped, 'flip-final'), 'history_large_digest_mismatch');
    assert.equal((await baseStore.readPage({ ...who, limit: 10 })).events.length, 0, 'no refusal produced an event');
    const ok = await finalize(baseStore, who, 'queue-b', 1, plan, 'drop-final');
    assert.equal(ok.result.accepted[0].seq, 1);
    // Bytes that hash correctly but are not a valid record never become an event.
    const garbage = Buffer.from('{"kind":"nope"}');
    const garbagePlan = { large: { bytes: garbage.length, fragments: 1, sha256: (await import('node:crypto')).createHash('sha256').update(garbage).digest('hex') }, fragments: [garbage.toString('base64')] };
    await stage(baseStore, who, 'queue-b', 3, garbagePlan, { tag: 'garbage' });
    await rejectKind(finalize(baseStore, who, 'queue-b', 3, garbagePlan, 'garbage-final'), 'history_large_invalid');
  });

  it('a finalized large record never coalesces and a later stream delta starts its own event', async () => {
    const { baseStore } = await boot();
    const who = identity(chatIdOf(22));
    const producer = 'server:run:c1:attempt:1';
    await baseStore.appendEvents({ ...who, producerId: producer, commandId: 'c-1', events: [{ clientSeq: 1, rec: assistantRec('small tail ') }] });
    const big = { ...assistantRec('B'.repeat(300 * 1024)) };
    const plan = planLargeRecord(big);
    await stage(baseStore, who, producer, 2, plan);
    const finalAck = await finalize(baseStore, who, producer, 2, plan, 'c-2');
    assert.equal(finalAck.result.accepted[0].seq, 2, 'did not merge into the small tail');
    const delta = await baseStore.appendEvents({ ...who, producerId: producer, commandId: 'c-3', events: [{ clientSeq: 3, rec: assistantRec('more') }] });
    assert.equal(delta.result.accepted[0].seq, 3, 'a delta never grows a record past the regular cap');
    const page = await baseStore.readPage({ ...who, limit: 10 });
    assert.deepEqual(page.events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(page.events[1].rec.event.message.content[0].text.length, 300 * 1024);
  });

  it('epoch reset during staging fences the stage: cleared with the reset, stale on both sides, nothing visible', async () => {
    const { baseStore } = await boot();
    const chat = chatIdOf(23);
    const who = identity(chat);
    await baseStore.appendEvents({ ...who, producerId: 'queue-r', commandId: 'seed', events: [{ clientSeq: 1, rec: userRec('seed') }] });
    const plan = planLargeRecord(recOfStoredBytes(500 * 1024));
    await stage(baseStore, who, 'queue-r', 2, plan, { order: [0, 1], tag: 'half' });
    assert.equal(await stagedCount(baseStore), 1);
    await baseStore.reset({ ...who, newChatEpoch: 'ep.2', commandId: 'reset-1' });
    assert.equal(await stagedCount(baseStore), 0, 'the reset removed the stale stage in the same transaction');
    await rejectKind(stage(baseStore, who, 'queue-r', 2, plan, { order: [2], tag: 'late' }), 'history_stale_epoch');
    await rejectKind(finalize(baseStore, who, 'queue-r', 2, plan, 'stale-final'), 'history_stale_epoch');
    // The old producer is fenced even under the new epoch.
    await rejectKind(stage(baseStore, identity(chat, 'ep.2'), 'queue-r', 2, plan, { order: [0], tag: 'fenced' }), 'history_producer_fenced');
    assert.equal((await baseStore.readPage({ ...identity(chat, 'ep.2'), limit: 10 })).events.length, 0);
  });

  it('bounds the staging by count and bytes with a retryable refusal and no partial reservation; abandon frees quota', async () => {
    const { baseStore } = await boot();
    const who = identity(chatIdOf(24));
    const plan = planLargeRecord(recOfStoredBytes(HISTORY_MAX_LARGE_RECORD_BYTES));
    for (let slot = 0; slot < HISTORY_STAGE_MAX_PER_CHAT; slot += 1) {
      await stage(baseStore, who, `queue-q${slot}`, 1, plan, { order: [0], tag: `q${slot}` });
    }
    const refused = baseStore.stageFragment({ ...who, producerId: 'queue-extra', clientSeq: 1, index: 0, count: plan.large.fragments, totalBytes: plan.large.bytes, sha256: plan.large.sha256, data: plan.fragments[0], commandId: 'extra' });
    await assert.rejects(refused, (error) => error.details.conflictKind === 'history_stage_quota' && error.retryable === true && error.details.commitState === 'not_committed');
    assert.equal(await stagedCount(baseStore), HISTORY_STAGE_MAX_PER_CHAT, 'the refusal left no header behind');
    const header = (await baseStore.listStages({ datasetGeneration: GENERATION })).stages[0];
    // A newer stage under the same key must not be removed by a GC that looked at an older one.
    assert.equal((await baseStore.abandonStage({ datasetGeneration: GENERATION, chatId: header.chatId, producerId: header.producerId, clientSeq: header.clientSeq, createdBefore: header.createdAt - 1, commandId: 'guard' })).result.abandoned, false);
    assert.equal((await baseStore.abandonStage({ datasetGeneration: GENERATION, chatId: header.chatId, producerId: header.producerId, clientSeq: header.clientSeq, createdBefore: header.createdAt, commandId: 'abandon' })).result.abandoned, true);
    await stage(baseStore, who, 'queue-extra', 1, plan, { order: [0], tag: 'extra-ok' });
    assert.ok(HISTORY_STAGE_LIST_PAGE_MAX >= 1);
  });

  it('garbage-collects only stages that can never be finalized (retired producer, replaced epoch)', async () => {
    const { baseStore } = await boot();
    const who = identity(chatIdOf(25));
    await baseStore.appendEvents({ ...who, producerId: 'queue-live', commandId: 'seed', events: [{ clientSeq: 1, rec: userRec('seed') }] });
    const plan = planLargeRecord(recOfStoredBytes(300 * 1024));
    await stage(baseStore, who, 'queue-live', 2, plan, { order: [0], tag: 'live' });
    await stage(baseStore, who, 'queue-dead', 1, plan, { order: [0], tag: 'dead' });
    assert.equal((await baseStore.gcSupersededStages({ datasetGeneration: GENERATION, commandId: 'gc-0' })).result.removed, 0, 'both can still be finalized');
    // The first write of a brand-new chat may BE the staged large record: no state row is not "superseded".
    await stage(baseStore, identity(chatIdOf(26)), 'queue-new', 1, plan, { order: [0], tag: 'brand-new-chat' });
    assert.equal((await baseStore.gcSupersededStages({ datasetGeneration: GENERATION, commandId: 'gc-new' })).result.removed, 0);
    await baseStore.retireProducer({ ...who, producerId: 'queue-dead', commandId: 'retire' });
    const outcome = await baseStore.gcSupersededStages({ datasetGeneration: GENERATION, commandId: 'gc-1' });
    assert.equal(outcome.result.removed, 1);
    const left = (await baseStore.listStages({ datasetGeneration: GENERATION })).stages;
    assert.deepEqual(left.map((stage_) => stage_.producerId).sort(), ['queue-live', 'queue-new']);
  });
});

describe('adapter: crash, lost reply, restart and partial staging', () => {
  /** Resolve-failing wrapper: the commit outcome of a faulted command stays unknown to the adapter. */
  function faulty(plan) {
    const state = { stageFailures: 0, finalFailures: 0, hits: [] };
    const wrap = (store) => ({
      ...store,
      stageFragment: async (args) => {
        if (plan.failStageIndex !== undefined && args.index === plan.failStageIndex && state.stageFailures < (plan.stageTimes ?? 1)) {
          state.stageFailures += 1;
          throw new StorageError('unknown_commit', 'lost', { details: { operation: 'history', commitState: 'unknown' } });
        }
        return store.stageFragment(args);
      },
      appendEvents: async (args) => {
        if (args.events?.[0]?.large && plan.lostFinalReply && state.finalFailures < 1) {
          state.finalFailures += 1;
          await store.appendEvents(args); // committed, reply lost
          throw new StorageError('unknown_commit', 'lost reply', { details: { operation: 'history', commitState: 'unknown' } });
        }
        return store.appendEvents(args);
      },
      resolveUnknown: async (args) => {
        if (plan.blockResolve && state.blocked !== false) throw new StorageError('io', 'cannot reconcile', { retryable: false });
        return store.resolveUnknown(args);
      },
    });
    return { state, wrap, unblock: () => { state.blocked = false; } };
  }

  it('partial staging then a lost commit state: ONE pending entry, nothing visible, retryToken completes with the same identity exactly once', async () => {
    const fault = faulty({ failStageIndex: 3, blockResolve: true });
    const parts = await boot({ wrapStore: fault.wrap });
    const chat = chatIdOf(30);
    const rec = recOfStoredBytes(PREFLIGHT_MAX_RECORD, 'unicode');
    let failure;
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, 'c', [{ rec: userRec('prefix') }, { rec }]), (error) => { failure = error; return error.code === 'history_commit_unknown'; });
    const token = failure.details.retryToken;
    assert.ok(token);
    const pending = parts.pendingBuffer.list();
    assert.equal(pending.filter((entry) => entry.operation === 'appendLarge').length, 1, 'the whole record is one durable entry (one fsync), not one per fragment');
    assert.ok(pending.every((entry) => entry.batch.id === token));
    assert.equal((await parts.baseStore.listStages({ datasetGeneration: GENERATION })).stages.length, 1, 'partial fragments are staged');
    const visible = await parts.baseStore.readPage({ ...identity(chat, (await parts.baseStore.readRevision({ ...identity(chat), anyEpoch: true })).chatEpoch), limit: 10 });
    assert.deepEqual(visible.events.map((event) => event.rec.text?.slice(0, 6)), ['prefix'], 'only the committed prefix chunk is history; the staged fragments are not');
    fault.unblock();
    const ok = await parts.adapter.appendChatHistoryEvents(chat, 'c', [{ rec: userRec('prefix') }, { rec }], { retryToken: token });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.appended.map((entry) => entry.seq), [1, 2]);
    assert.ok(sameJson(ok.appended[1].rec, rec));
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    assert.equal(await stagedCount(parts.baseStore), 0);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 2, 'exactly once');
  });

  it('crash after the finalizing receipt (reply lost): the retry is answered from the receipt without staging again', async () => {
    const fault = faulty({ lostFinalReply: true, blockResolve: true });
    const parts = await boot({ wrapStore: fault.wrap });
    const chat = chatIdOf(31);
    const rec = recOfStoredBytes(1024 * 1024);
    let failure;
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }]), (error) => { failure = error; return error.code === 'history_commit_unknown'; });
    assert.equal(parts.pendingBuffer.stats().entries, 1);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1, 'the event committed before the reply was lost');
    fault.unblock();
    const ok = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }], { retryToken: failure.details.retryToken });
    assert.equal(ok.replayed, true);
    assert.deepEqual(ok.appended.map((entry) => entry.seq), [1]);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });

  it('a real worker kill right after the finalizing COMMIT is reconciled from the receipt with exactly one event', async () => {
    const parts = await boot({
      handlersPath: FAULT_HANDLERS_PATH,
      faultInjection: true,
      wrapStore: (store, host) => ({
        ...store,
        appendEvents: async (args) => {
          if (args.events?.[0]?.large) await host.command('test.arm', { commandId: args.commandId, mode: 'afterCommitExit' });
          return store.appendEvents(args);
        },
      }),
    });
    const chat = chatIdOf(32);
    const rec = recOfStoredBytes(600 * 1024);
    const result = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }]);
    assert.equal(result.ok, true);
    assert.equal(result.replayed, true);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 1);
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    assert.equal(await stagedCount(parts.baseStore), 0);
  });

  it('after a process restart the pending large entry is replayed by recovery exactly once, with its notification', async () => {
    const notified = [];
    const fault = faulty({ failStageIndex: 5, blockResolve: true });
    const first = await boot({ wrapStore: fault.wrap });
    const chat = chatIdOf(33);
    const rec = recOfStoredBytes(1500 * 1024, 'unicode');
    await assert.rejects(first.adapter.appendChatHistoryEvents(chat, '', [{ rec }]), (error) => error.code === 'history_commit_unknown');
    await first.close();
    booted.splice(booted.indexOf(first), 1);
    const second = await boot({ onCommitted: (event) => notified.push(event) });
    assert.equal(second.pendingBuffer.stats().entries, 1, 'the entry (3 MiB class) survived the restart');
    const summary = await second.backend.recoverPending();
    assert.equal(summary.committed, 1);
    assert.deepEqual(summary.quarantined, []);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].recovered, true);
    const page = await second.adapter.getChatHistorySince(chat, 0, 10);
    assert.equal(page.events.length, 1);
    assert.ok(sameJson(page.events[0].rec, rec));
    assert.equal(second.pendingBuffer.stats().entries, 0);
    assert.equal(await stagedCount(second.baseStore), 0);
    assert.equal((await second.backend.recoverPending()).replayed, 0);
  });

  it('F4: after a restart the loaded large entry is frozen (get/list/listBatch): mutation throws, disk bytes stay canonical, recovery finalizes the original exactly once', async () => {
    const fault = faulty({ failStageIndex: 5, blockResolve: true });
    const first = await boot({ wrapStore: fault.wrap });
    const chat = chatIdOf(35);
    const rec = recOfStoredBytes(400 * 1024, 'unicode');
    await assert.rejects(first.adapter.appendChatHistoryEvents(chat, '', [{ rec }]), (error) => error.code === 'history_commit_unknown');
    await first.close();
    booted.splice(booted.indexOf(first), 1);
    const entriesDir = path.join(root, 'pending', 'entries');
    const files = fs.readdirSync(entriesDir);
    assert.equal(files.length, 1);
    const before = fs.readFileSync(path.join(entriesDir, files[0]));
    const second = await boot();
    const [listed] = second.pendingBuffer.list();
    const views = [listed, second.pendingBuffer.get(listed.commandId), ...(listed.batch ? second.pendingBuffer.listBatch(listed.batch.id) : [])];
    for (const view of views) {
      assert.equal(Object.isFrozen(view), true);
      assert.equal(Object.isFrozen(view.payload), true);
      assert.throws(() => { view.payload.datasetGeneration = 'x'; }, TypeError);
      assert.throws(() => { view.payload.events = []; }, TypeError);
      assert.throws(() => { view.order = 99; }, TypeError);
    }
    assert.deepEqual(fs.readFileSync(path.join(entriesDir, files[0])), before, 'the canonical bytes are untouched');
    const summary = await second.backend.recoverPending();
    assert.equal(summary.committed, 1);
    assert.deepEqual(summary.quarantined, []);
    const page = await second.adapter.getChatHistorySince(chat, 0, 10);
    assert.equal(page.events.length, 1);
    assert.ok(sameJson(page.events[0].rec, rec), 'the original record, not a mutated one');
    assert.equal(second.pendingBuffer.stats().entries, 0);
  });

  it('epoch reset between staging and finalization: stale-epoch refusal, the plan is discarded, no event and no staging remain', async () => {
    const fault = faulty({ failStageIndex: 4, blockResolve: true });
    const parts = await boot({ wrapStore: fault.wrap });
    const chat = chatIdOf(34);
    await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('seed') }]);
    const epoch = (await parts.baseStore.readRevision({ ...identity(chat), anyEpoch: true })).chatEpoch;
    const rec = recOfStoredBytes(800 * 1024);
    let failure;
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }]), (error) => { failure = error; return error.code === 'history_commit_unknown'; });
    await parts.baseStore.reset({ ...identity(chat, epoch), newChatEpoch: 'ep.reset', commandId: 'reset-x' });
    fault.unblock();
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }], { retryToken: failure.details.retryToken }),
      (error) => error.details?.conflictKind === 'history_stale_epoch');
    assert.equal(parts.pendingBuffer.stats().entries, 0, 'a known-not-committed refusal drops the plan durably');
    assert.equal(await stagedCount(parts.baseStore), 0);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 0);
  });

  it('quota exhaustion is a retryable refusal before any ACK: nothing committed, input not recorded, and it works after space is freed', async () => {
    const parts = await boot();
    const chat = chatIdOf(35);
    const epoch = 'ep.quota';
    const blocker = planLargeRecord(recOfStoredBytes(HISTORY_MAX_LARGE_RECORD_BYTES));
    for (let slot = 0; slot < HISTORY_STAGE_MAX_PER_CHAT; slot += 1) {
      await stage(parts.baseStore, identity(chat, epoch), `queue-b${slot}`, 1, blocker, { order: [0], tag: `blk${slot}` });
    }
    const rec = recOfStoredBytes(400 * 1024);
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }], { chatEpoch: epoch }),
      (error) => error.details?.conflictKind === 'history_stage_quota' && error.details.commitState === 'not_committed');
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 0);
    const header = (await parts.baseStore.listStages({ datasetGeneration: GENERATION })).stages[0];
    await parts.baseStore.abandonStage({ datasetGeneration: GENERATION, chatId: header.chatId, producerId: header.producerId, clientSeq: header.clientSeq, commandId: 'free' });
    const ok = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }], { chatEpoch: epoch });
    assert.equal(ok.ok, true);
  });

  it('gcLargeStaging keeps a stage that a pending entry still needs and removes an old unreferenced one', async () => {
    const fault = faulty({ failStageIndex: 2, blockResolve: true });
    const parts = await boot({ wrapStore: fault.wrap });
    const chat = chatIdOf(36);
    const rec = recOfStoredBytes(300 * 1024);
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }]), (error) => error.code === 'history_commit_unknown');
    // An orphan of the same server producer family (its input was discarded long ago).
    const orphan = planLargeRecord(recOfStoredBytes(300 * 1024, 'unicode'));
    await stage(parts.baseStore, identity(chat, (await parts.baseStore.listStages({ datasetGeneration: GENERATION })).stages[0].chatEpoch), 'server:run:old:attempt:1', 99, orphan, { order: [0], tag: 'orphan' });
    assert.equal(await stagedCount(parts.baseStore), 2);
    const fresh = await parts.backend.gcLargeStaging({ olderThanMs: 3_600_000 });
    assert.equal(fresh.abandoned, 0, 'nothing is old enough');
    const later = await parts.backend.gcLargeStaging({ olderThanMs: 1000, nowMs: Date.now() + 60_000 });
    assert.equal(later.abandoned, 1, 'only the unreferenced orphan');
    assert.equal(await stagedCount(parts.baseStore), 1, 'the stage of the pending entry survived');
    fault.unblock();
    const token = parts.pendingBuffer.list()[0].batch.id;
    const ok = await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec }], { retryToken: token });
    assert.equal(ok.ok, true);
  });
});

describe('fork, trim, reset and rollback with large records', () => {
  it('a fork copies large events byte for byte; trim and reset leave no staged remainder; new large writes survive a read-only rollback export', async () => {
    const parts = await boot();
    const source = chatIdOf(40);
    const target = chatIdOf(41);
    const recs = [recOfStoredBytes(400 * 1024, 'unicode'), recOfStoredBytes(PREFLIGHT_MAX_RECORD)];
    await parts.adapter.appendChatHistoryEvents(source, 'cursor-s', [{ rec: userRec('first') }, { rec: recs[0] }]);
    await parts.adapter.appendChatHistoryEvents(source, 'cursor-s', [{ rec: recs[1] }, { rec: userRec('last') }]);
    const sourcePage = await parts.adapter.getChatHistorySince(source, 0, 10);
    assert.equal(sourcePage.events.length, 4);
    await parts.adapter.copyChatHistory(source, target, 'cursor-t');
    const forkPage = await parts.adapter.getChatHistorySince(target, 0, 10);
    assert.ok(sameJson(forkPage.events.map((event) => event.rec), sourcePage.events.map((event) => event.rec)), 'fork is byte-identical');
    // Writes after the fork land in the new epoch and are large-capable.
    const afterFork = recOfStoredBytes(900 * 1024);
    const appended = await parts.adapter.appendChatHistoryEvents(target, '', [{ rec: afterFork }]);
    assert.equal(appended.appended[0].seq, 5);
    const sourceEpoch = (await parts.baseStore.readRevision({ ...identity(source), anyEpoch: true })).chatEpoch;
    await parts.baseStore.trim({ ...identity(source, sourceEpoch), keepLast: 2, commandId: 'trim-1' });
    const trimmed = await parts.adapter.getChatHistorySince(source, 0, 10);
    assert.deepEqual(trimmed.events.map((event) => event.seq), [3, 4], 'trim drops the oldest rows, large or not');
    assert.ok(sameJson(trimmed.events[0].rec, recs[1]));
    // Leave one uncommitted stage behind: it is reported and ignored by the export.
    const stray = planLargeRecord(recOfStoredBytes(300 * 1024));
    await stage(parts.baseStore, identity(chatIdOf(42), 'ep.stray'), 'queue-stray', 1, stray, { order: [0], tag: 'stray' });
    const dbDir = parts.dbDir;
    await parts.close();
    booted.splice(booted.indexOf(parts), 1);
    const wal = path.join(dbDir, 'cretli-store.sqlite-wal');
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      const db = new DatabaseSync(path.join(dbDir, 'cretli-store.sqlite'));
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    }
    const plan = planRollbackExport({ storeDir: dbDir });
    assert.equal(plan.totals.uncommittedStagedRecords, 1);
    assert.equal(plan.totals.chats, 2);
    const out = path.join(makeTempDir('cretli-large-roll-'), 'export');
    try {
      applyRollbackExport({ storeDir: dbDir, legacyOut: out, confirmPlanHash: plan.planHash });
      assert.equal(verifyRollbackExport({ exportDir: out, storeDir: dbDir }).sourceUnchanged, true);
      const exported = readLegacyHistoryFile(path.join(out, 'legacy-chat-history', `${target}.json`)).doc;
      assert.equal(exported.events.length, 5);
      assert.equal(exported.headSeq, 5);
      assert.ok(sameJson(exported.events.at(-1).rec, afterFork), 'the post-fork large write is in the export (store-added clientSeq stripped)');
      assert.ok(sameJson(exported.events.slice(0, 4).map((event) => event.rec), sourcePage.events.map((event) => event.rec)));
      const sourceExport = readLegacyHistoryFile(path.join(out, 'legacy-chat-history', `${source}.json`)).doc;
      assert.ok(sameJson(sourceExport.events[0].rec, recs[1]));
    } finally {
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
    }
  });
});

describe('offline import: large source records and protected ignore files', () => {
  const GEN = 'gen-large-import';
  const legacyDoc = (chatId, events) => ({ v: 1, chatId, cursorSessionId: 's', headSeq: events.at(-1).seq, updatedAt: '2026-10-19T10:00:00.000Z', events });

  it('imports 256 KiB..2686612 B records verbatim, preserves unknown keys/gaps, treats exact .cursorignore/.rgignore as protected metadata and refuses everything else unknown', () => {
    const work = makeTempDir('cretli-large-import-');
    try {
      const legacyDir = path.join(work, 'chat-history');
      fs.mkdirSync(legacyDir);
      const a = 'aaaaaaaa-0000-4000-8000-0000000000a1';
      const b = 'aaaaaaaa-0000-4000-8000-0000000000a2';
      const recs = [recOfStoredBytes(HISTORY_MAX_RECORD_BYTES + 1, 'unicode'), recOfStoredBytes(1024 * 1024), recOfStoredBytes(PREFLIGHT_MAX_RECORD, 'unicode')];
      // The source wire form is what the legacy writer produced; WIDEST padding only makes the size an upper bound here.
      const docA = legacyDoc(a, [{ seq: 2, rec: recs[0], origin: 'tool' }, { seq: 5, rec: recs[1] }, { seq: 9, rec: { ...recs[2], clientSeq: 4, futureField: { deep: [1] } } }]);
      docA.futureDoc = { keep: true };
      const docB = legacyDoc(b, [{ seq: 1, rec: userRec('small') }]);
      fs.writeFileSync(path.join(legacyDir, `${a}.json`), JSON.stringify(docA, null, 2));
      fs.writeFileSync(path.join(legacyDir, `${b}.json`), JSON.stringify(docB, null, 2));
      fs.writeFileSync(path.join(legacyDir, '.cursorignore'), '*.secret\n');
      fs.writeFileSync(path.join(legacyDir, '.rgignore'), '!keep\n');
      const before = Object.fromEntries(fs.readdirSync(legacyDir).map((name) => [name, fs.readFileSync(path.join(legacyDir, name)).toString('base64')]));
      const plan = planLegacyImport({ legacyDir, datasetGeneration: GEN });
      assert.equal(plan.ok, true, JSON.stringify(plan.refusals));
      assert.deepEqual(plan.protectedIgnored.map((item) => item.file), ['.cursorignore', '.rgignore']);
      assert.ok(plan.protectedIgnored.every((item) => item.sha256.length === 64 && item.bytes > 0));
      assert.deepEqual(plan.refusals, []);
      assert.equal(plan.totals.chats, 2);
      const out = path.join(work, 'staging');
      applyLegacyImport({ legacyDir, stagingOut: out, datasetGeneration: GEN, confirmPlanHash: plan.planHash });
      const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.protectedIgnoredEntries.map((item) => item.file), ['.cursorignore', '.rgignore']);
      const db = new DatabaseSync(path.join(out, 'cretli-store.sqlite'), { readOnly: true });
      try {
        const rows = db.prepare('SELECT seq, payload_json FROM chat_history_events WHERE chat_id = ? ORDER BY seq').all(a);
        assert.deepEqual(rows.map((row) => row.seq), [2, 5, 9], 'sequence gaps kept');
        assert.ok(sameJson(JSON.parse(rows[0].payload_json), recs[0]));
        assert.ok(sameJson(JSON.parse(rows[2].payload_json), { ...recs[2], clientSeq: 4, futureField: { deep: [1] } }));
        assert.equal(JSON.parse(db.prepare('SELECT extra_json FROM chat_history_event_extra WHERE chat_id = ? AND seq = 2').get(a).extra_json).origin, 'tool');
        assert.equal(Number(db.prepare('SELECT count(*) AS n FROM chat_history_stage').get().n), 0);
      } finally {
        db.close();
      }
      // The live store reads it through the normal paths, and the rollback export returns the identical legacy content.
      const after = Object.fromEntries(fs.readdirSync(legacyDir).map((name) => [name, fs.readFileSync(path.join(legacyDir, name)).toString('base64')]));
      assert.deepEqual(after, before, 'source (including the protected files) is byte-identical and nothing was removed');
      const liveDir = path.join(work, 'live');
      fs.mkdirSync(liveDir);
      fs.copyFileSync(path.join(out, 'cretli-store.sqlite'), path.join(liveDir, 'cretli-store.sqlite'));
      const rollbackPlan = planRollbackExport({ storeDir: liveDir });
      const exportDir = path.join(work, 'export');
      applyRollbackExport({ storeDir: liveDir, legacyOut: exportDir, confirmPlanHash: rollbackPlan.planHash });
      const exported = readLegacyHistoryFile(path.join(exportDir, 'legacy-chat-history', `${a}.json`));
      const original = readLegacyHistoryFile(path.join(legacyDir, `${a}.json`));
      assert.equal(exported.doc.events.length, 3);
      assert.ok(sameJson(exported.doc.events.map((event) => [event.seq, event.rec, event.extra]), original.doc.events.map((event) => [event.seq, event.rec, event.extra])));
      assert.ok(sameJson(exported.doc.docExtra, original.doc.docExtra));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('refuses a record above the large cap whole-plan, a symlinked/directory .cursorignore and any other unknown entry', () => {
    const work = makeTempDir('cretli-large-import-refuse-');
    try {
      const legacyDir = path.join(work, 'chat-history');
      fs.mkdirSync(legacyDir);
      const a = 'aaaaaaaa-0000-4000-8000-0000000000b1';
      fs.writeFileSync(path.join(legacyDir, `${a}.json`), JSON.stringify(legacyDoc(a, [{ seq: 1, rec: userRec('x'.repeat(HISTORY_MAX_LARGE_RECORD_BYTES)) }])));
      fs.symlinkSync(path.join(legacyDir, `${a}.json`), path.join(legacyDir, '.cursorignore'));
      fs.mkdirSync(path.join(legacyDir, '.rgignore'));
      fs.writeFileSync(path.join(legacyDir, '.gitignore'), 'x');
      const plan = planLegacyImport({ legacyDir, datasetGeneration: GEN });
      assert.equal(plan.ok, false);
      const byFile = Object.fromEntries(plan.refusals.map((item) => [item.file, item.code]));
      assert.equal(byFile[`${a}.json`], 'legacy_record_too_large');
      assert.equal(byFile['.cursorignore'], 'legacy_unexpected_entry', 'only a regular file with the exact name is protected');
      assert.equal(byFile['.rgignore'], 'legacy_unexpected_entry');
      assert.equal(byFile['.gitignore'], 'legacy_unexpected_entry');
      assert.deepEqual(plan.protectedIgnored, []);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
