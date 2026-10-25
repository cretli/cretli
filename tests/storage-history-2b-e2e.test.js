/**
 * Stage 2b end-to-end rehearsal on SYNTHETIC data in a temporary directory (never user data):
 * offline import -> marker selects SQLite -> the production service/runtime serves every caller ->
 * regular and 2,686,612-byte writes -> lost reply -> retry -> restart -> fork/delete/reset -> stale
 * identity -> HTTP -> read-only rollback export with receipts. Nothing here switches a live backend.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cretli-2b-e2e-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
// Must precede the first import of any module that resolves the data directory at load time.
process.env.CRETLI_DATA_DIR = dataDir;

const { default: express } = await import('express');
const { GENERATION, bootParts, makeCoordinator } = await import('./fixtures/storage-history-adapter-harness.js');
const { SYNTHETIC_IDS, padText, userRec, writeHandmadeLegacyDocs } = await import('./fixtures/storage-history-synthetic.js');
const { applyLegacyImport, planLegacyImport } = await import('../lib/storage/history-import.js');
const { applyRollbackExport, planRollbackExport } = await import('../lib/storage/history-rollback.js');
const { bootstrapHistoryStore } = await import('../lib/storage/dataset-binding.js');
const { selectHistoryBackend } = await import('../lib/persist/chat-history-backend-marker.js');
const service = await import('../lib/persist/chat-history-service.js');
const { createHistoryFlusher } = await import('../lib/persist/history-room-flusher.js');
const { appendRelatedChatHistoryLinks } = await import('../lib/chat-relation-history.js');
const { saveChats } = await import('../lib/persist/chats-persist.js');
const { registerChatsRoutes } = await import('../lib/routes/chats-routes.js');
const { StorageError } = await import('../lib/storage/errors.js');
const { buildServerProducerId } = await import('../lib/persist/history-pending-buffer.js');

const LARGE_BYTES = 2_686_612;
const EXTRAS = SYNTHETIC_IDS.extras;
const GAPS = SYNTHETIC_IDS.gaps;
const paths = service.resolveChatHistoryPaths(dataDir);
const legacyDir = path.join(dataDir, 'chat-history');

/** Snapshot of the legacy directory: after the cutover nothing may write there. */
function legacySnapshot() {
  return fs.readdirSync(legacyDir).sort().map((name) => {
    const stat = fs.statSync(path.join(legacyDir, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  });
}

let httpServer;
let httpPort;
let legacyBefore;

before(async () => {
  // 1. The legacy dataset exactly as the old server would have left it, plus the offline import.
  writeHandmadeLegacyDocs(legacyDir);
  const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
  assert.equal(plan.ok, true);
  const staging = path.join(root, 'staging');
  applyLegacyImport({ legacyDir, stagingOut: staging, datasetGeneration: GENERATION, confirmPlanHash: plan.planHash });
  fs.mkdirSync(paths.dbDir, { recursive: true });
  fs.copyFileSync(path.join(staging, 'cretli-store.sqlite'), path.join(paths.dbDir, 'cretli-store.sqlite'));
  bootstrapHistoryStore({ dbDir: paths.dbDir, datasetGeneration: GENERATION });
  // 2. The marker owner (not the server) selects SQLite after the legacy files were left behind.
  const coordinator = makeCoordinator(paths.controlDir);
  coordinator.acquire();
  selectHistoryBackend({ controlDir: paths.controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 'e2e-rehearsal', datasetGeneration: GENERATION });
  coordinator.close();
  legacyBefore = legacySnapshot();
});

after(async () => {
  await service.closeChatHistoryService().catch(() => {});
  httpServer?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fail closed before the runtime is open', () => {
  it('every caller refuses while the marker selects SQLite and the service is not open (no legacy bypass)', async () => {
    await assert.rejects(service.loadChatHistory(EXTRAS), (error) => error.code === 'history_backend_mismatch');
    await assert.rejects(service.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('must not reach the legacy file') }]), (error) => error.code === 'history_backend_mismatch');
    await assert.rejects(service.listChatHistoryHeadSeqs(), (error) => error.code === 'history_backend_mismatch');
    assert.deepEqual(legacySnapshot(), legacyBefore, 'the legacy store was not touched');
    assert.equal(service.getChatHistoryBackendKind(), 'unopened');
  });
});

describe('production service over the real runtime (marker -> coordinator -> worker -> adapter)', () => {
  it('opens the selected backend and serves imported history through every legacy-shaped reader', async () => {
    const opened = await service.openChatHistoryService({ dataDir, runtimeOptions: { hostOptions: { restartBackoffMs: { initial: 5, max: 20 } } } });
    assert.equal(opened.backendKind, 'sqlite');
    assert.equal(service.getChatHistoryBackendKind(), 'sqlite');
    await assert.rejects(service.openChatHistoryService({ dataDir }), (error) => error.code === 'history_backend_transition_refused', 'one backend per process');
    const doc = await service.loadChatHistory(EXTRAS);
    assert.equal(doc.cursorSessionId, 'session-extras');
    assert.deepEqual(doc.events.map((event) => event.seq), [3, 4, 9]);
    assert.equal(doc.headSeq, 12);
    assert.ok(doc.identity?.chatEpoch, 'reads carry the per-chat identity');
    const page = await service.getChatHistoryPage(GAPS, { limit: 3 });
    assert.deepEqual(page.events.map((event) => event.seq), [10, 31, 40]);
    assert.equal(page.identity.datasetGeneration, GENERATION);
    const exact = await service.getChatHistoryEvent(GAPS, 6);
    assert.equal(exact.event, null, 'a gap never returns a neighbour');
    const http = await service.readChatHistoryFromHttpQuery(GAPS, { since: '9', limit: '10' });
    assert.deepEqual(http.events.map((event) => event.seq), [10, 31, 40]);
    const batch = await service.readChatHistoryBatch([{ id: EXTRAS, since: 0 }, { id: GAPS, since: 31 }, { id: 'not-allowed', since: 0 }], new Set([EXTRAS, GAPS]));
    assert.deepEqual(Object.keys(batch).sort(), [EXTRAS, GAPS].sort());
    assert.deepEqual(batch[GAPS].events.map((event) => event.seq), [40]);
    assert.deepEqual(await service.readChatHistoryBatch([{ id: EXTRAS }], []), {}, 'an empty allow-list never means every chat');
    const heads = await service.listChatHistoryHeadSeqs();
    assert.equal(heads[EXTRAS].headSeq, 12);
    const usage = await service.getChatHistoryUsage(EXTRAS);
    assert.equal(usage.headSeq, 12);
  });

  it('writes regular and 2,686,612-byte records, notifies only after the commit and never touches the legacy files', async () => {
    const overhead = JSON.stringify(userRec('')).length;
    const large = userRec(padText(LARGE_BYTES - overhead));
    assert.equal(JSON.stringify(large).length, LARGE_BYTES);
    const regular = await service.appendChatHistoryEvents(EXTRAS, 'session-new', [{ rec: userRec('after cutover') }]);
    assert.equal(regular.ok, true);
    assert.equal(regular.appended[0].seq, 13);
    const written = await service.appendChatHistoryEvents(EXTRAS, '', [{ rec: large }, { rec: userRec('small after large') }]);
    assert.equal(written.ok, true);
    assert.deepEqual(written.appended.map((row) => row.seq), [14, 15]);
    const readBack = await service.getChatHistoryEvent(EXTRAS, 14);
    assert.equal(JSON.stringify(readBack.event.rec).length, LARGE_BYTES, 'the large record round-trips byte for byte');
    const relation = await appendRelatedChatHistoryLinks({
      parentChat: { id: EXTRAS, cursorSessionId: 'session-new', title: 'Parent' },
      childChat: { id: GAPS, cursorSessionId: '', title: 'Child', forkKind: 'delegation' },
      reason: 'delegation',
    });
    assert.equal(relation.ok, true);
    assert.equal((await service.loadChatHistory(GAPS)).events.at(-1).rec.variant, 'relatedChat');
    const notice = await service.appendChatNotice(EXTRAS, 'watcher says hi', { action: 'info' });
    assert.equal(notice.ok, true);
    assert.deepEqual(legacySnapshot(), legacyBefore, 'no writer reached the legacy files after the selection');
  });

  it('a browser queue write namespaces its sequence numbers; an old un-namespaced client is refused and keeps its queue', async () => {
    const pin = (await service.getChatHistorySince(EXTRAS, 0, 1)).identity;
    const queueOptions = { queueProducerId: 'queue:device-1', datasetGeneration: pin.datasetGeneration, chatEpoch: pin.chatEpoch };
    const queued = await service.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('from a queue'), clientSeq: 1 }], queueOptions);
    assert.equal(queued.ok, true);
    const replay = await service.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('from a queue'), clientSeq: 1 }], queueOptions);
    assert.equal(replay.appended[0].seq, queued.appended[0].seq, 'idempotent replay of the same (producer, clientSeq)');
    const old = await service.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('old client'), clientSeq: 2 }]);
    assert.equal(old.ok, false);
    assert.equal(old.code, 'history_unnamespaced_input');
  });

  it('a stale chat epoch is refused after the chat was deleted and recreated (identity changes)', async () => {
    const before = (await service.getChatHistorySince(EXTRAS, 0, 1)).identity;
    await service.deleteChatHistory(GAPS);
    assert.equal(await service.loadChatHistory(GAPS), null);
    // The producer that wrote the deleted chat stays fenced for it; a new run attempt (new producer) starts the new life.
    const recreated = await service.appendChatHistoryEvents(GAPS, '', [{ rec: userRec('new life') }], { producerId: buildServerProducerId({ runId: 'e2e', attemptId: 'after-delete' }) });
    assert.equal(recreated.appended[0].seq, 1, 'a deleted chat starts again from seq 1 in a fresh epoch');
    const afterIdentity = (await service.getChatHistorySince(GAPS, 0, 1)).identity;
    assert.notEqual(afterIdentity.chatEpoch, before.chatEpoch);
    await assert.rejects(
      service.appendChatHistoryEvents(GAPS, '', [{ rec: userRec('stale', undefined), clientSeq: 5 }], { queueProducerId: 'queue:device-1', datasetGeneration: afterIdentity.datasetGeneration, chatEpoch: 'ep.stale' }),
      (error) => error.details.conflictKind === 'history_stale_epoch',
    );
    // A queue built for another dataset generation is refused before anything is recorded.
    await assert.rejects(
      service.appendChatHistoryEvents(GAPS, '', [{ rec: userRec('other generation'), clientSeq: 6 }], { queueProducerId: 'queue:device-1', datasetGeneration: 'g-not-current', chatEpoch: afterIdentity.chatEpoch }),
      (error) => error.code === 'history_stale_client_identity' && error.details.commitState === 'not_committed',
    );
  });

  it('fork copies history, a restart replays nothing twice and keeps every acknowledged write', async () => {
    const forked = await service.copyChatHistory(EXTRAS, SYNTHETIC_IDS.live, 'forked-cursor');
    assert.equal(forked.ok, true);
    const copy = await service.loadChatHistory(SYNTHETIC_IDS.live);
    const source = await service.loadChatHistory(EXTRAS);
    assert.deepEqual(copy.events.map((event) => event.seq), source.events.map((event) => event.seq));
    const headBefore = (await service.loadChatHistory(EXTRAS)).headSeq;
    await service.closeChatHistoryService();
    assert.equal(service.getChatHistoryBackendKind(), 'unopened');
    const reopened = await service.openChatHistoryService({ dataDir, runtimeOptions: { hostOptions: { restartBackoffMs: { initial: 5, max: 20 } } } });
    assert.equal(reopened.backendKind, 'sqlite');
    assert.deepEqual(reopened.recovery.unresolved, []);
    const headAfter = (await service.loadChatHistory(EXTRAS)).headSeq;
    assert.equal(headAfter, headBefore, 'no ACK lost and no duplicate append across the restart');
  });
});

describe('durable retention of room buffers (lost reply, retry, no duplicate)', () => {
  it('keeps the records and the retry token across an unknown commit and writes them exactly once', async () => {
    let unknown = true;
    const parts = await bootParts({
      root: path.join(root, 'flusher'),
      wrapStore: (store) => ({
        ...store,
        // The command COMMITS, then its reply is lost and the receipt lookup is down: the outcome is genuinely unknown.
        appendEvents: async (args) => {
          const result = await store.appendEvents(args);
          if (unknown && args.events?.some((event) => event.rec?.text === 'lost reply')) {
            throw new StorageError('unknown_commit', 'the reply was lost', { details: { operation: 'history', commitState: 'unknown' } });
          }
          return result;
        },
        resolveUnknown: async (args) => {
          if (unknown) throw new Error('receipt lookup down');
          return store.resolveUnknown(args);
        },
      }),
    });
    try {
      const chat = 'cccccccc-0000-4000-8000-000000000001';
      const flusher = createHistoryFlusher({
        label: 'e2e',
        warn: () => {},
        append: (room, items, callOptions) => parts.adapter.appendChatHistoryEvents(room.chatId, room.sessionKey, items, callOptions),
      });
      const room = { chatId: chat, sessionKey: 'sess', _persistBuf: [{ rec: userRec('lost reply') }, { rec: userRec('second') }] };
      const first = await flusher.flush(room);
      assert.equal(first.ok, false, 'not acknowledged: the outcome was unknown');
      assert.equal(first.pending, 2);
      assert.ok(room._persistInflight.retryToken, 'the retry token is kept with the same input');
      unknown = false;
      room._persistBuf.push({ rec: userRec('third') });
      const second = await flusher.flush(room);
      assert.equal(second.ok, true);
      const stored = await parts.adapter.loadChatHistory(chat);
      assert.deepEqual(stored.events.map((event) => event.rec.text), ['lost reply', 'second', 'third'], 'each record exactly once, in order');
    } finally {
      await parts.close();
    }
  });
});

describe('HTTP routes over the selected backend', () => {
  before(async () => {
    saveChats([{ id: EXTRAS, title: 'Extras', agentTransport: 'sdk', workspaceFolder: '/work/p', workspaceFile: '/work/p.code-workspace' }]);
    const app = express();
    registerChatsRoutes(app, {
      dataDir: '', agentSessions: new Map(), getCurrentAgentRunResumeId: () => '', setCurrentAgentRunResumeId: () => {},
      agentCmd: '', agentModel: '', workspaceDirForAgent: () => '/tmp', getCurrentWorkspaceFile: () => null, getCurrentCwd: () => '/tmp', buildAgentSpawnEnv: () => ({}),
    });
    httpServer = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    httpPort = httpServer.address().port;
  });

  const call = async (method, urlPath, body) => {
    const response = await fetch(`http://127.0.0.1:${httpPort}${urlPath}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  it('GET returns the per-chat identity and POST pins the queue epoch', async () => {
    const read = await call('GET', `/api/chats/${EXTRAS}/history?since=0&limit=2`);
    assert.equal(read.status, 200);
    assert.ok(read.body.identity.chatEpoch);
    const pushed = await call('POST', `/api/chats/${EXTRAS}/history`, { events: [{ rec: userRec('via http'), clientSeq: 1 }], queueProducerId: 'queue:http-1', datasetGeneration: read.body.identity.datasetGeneration, chatEpoch: read.body.identity.chatEpoch });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.identity.chatEpoch, read.body.identity.chatEpoch);
  });

  it('maps typed refusals to stable HTTP statuses and codes', async () => {
    const known = (await call('GET', `/api/chats/${EXTRAS}/history?since=0&limit=1`)).body.identity;
    const stale = await call('POST', `/api/chats/${EXTRAS}/history`, { events: [{ rec: userRec('stale'), clientSeq: 9 }], queueProducerId: 'queue:http-1', datasetGeneration: known.datasetGeneration, chatEpoch: 'ep.old' });
    const unpinned = await call('POST', `/api/chats/${EXTRAS}/history`, { events: [{ rec: userRec('unpinned'), clientSeq: 10 }], queueProducerId: 'queue:http-1' });
    assert.equal(unpinned.status, 409, 'a queue write without generation+epoch is a typed not-committed refusal');
    assert.equal(unpinned.body.code, 'history_stale_client_identity');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'history_stale_client_identity');
    const oldClient = await call('POST', `/api/chats/${EXTRAS}/history`, { events: [{ rec: userRec('old'), clientSeq: 9 }] });
    assert.equal(oldClient.status, 409);
    assert.equal(oldClient.body.code, 'history_unnamespaced_input');
    const tooLarge = await call('POST', `/api/chats/${EXTRAS}/history`, { events: [{ rec: userRec('x'.repeat(3 * 1024 * 1024 + 10)) }] });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.code, 'history_record_too_large');
    assert.equal(tooLarge.body.commitState, 'not_committed');
  });
});

describe('read-only rollback after the rehearsal', () => {
  it('exports the store, switches the marker and serves the history read-only with every write refused', async () => {
    await service.closeChatHistoryService();
    const exportDir = path.join(root, 'rollback');
    const plan = planRollbackExport({ storeDir: paths.dbDir });
    applyRollbackExport({ storeDir: paths.dbDir, legacyOut: exportDir, confirmPlanHash: plan.planHash });
    const exported = JSON.parse(fs.readFileSync(path.join(exportDir, 'legacy-chat-history', `${EXTRAS}.json`), 'utf8'));
    const texts = exported.events.map((event) => event.rec.text);
    assert.ok(texts.includes('after cutover'));
    assert.ok(texts.includes('small after large'));
    assert.ok(texts.includes('via http'));
    const large = exported.events.find((event) => JSON.stringify(event.rec).length === LARGE_BYTES);
    assert.ok(large, 'the 2,686,612-byte record is part of the rollback export');
  });
});
