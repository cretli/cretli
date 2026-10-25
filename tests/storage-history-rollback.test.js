import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  SYNTHETIC_IDS, assistantRec, copyFullSyntheticDataset, makeTempDir, padText, userRec,
} from './fixtures/storage-history-synthetic.js';
import { applyLegacyImport, planLegacyImport } from '../lib/storage/history-import.js';
import { applyRollbackExport, planRollbackExport, verifyRollbackExport } from '../lib/storage/history-rollback.js';
import { readLegacyHistoryFile } from '../lib/storage/history-legacy-format.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { createChatHistoryStore, HISTORY_GROUP_MAX_MEMBER_BYTES } from '../lib/storage/chat-history-store.js';
import { readSdkHistoryStreamText } from '../lib/sdk/sdk-history-stream-coalesce.ts';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';

const GENERATION = 'generation-rollback-1';
const EPOCH = 'legacy-import';
const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-chat-history-handlers.js', import.meta.url));
const SERVER_PRODUCER = 'run:7f3a:attempt:1';
const BROWSER_PRODUCER = 'queue-device-9c1e';
const dataRoot = makeTempDir('cretli-roll-data-');
let seedDir;
let baseWork;
let stagedDb;
let work;
let liveDir;
let hosts;
let committers;

before(async () => {
  seedDir = await copyFullSyntheticDataset(dataRoot, path.join(makeTempDir('cretli-roll-seed-'), 'chat-history'));
  baseWork = makeTempDir('cretli-roll-base-');
  const plan = planLegacyImport({ legacyDir: seedDir, datasetGeneration: GENERATION });
  applyLegacyImport({ legacyDir: seedDir, stagingOut: path.join(baseWork, 'staging'), datasetGeneration: GENERATION, confirmPlanHash: plan.planHash });
  stagedDb = path.join(baseWork, 'staging', 'cretli-store.sqlite');
});

after(() => {
  for (const dir of [dataRoot, path.dirname(seedDir), baseWork]) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  work = makeTempDir('cretli-roll-work-');
  liveDir = path.join(work, 'live');
  fs.mkdirSync(liveDir);
  // The staging artifact is never mutated: a copy plays the production store after cutover.
  fs.copyFileSync(stagedDb, path.join(liveDir, 'cretli-store.sqlite'));
  hosts = [];
  committers = [];
});

afterEach(async () => {
  for (const committer of committers) await committer.close().catch(() => {});
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
});

/** @returns {Promise<{ host: ReturnType<typeof createStorageWorkerHost>, store: ReturnType<typeof createChatHistoryStore>, big: ReturnType<typeof createChatHistoryStore> }>} */
async function startLive() {
  const host = createStorageWorkerHost({ dbDir: liveDir, handlersPath: HANDLERS_PATH, faultInjection: true, restartBackoffMs: { initial: 5, max: 20 }, writeGate: WRITE_GATE_TEST_EXEMPTION });
  hosts.push(host);
  await host.start();
  const committer = createGroupCommitter({ host, windowMs: 1, maxMemberBytes: HISTORY_GROUP_MAX_MEMBER_BYTES });
  committers.push(committer);
  return { host, store: createChatHistoryStore({ host }), big: createChatHistoryStore({ host, groupCommitter: committer }) };
}

/** Close the writers the way an operator would (clean close), leaving a self-contained database file. */
async function closeLive() {
  for (const committer of committers) await committer.close();
  for (const host of hosts) await host.close({ timeoutMs: 2000 });
  committers = [];
  hosts = [];
  const wal = path.join(liveDir, 'cretli-store.sqlite-wal');
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    const db = new DatabaseSync(path.join(liveDir, 'cretli-store.sqlite'));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

/** @param {string} chatId @param {string} [epoch] */
function ns(chatId, epoch = EPOCH) {
  return { datasetGeneration: GENERATION, chatId, chatEpoch: epoch };
}

/** @param {ReturnType<typeof createChatHistoryStore>} store @param {ReturnType<typeof ns>} identity */
async function readAll(store, identity) {
  const events = [];
  let page = await store.readLatest({ ...identity, limit: 500 });
  const state = page;
  for (;;) {
    events.unshift(...page.events);
    if (!page.hasMore || page.events.length === 0) break;
    page = await store.readPage({ ...identity, beforeSeq: page.events[0].seq, limit: 500 });
  }
  return { events, headSeq: state.headSeq };
}

/** The legacy rendering of a store event: the store-added clientSeq of non-import producers is not exported. */
function legacyRec(event) {
  const rec = structuredClone(event.rec);
  if (event.producerId !== 'legacy-import') delete rec.clientSeq;
  return rec;
}

const text = (rec) => readSdkHistoryStreamText(rec);

/**
 * Drive a realistic post-cutover workload and return every acknowledgement.
 * @returns {Promise<{ acks: Array<{ commandId: string, chatId: string, result: any }>, fenceEpoch: number }>}
 */
async function runPostImportWorkload() {
  const { host, store, big } = await startLive();
  const acks = [];
  /** @param {string} commandId @param {ReturnType<typeof ns>} identity @param {string} producerId @param {any[]} events @param {object} [via] */
  const append = async (commandId, identity, producerId, events, via = store) => {
    const { result } = await via.appendEvents({ ...identity, producerId, commandId, events });
    acks.push({ commandId, chatId: identity.chatId, result });
    return result;
  };
  const live = ns(SYNTHETIC_IDS.live);
  // Server run: user turn + a streamed answer; the two deltas coalesce into ONE event of this producer.
  const first = await append('hist:run1:append:1', live, SERVER_PRODUCER, [
    { clientSeq: 1, rec: userRec('new question after cutover') },
    { clientSeq: 2, rec: assistantRec('par') }, { clientSeq: 3, rec: assistantRec('tial') },
  ]);
  assert.equal(first.accepted[1].seq, first.accepted[2].seq, 'coalesced into one event');
  assert.equal(first.accepted[0].seq, 5, 'continues after the legacy headSeq');
  // Browser queue replays an input under a NEW command id: duplicate, same seq, no second event.
  const duplicate = await store.appendEvents({ ...live, producerId: SERVER_PRODUCER, commandId: 'hist:run1:append:1-retry', events: [{ clientSeq: 1, rec: userRec('new question after cutover') }] });
  assert.equal(duplicate.result.accepted[0].duplicate, true);
  assert.equal(duplicate.result.accepted[0].seq, first.accepted[0].seq);
  await append('hist:browser:append:1', live, BROWSER_PRODUCER, [{ clientSeq: 1, rec: userRec('from the browser queue') }]);
  // A reply that is lost after COMMIT (worker dies right after commit): resolved through the receipt, never duplicated.
  const lost = { ...live, producerId: SERVER_PRODUCER, commandId: 'hist:run1:append:2', events: [{ clientSeq: 4, rec: userRec('acknowledged only by receipt') }] };
  await host.command('test.arm', { commandId: lost.commandId, mode: 'afterCommitExit' });
  await assert.rejects(store.appendEvents(lost), (error) => error.code === 'unknown_commit');
  const resolved = await store.resolveUnknown({ ...lost, operation: 'appendEvents' });
  assert.equal(resolved.outcome, 'committed');
  acks.push({ commandId: lost.commandId, chatId: lost.chatId, result: resolved.result });
  assert.equal((await store.appendEvents(lost)).replayed, true);
  // Large single-event command through the group committer (64-256 KiB class).
  await append('hist:run1:append:3', ns(SYNTHETIC_IDS.large), SERVER_PRODUCER, [{ clientSeq: 1, rec: userRec(padText(220 * 1024)) }], big);
  // A chat created after the import, with its own epoch.
  await append('hist:new:append:1', ns('fffffff0-0000-4000-8000-000000000001', 'epoch-new-1'), SERVER_PRODUCER, [{ clientSeq: 1, rec: userRec('brand new chat') }]);
  // Retention and reset are real policies, not rollback losses.
  await store.trim({ ...ns(SYNTHETIC_IDS.trimmed), commandId: 'hist:trim:1', keepLast: 5 });
  await store.reset({ ...ns(SYNTHETIC_IDS.gaps), commandId: 'hist:reset:1', newChatEpoch: 'epoch-reset-1' });
  await host.control('fence', { fenceEpoch: 7 });
  return { acks, fenceEpoch: 7 };
}

describe('rollback export after new durable writes', () => {
  it('exports every acknowledged post-import write, keeps receipts/fence metadata and stays strict-readable', async () => {
    const { acks, fenceEpoch } = await runPostImportWorkload();
    // Independent view of the truth: what the store itself serves right before shutdown.
    const { store } = await startLive();
    const chatIds = [...Object.values(SYNTHETIC_IDS), 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'fffffff0-0000-4000-8000-000000000001'];
    const served = {};
    for (const chatId of chatIds) {
      const epoch = { [SYNTHETIC_IDS.gaps]: 'epoch-reset-1', 'fffffff0-0000-4000-8000-000000000001': 'epoch-new-1' }[chatId] ?? EPOCH;
      served[chatId] = await readAll(store, ns(chatId, epoch));
    }
    await closeLive();

    const plan = planRollbackExport({ storeDir: liveDir });
    assert.equal(plan.totals.chats, chatIds.length);
    assert.equal(plan.storageFencingHwm, fenceEpoch);
    const out = path.join(work, 'rollback');
    const result = applyRollbackExport({ storeDir: liveDir, legacyOut: out, confirmPlanHash: plan.planHash });
    assert.equal(verifyRollbackExport({ exportDir: out, storeDir: liveDir }).sourceUnchanged, true);

    // 1. Every chat file equals what the store served (retention/reset applied, nothing else lost).
    for (const chatId of chatIds) {
      const exported = readLegacyHistoryFile(path.join(out, 'legacy-chat-history', `${chatId}.json`), { expectedChatId: chatId }).doc;
      assert.deepEqual(exported.events.map((e) => e.seq), served[chatId].events.map((e) => e.seq), chatId);
      assert.deepEqual(exported.events.map((e) => e.rec), served[chatId].events.map(legacyRec), chatId);
      assert.equal(exported.headSeq, served[chatId].headSeq, chatId);
    }
    // 2. Every acknowledged accepted input is present at its acknowledged seq with its content (unless retired by the explicit trim).
    let checked = 0;
    for (const ack of acks) {
      const exported = readLegacyHistoryFile(path.join(out, 'legacy-chat-history', `${ack.chatId}.json`)).doc;
      for (const accepted of ack.result.accepted) {
        const event = exported.events.find((e) => e.seq === accepted.seq);
        assert.ok(event, `ack ${ack.commandId} seq ${accepted.seq} must be in the export`);
        checked += 1;
      }
    }
    assert.ok(checked >= 6);
    const live = readLegacyHistoryFile(path.join(out, 'legacy-chat-history', `${SYNTHETIC_IDS.live}.json`)).doc;
    assert.equal(text(live.events.find((e) => e.seq === 6).rec), 'partial', 'coalesced stream content');
    assert.ok(live.events.slice(0, 4).every((e, i) => e.seq === i + 1), 'original events keep their seq');
    assert.equal(live.events.find((e) => e.seq === 1).rec.clientSeq, 1, 'imported client keys survive');
    assert.equal(live.events.find((e) => e.seq === 5).rec.clientSeq, undefined, 'producer-scoped counters are not exported as legacy-wide keys');
    // 3. Receipts: every acknowledged command is in the control sidecar with the identical result.
    const receipts = fs.readFileSync(path.join(out, 'rollback-control', 'receipts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const ack of acks) {
      const receipt = receipts.find((r) => r.commandId === ack.commandId);
      assert.ok(receipt, `receipt for ${ack.commandId}`);
      assert.deepEqual(receipt.result, ack.result);
    }
    // 4. Fencing / control metadata.
    const control = JSON.parse(fs.readFileSync(path.join(out, 'rollback-control', 'control.json'), 'utf8'));
    assert.equal(control.storageFencingHwm, fenceEpoch);
    assert.equal(control.requiredMinimumFenceEpoch, fenceEpoch + 1);
    assert.equal(control.plainLegacyBinaryCompatible, false);
    assert.equal(control.legacyAdapterRequired, true);
    assert.equal(control.quarantineBrowserQueues, true);
    assert.ok(control.controlDirActions.some((a) => a.action === 'write-restore-pause-marker'));
    const dedupe = fs.readFileSync(path.join(out, 'rollback-control', 'dedupe.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(dedupe.some((d) => d.producerId === SERVER_PRODUCER && d.clientSeq === 4));
    assert.ok(dedupe.some((d) => d.producerId === 'legacy-import' && d.chatId === SYNTHETIC_IDS.live));
    const identity = fs.readFileSync(path.join(out, 'rollback-control', 'event-identity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(identity.some((e) => e.producerId === BROWSER_PRODUCER && e.legacyProducer === false));
    // 5. Chats nobody touched export to their original files (the fixtures use the legacy writer's layout).
    for (const chatId of [SYNTHETIC_IDS.extras, 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002']) {
      assert.equal(
        fs.readFileSync(path.join(out, 'legacy-chat-history', `${chatId}.json`), 'utf8'),
        fs.readFileSync(path.join(seedDir, `${chatId}.json`), 'utf8'), chatId);
    }
    assert.equal(result.manifest.summary.chatsCreatedAfterImport, 1);
    const reset = result.manifest.chats.find((c) => c.chatId === SYNTHETIC_IDS.gaps);
    assert.ok(reset.warnings.includes('chat_epoch_changed') && reset.events === 0);
    // 6. The export is itself importable again (the format closes the loop).
    const again = planLegacyImport({ legacyDir: path.join(out, 'legacy-chat-history'), datasetGeneration: 'generation-roll-forward' });
    assert.equal(again.ok, true, JSON.stringify(again.refusals));
    assert.equal(again.totals.events, result.manifest.totals.events);
  });

  it('an untouched import exports to identical legacy documents for legacy-formatted fixtures (no new writes)', () => {
    const plan = planRollbackExport({ storeDir: liveDir });
    const out = path.join(work, 'rollback');
    const result = applyRollbackExport({ storeDir: liveDir, legacyOut: out, confirmPlanHash: plan.planHash });
    assert.equal(result.manifest.summary.chatsModifiedSinceImport, 0);
    for (const name of fs.readdirSync(seedDir)) {
      assert.equal(fs.readFileSync(path.join(out, 'legacy-chat-history', name), 'utf8'), fs.readFileSync(path.join(seedDir, name), 'utf8'), name);
    }
    assert.ok(result.manifest.chats.every((c) => c.matchesImportDigest === true));
  });

  it('a cursor session id supplied by the caller overrides the imported one', () => {
    const plan = planRollbackExport({ storeDir: liveDir });
    const out = path.join(work, 'rollback');
    applyRollbackExport({ storeDir: liveDir, legacyOut: out, confirmPlanHash: plan.planHash, cursorSessionIds: { [SYNTHETIC_IDS.live]: 'session-after-cutover' } });
    assert.equal(readLegacyHistoryFile(path.join(out, 'legacy-chat-history', `${SYNTHETIC_IDS.live}.json`)).doc.cursorSessionId, 'session-after-cutover');
  });
});

describe('rollback export safety', () => {
  it('refuses a store with a live WAL, a stale plan hash, a foreign database and overlapping outputs', async () => {
    const dbPath = path.join(liveDir, 'cretli-store.sqlite');
    const plan = planRollbackExport({ storeDir: liveDir });
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL; UPDATE storage_fencing SET hwm = 3');
    assert.throws(() => planRollbackExport({ storeDir: liveDir }), (e) => e.code === 'store_not_cleanly_closed');
    writer.close();
    assert.throws(() => applyRollbackExport({ storeDir: liveDir, legacyOut: path.join(work, 'x'), confirmPlanHash: plan.planHash }), (e) => e.code === 'plan_hash_mismatch');
    const fresh = planRollbackExport({ storeDir: liveDir });
    assert.throws(() => applyRollbackExport({ storeDir: liveDir, legacyOut: path.join(liveDir, 'inside'), confirmPlanHash: fresh.planHash }), (e) => e.code === 'path_overlaps_source');
    fs.mkdirSync(path.join(work, 'exists'));
    assert.throws(() => applyRollbackExport({ storeDir: liveDir, legacyOut: path.join(work, 'exists'), confirmPlanHash: fresh.planHash }), (e) => e.code === 'output_exists');
    const foreign = path.join(work, 'foreign');
    fs.mkdirSync(foreign);
    const other = new DatabaseSync(path.join(foreign, 'cretli-store.sqlite'));
    other.exec('CREATE TABLE t (x)');
    other.close();
    assert.throws(() => planRollbackExport({ storeDir: foreign }), (e) => e.code === 'store_foreign_database');
    assert.throws(() => planRollbackExport({ storeDir: path.join(work, 'nope') }), (e) => e.code === 'path_missing');
  });

  it('detects a write that lands while the export runs and publishes nothing', () => {
    const plan = planRollbackExport({ storeDir: liveDir });
    const out = path.join(work, 'rollback');
    assert.throws(() => applyRollbackExport({
      storeDir: liveDir, legacyOut: out, confirmPlanHash: plan.planHash,
      faultHook(point) {
        if (point !== 'chat-exported') return;
        const db = new DatabaseSync(path.join(liveDir, 'cretli-store.sqlite'));
        db.exec('UPDATE storage_fencing SET hwm = hwm + 1');
        db.close();
      },
    }), (e) => e.code === 'source_changed_during_export');
    assert.equal(fs.existsSync(out), false, 'a possibly stale export is never published');
    assert.equal(fs.existsSync(`${out}.partial`), true, 'kept for inspection');
  });

  it('a partial export blocks a rerun until it is discarded explicitly; only a marked partial may be discarded', () => {
    const plan = planRollbackExport({ storeDir: liveDir });
    const out = path.join(work, 'rollback');
    assert.throws(() => applyRollbackExport({ storeDir: liveDir, legacyOut: out, confirmPlanHash: plan.planHash, faultHook() { throw new Error('crash'); } }), /crash/);
    assert.throws(() => applyRollbackExport({ storeDir: liveDir, legacyOut: out, confirmPlanHash: plan.planHash }), (e) => e.code === 'export_partial_exists');
    applyRollbackExport({ storeDir: liveDir, legacyOut: out, confirmPlanHash: plan.planHash, discardPartial: true });
    assert.equal(fs.existsSync(`${out}.partial`), false);
    const other = path.join(work, 'other');
    fs.mkdirSync(`${other}.partial`);
    fs.writeFileSync(path.join(`${other}.partial`, 'user-file.txt'), 'not ours');
    assert.throws(() => applyRollbackExport({ storeDir: liveDir, legacyOut: other, confirmPlanHash: plan.planHash, discardPartial: true }), (e) => e.code === 'partial_not_owned');
    assert.equal(fs.readFileSync(path.join(`${other}.partial`, 'user-file.txt'), 'utf8'), 'not ours');
  });

  it('verify-rollback flags a store that accepted writes after the export, and a tampered export', async () => {
    const plan = planRollbackExport({ storeDir: liveDir });
    const out = path.join(work, 'rollback');
    applyRollbackExport({ storeDir: liveDir, legacyOut: out, confirmPlanHash: plan.planHash });
    assert.equal(verifyRollbackExport({ exportDir: out, storeDir: liveDir }).ok, true);
    const { store } = await startLive();
    await store.appendEvents({ ...ns(SYNTHETIC_IDS.live), producerId: SERVER_PRODUCER, commandId: 'late-write', events: [{ clientSeq: 1, rec: userRec('acknowledged after the export') }] });
    await closeLive();
    assert.throws(() => verifyRollbackExport({ exportDir: out, storeDir: liveDir }), (e) => e.code === 'source_changed_since_export');
    assert.equal(verifyRollbackExport({ exportDir: out }).sourceUnchanged, null);
    const file = path.join(out, 'legacy-chat-history', `${SYNTHETIC_IDS.live}.json`);
    fs.appendFileSync(file, ' ');
    assert.throws(() => verifyRollbackExport({ exportDir: out }), (e) => e.code === 'export_verify_mismatch');
  });
});
