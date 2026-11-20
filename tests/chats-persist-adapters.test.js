import './helpers/isolated-data-dir.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createChatsStore } from '../lib/storage/chats-store.js';
import { openStorageDb } from '../lib/storage/db-lifecycle.js';
import { bindDatasetGeneration } from '../lib/storage/dataset-binding.js';
import { StorageError } from '../lib/storage/errors.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import {
  addChat,
  legacyChatsBackend,
  loadChats,
  loadChatsAsync,
  saveChats,
} from '../lib/persist/chats-persist.js';
import {
  CHATS_RUNTIME_TEST_HOOK,
  CHATS_SQLITE_RUNTIME_ENABLED,
  createChatsRuntime,
  getActiveChatsRuntime,
  openChatsRuntime,
  setActiveChatsRuntime,
} from '../lib/persist/chats-runtime.js';
import { createSqliteChatsBackend } from '../lib/persist/chats-backend-sqlite.js';
import { CHATS_BACKEND_OPERATIONS } from '../lib/persist/chats-backend-legacy.js';
import {
  ChatsBackendError,
  readChatsBackendMarker,
  writeChatsBackendMarker,
} from '../lib/persist/chats-backend-marker.js';
import { tempDir } from './fixtures/storage-chats-helpers.js';
import { createDefaultConversationStore } from '../lib/backup/conversations-store.js';
import { ConversationStoreError } from '../lib/backup/conversations-store.js';
import { buildConversationsExport } from '../lib/backup/conversations-archive.js';
import { createConversationsBackupService } from '../lib/backup/conversations-backup-service.js';
import { resetScoutChatRegistry } from '../lib/scout-chat-registry.js';
import { isScoutReadOnlyChatIdAsync } from '../lib/workspace-scout-chat.js';
import { subscribeChatListUpdates, __clearChatListUpdateClientsForTest } from '../lib/chat-list-updates.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-chats-handlers.js', import.meta.url));
const GEN = 'gen-1';

/** Cleanup steps of a chat delete are recorded instead of touching real history / media files. */
function recordingDeps(log) {
  return {
    settleHistoryFlushes: async (id) => { log.push(['settle', id]); },
    deleteChatHistory: async (id) => { log.push(['history', id]); },
    discardBufferedHistory: (id) => { log.push(['discard', id]); },
    deleteChatTitleHistory: (id) => { log.push(['titles', id]); },
    deleteContextSendManifests: (id) => { log.push(['manifests', id]); },
    removeBrowserScreenshots: (id) => { log.push(['screenshots', id]); },
    removeChatMedia: (id) => { log.push(['media', id]); },
    broadcast: (frame) => { log.push(['broadcast', frame.reason, frame.chatId]); },
  };
}

const hosts = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop().close().catch(() => {});
});

/** A real storage worker host over a fresh chats.sqlite. */
async function startStore({ dir = tempDir('chats-adapters-'), faultInjection = false } = {}) {
  const host = createStorageWorkerHost({
    dbDir: dir, filename: 'chats.sqlite', handlersPath: HANDLERS_PATH, faultInjection,
    writeGate: WRITE_GATE_TEST_EXEMPTION, restartBackoffMs: { initial: 5, max: 20 },
  });
  hosts.push(host);
  await host.start();
  return { host, dir, store: createChatsStore({ host, datasetGeneration: GEN }) };
}

async function sqliteRuntime(options = {}) {
  const { store, ...rest } = await startStore();
  const backend = createSqliteChatsBackend({ store: options.wrap ? options.wrap(store) : store, ...options.backend });
  const log = [];
  const runtime = createChatsRuntime({ backend, backendKind: 'sqlite', deps: recordingDeps(log) });
  return { ...rest, store, backend, runtime, api: runtime.api, log };
}

function legacyRuntime() {
  saveChats([]);
  const log = [];
  const runtime = createChatsRuntime({ backend: legacyChatsBackend, backendKind: 'legacy', deps: recordingDeps(log) });
  return { runtime, api: runtime.api, log };
}

// ---------------------------------------------------------------------------------------------------
// Parity of the whole facade on the same fixture
// ---------------------------------------------------------------------------------------------------

const TS_RE = /\d{4}-\d\d-\d\dT[\d:.]+Z/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Sorted keys, timestamps and generated uuids replaced by stable placeholders. */
function canonical(value) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
    return v;
  };
  const seen = new Map();
  return JSON.stringify(sorted(value), null, 1)
    .replace(TS_RE, 'TS')
    .replace(UUID_RE, (u) => { if (!seen.has(u)) seen.set(u, `UUID${seen.size + 1}`); return seen.get(u); });
}

async function attempt(fn) {
  try { return await fn(); } catch (err) { return { threw: err.message }; }
}

const SETTINGS = {
  workspaces: [{ id: 'ws1', name: 'W1' }],
  workspaceSidebarConfig: { ws1: { folders: { '/w/a': { enabled: true } } } },
};

/** The same scripted use of the facade; the result log is compared between adapters. */
async function runScript(a) {
  const out = {};
  out.root = await a.addChatAsync('s-root', 'Root', '/w/f.code-workspace', '/w/a', 'm1', { id: 'root', sdkMode: 'agent', todoId: 't1' });
  out.child = await a.addChatAsync('s-child', 'Child', undefined, '/w/a', 'm2', { id: 'child', forkParentChatId: 'root' });
  out.leaf = await a.addChatAsync('s-leaf', undefined, undefined, '/w/a', undefined, {
    id: 'leaf', forkParentChatId: 'child', widgetInstallationId: 'inst', widgetPageSessionId: 'p1',
  });
  out.leaf2 = await a.addChatAsync('s-leaf2', 'Leaf two', undefined, '/w/b', undefined, { id: 'leaf2', widgetInstallationId: 'inst', widgetPageSessionId: 'p1' });
  out.duplicate = await a.addChatAsync('s-x', 'Duplicate', undefined, undefined, undefined, { id: 'root' });
  out.missingParent = await attempt(() => a.addChatAsync('s-m', 'M', undefined, undefined, undefined, { id: 'orphan', forkParentChatId: 'root', delegationParentChatId: 'root' }));
  out.fork = await a.createConversationForkChatAsync(out.root, { title: 'Fork X', forkKind: 'reference' });
  out.temp1 = await a.createTemporaryForkChatAsync('root', 'title', '/w/f.code-workspace', '/w/a', 'm1');
  out.temp2 = await a.createTemporaryForkChatAsync('root', 'title', '/w/f.code-workspace', '/w/a', 'm1');
  out.tempList = (await a.loadChatsAsync()).filter((c) => c.isTemporary === true).length;
  out.tempDeleted = (await a.deleteTemporaryForkChatsAsync('root')).length;
  out.tempDeletedAgain = (await a.deleteTemporaryForkChatsAsync('root')).length;

  out.renamed = await a.updateChatAsync('root', {
    title: 'Renamed', model: 'm9', sdkMode: 'plan', summary: 'S', summaryTitle: 'ST', executionFolder: '/x', contextAdvisoryEnabled: false,
  });
  out.unknownUpdate = await a.updateChatAsync('nope', { title: 'x' });
  await a.updateChatAsync('leaf', { widgetPinnedUrl: 'https://example.com/p' });
  out.pinned = await a.updateChatAsync('leaf2', { widgetPinnedUrl: 'https://example.com/p' });
  out.afterPin = (await a.getChatByIdAsync('leaf')).widgetPinnedUrl ?? null;
  out.archived = await a.updateChatAsync('child', { archived: true });
  out.archivedTree = (await a.peekChatsByIdsAsync(['child', 'leaf'])).map((c) => Boolean(c.archivedAt));
  await a.updateChatAsync('child', { archived: false });
  out.restoredTree = (await a.peekChatsByIdsAsync(['child', 'leaf'])).map((c) => Boolean(c.archivedAt));
  out.nested = await a.updateChatAsync('leaf2', { forkParentChatId: 'root' });
  out.selfNest = await attempt(() => a.updateChatAsync('root', { forkParentChatId: 'root' }));
  out.cycle = await attempt(() => a.updateChatAsync('root', { forkParentChatId: 'leaf2' }));
  out.noParent = await attempt(() => a.updateChatAsync('root', { forkParentChatId: 'ghost' }));
  out.unnested = await a.updateChatAsync('leaf2', { forkParentChatId: null });

  out.read1 = await a.markChatReadStateAsync('root', { finishedAt: '2026-01-01T00:00:00.000Z', seenAt: '2026-01-02T00:00:00.000Z' });
  out.read2 = await a.markChatReadStateAsync('root', { finishedAt: '2026-01-01T00:00:00.000Z' });
  out.read3 = await a.markChatReadStateAsync('nope', { seenAt: '2026-01-02T00:00:00.000Z' });

  out.auto1 = await a.applyAutoTitleAsync('child', 'Auto T');
  out.auto2 = await a.applyAutoTitleAsync('child', 'Auto T');
  out.auto3 = await a.applyAutoTitleAsync('child', '  ');
  out.auto4 = await a.applyAutoTitleAsync('child', 'Other', { expectedVersion: 99 });
  out.auto5 = await a.applyAutoTitleAsync('nope', 'Other');
  await a.updateChatAsync('child', { title: 'Manual' });
  out.auto6 = await a.applyAutoTitleAsync('child', 'Gen');
  out.auto7 = await a.applyAutoTitleAsync('child', 'Forced', { force: true, reason: 'regen' });
  out.lock1 = await a.setChatTitleLockedAsync('child', true);
  out.lock2 = await a.setChatTitleLockedAsync('child', true);
  out.lock3 = await a.setChatTitleLockedAsync('child', false);
  out.lock4 = await a.setChatTitleLockedAsync('nope', true);

  out.sdk = await a.setChatSdkAgentIdAsync('root', 'bc-1');
  out.oc = await a.setChatOpenCodeSessionIdAsync('root', ' oc-1 ');
  out.cb = await a.setChatCodeBuddySessionIdAsync('root', 'cb-1');
  out.ds = await a.setChatDeepSeekSessionIdAsync('root', 'ds-1');
  out.cx = await a.setChatCodexThreadIdAsync('root', 'cx-1');
  out.qw = await a.setChatQwenSessionIdAsync('root', 'qw-1');
  out.cl1 = await a.setChatClaudeSessionIdAsync('root', 'cl-1');
  out.cl2 = await a.setChatClaudeSessionIdAsync('root', 'cl-1');
  out.oc2 = await a.setChatOpenCodeSessionIdAsync('root', '');
  out.noChatSession = await a.setChatClaudeSessionIdAsync('nope', 'x');
  out.rotated = await a.rotateChatSdkSessionAsync('root');
  out.rotatedMissing = await a.rotateChatSdkSessionAsync('nope');

  out.migrateDry = await a.migrateChatWorkspaceIdsAsync(SETTINGS);
  out.migrate = await a.migrateChatWorkspaceIdsAsync(SETTINGS, { dryRun: false });
  out.migrateAgain = await a.migrateChatWorkspaceIdsAsync(SETTINGS, { dryRun: false });

  out.byId = await a.getChatByIdAsync('leaf');
  out.byIdBlank = await a.getChatByIdAsync('  ');
  out.bySession = await a.getChatByCursorSessionIdAsync('s-child');
  out.bySessionMissing = await a.getChatByCursorSessionIdAsync('nope');
  out.many = (await a.peekChatsByIdsAsync(['leaf', 'nope', 'root'])).map((c) => c.id);
  const snapshot = await a.loadChatsSnapshotAsync();
  out.snapshotRevisionIsString = typeof snapshot.revision === 'string';
  out.snapshot = snapshot.chats;
  out.peekSnapshotCount = (await a.peekChatsSnapshotAsync()).chats.length;
  out.peek = (await a.peekChatsAsync()).map((c) => c.id);

  await a.removeChatAsync('leaf2');
  await a.removeChatAsync('missing');
  await a.deleteChatAsync('leaf', { retryToken: 'rt' });
  out.final = await a.loadChatsAsync();
  return out;
}

describe('facade surface', () => {
  it('exports the Async twin of every store-touching sync function', async () => {
    const mod = await import('../lib/persist/chats-persist.js');
    const sync = [
      'loadChats', 'loadChatsSnapshot', 'peekChatsSnapshot', 'peekChats', 'peekChatsByIds', 'getChatById', 'getChatByCursorSessionId',
      'saveChats', 'addChat', 'createConversationForkChat', 'createTemporaryForkChat', 'deleteTemporaryForkChats', 'removeChat', 'deleteChat',
      'updateChat', 'markChatReadState', 'applyAutoTitle', 'setChatTitleLocked', 'setChatSdkAgentId', 'setChatOpenCodeSessionId',
      'setChatCodeBuddySessionId', 'setChatDeepSeekSessionId', 'setChatCodexThreadId', 'setChatQwenSessionId', 'setChatClaudeSessionId',
      'rotateChatSdkSession', 'migrateChatWorkspaceIds',
    ];
    for (const name of sync) {
      assert.equal(typeof mod[name], 'function', name);
      assert.equal(typeof mod[`${name}Async`], 'function', `${name}Async`);
    }
  });

  it('defaults to the legacy runtime and the sync and async API see the same rows', async () => {
    assert.equal(CHATS_SQLITE_RUNTIME_ENABLED, false);
    assert.equal(getActiveChatsRuntime().backendKind, 'legacy');
    saveChats([]);
    addChat('s1', 'One', undefined, '/w/a', undefined, { id: 'one' });
    assert.deepEqual((await loadChatsAsync()).map((c) => c.id), ['one']);
    assert.deepEqual(loadChats().map((c) => c.id), ['one']);
  });

  it('refuses a backend that misses an operation', () => {
    const partial = Object.fromEntries(CHATS_BACKEND_OPERATIONS.slice(1).map((n) => [n, async () => null]));
    assert.throws(() => createChatsRuntime({ backend: partial }), /missing/);
  });
});

describe('adapter parity (legacy vs sqlite, isolated runtimes)', () => {
  it('produces the same results and the same final collection', async () => {
    const legacy = legacyRuntime();
    const expected = await runScript(legacy.api);
    const sqlite = await sqliteRuntime();
    const actual = await runScript(sqlite.api);
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    for (const key of Object.keys(expected)) assert.equal(canonical(actual[key]), canonical(expected[key]), `result "${key}"`);
    // Guard against a vacuous comparison.
    assert.equal(expected.final.length, 4);
    assert.equal(expected.selfNest.threw, 'Chat cannot be nested under itself');
    assert.equal(expected.cycle.threw, 'Cannot nest a chat under its descendant');
    assert.equal(expected.afterPin, null);
    assert.deepEqual(expected.archivedTree, [true, true]);
    assert.deepEqual(expected.restoredTree, [false, false]);
    assert.equal(expected.auto6.skipped, 'manual');
    assert.equal(actual.snapshotRevisionIsString, true);
    // The delete steps ran in the same order on both adapters.
    assert.deepEqual(sqlite.log, legacy.log);
    assert.deepEqual(sqlite.log.map((e) => e[0]), ['settle', 'history', 'discard', 'titles', 'manifests', 'screenshots', 'media', 'broadcast']);
  });

  it('keeps unknown fields and the committed store consistent after the script', async () => {
    const sqlite = await sqliteRuntime();
    await sqlite.api.addChatAsync('s', 'T', undefined, '/w/a', undefined, { id: 'a' });
    await sqlite.store.update({ commandId: 'x1', id: 'a', expectedRevision: 1, set: { futureField: { n: [1] } } });
    const updated = await sqlite.api.updateChatAsync('a', { model: 'm' });
    assert.deepEqual(updated.futureField, { n: [1] });
    assert.equal((await sqlite.store.verifyCounts({})).ok, true);
  });

  it('returns an identical bounded workspace migration report on both adapters', async () => {
    const legacy = legacyRuntime();
    const sqlite = await sqliteRuntime();
    const workspaceId = 'cretli:ws:11111111-1111-4111-8111-111111111111';
    const settings = { workspaces: [{ id: workspaceId, kind: 'folders', label: 'workspace' }], workspaceSidebarConfig: { [workspaceId]: { folders: { '/workspace': { enabled: true } } } } };
    const rows = [
      { id: 'm1', workspaceFolder: '/workspace' },
      { id: 'm2', workspaceFolder: '/missing' },
      { id: 'm3', workspaceId: 'existing' },
    ];
    for (const row of rows) {
      await legacy.api.addChatAsync(row.id, row.id, undefined, row.workspaceFolder, undefined, { id: row.id, workspaceId: row.workspaceId });
      await sqlite.api.addChatAsync(row.id, row.id, undefined, row.workspaceFolder, undefined, { id: row.id, workspaceId: row.workspaceId });
    }
    const a = await legacy.api.migrateChatWorkspaceIdsAsync(settings, { dryRun: false });
    const b = await sqlite.api.migrateChatWorkspaceIdsAsync(settings, { dryRun: false });
    assert.deepEqual(b, a);
    assert.deepEqual((await sqlite.api.loadChatsAsync()).map((row) => row.workspaceId), (await legacy.api.loadChatsAsync()).map((row) => row.workspaceId));
    await sqlite.runtime.close();
  });

  it('retries workspace migration updateMany after a CAS conflict', async () => {
    let conflictOnce = true;
    const sqlite = await sqliteRuntime({ wrap: (store) => ({
      ...store,
      updateMany: async (args) => {
        if (conflictOnce) {
          conflictOnce = false;
          throw new StorageError('conflict', 'Injected migration race', { details: { conflictKind: 'chat_cas' } });
        }
        return store.updateMany(args);
      },
    }) });
    try {
      const workspaceId = 'cretli:ws:11111111-1111-4111-8111-111111111111';
      await sqlite.api.addChatAsync('migration-cas', 'Migration CAS', undefined, '/workspace', undefined, { id: 'migration-cas' });
      const report = await sqlite.api.migrateChatWorkspaceIdsAsync({
        workspaces: [{ id: workspaceId, kind: 'folders', label: 'workspace' }],
        workspaceSidebarConfig: { [workspaceId]: { folders: { '/workspace': { enabled: true } } } },
      }, { dryRun: false });
      assert.equal(report.updated, 1);
      assert.equal((await sqlite.api.getChatByIdAsync('migration-cas')).workspaceId, workspaceId);
    } finally {
      await sqlite.runtime.close();
    }
  });

  it('imports chat batches with the same dedupe and final snapshot on both adapters', async () => {
    const legacy = legacyRuntime();
    const sqlite = await sqliteRuntime();
    const entries = [
      { id: 'batch-a', title: 'A', titleSource: 'manual' },
      { id: 'batch-b', title: 'B', titleSource: 'manual' },
      { id: 'batch-a', title: 'duplicate', titleSource: 'manual' },
    ];
    const left = await legacy.api.importChatsBatchAsync(entries);
    const right = await sqlite.api.importChatsBatchAsync(entries);
    assert.equal(left.added, 2);
    assert.equal(right.added, 2);
    assert.equal((await sqlite.api.getChatByIdAsync('batch-a')).id, 'batch-a');
    assert.equal((await sqlite.api.getChatByIdAsync('batch-b')).id, 'batch-b');
    await sqlite.runtime.close();
  });

  it('imports more than one sqlite batch and reports every inserted id', async () => {
    const sqlite = await sqliteRuntime();
    const entries = Array.from({ length: 201 }, (_, i) => ({ id: `oversized-${i}`, title: `Chat ${i}`, titleSource: 'manual' }));
    const result = await sqlite.api.importChatsBatchAsync(entries);
    assert.equal(result.added, 201);
    assert.equal(result.addedIds.length, 201);
    assert.equal((await sqlite.store.counts({})).total, 201);
    await sqlite.runtime.close();
  });

  it('rolls back a committed sqlite import chunk when a later chunk fails', async () => {
    let importCalls = 0;
    const sqlite = await sqliteRuntime({ wrap: (store) => ({
      ...store,
      importBatch: async (args) => {
        importCalls += 1;
        if (importCalls === 2) throw new Error('injected second-batch failure');
        return store.importBatch(args);
      },
    }) });
    const entries = Array.from({ length: 201 }, (_, i) => ({ id: `rollback-${i}`, title: `Chat ${i}`, titleSource: 'manual' }));
    await assert.rejects(sqlite.api.importChatsBatchAsync(entries), /injected second-batch failure/);
    assert.equal((await sqlite.store.counts({})).total, 0);
    await sqlite.runtime.close();
  });

  it('maps a corrupt legacy chat source to ConversationStoreError', async () => {
    const store = createDefaultConversationStore();
    const file = path.join(process.env.CRETLI_DATA_DIR, 'chats.json');
    const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
    fs.writeFileSync(file, '{ malformed');
    try {
      await assert.rejects(store.readChats(), (err) => err instanceof ConversationStoreError && err.code === 'SOURCE_CORRUPT');
    } finally {
      if (previous) fs.writeFileSync(file, previous);
      else fs.rmSync(file, { force: true });
    }
  });

  it('publishes imported ids to scout index and list subscribers after commit', async () => {
    const sqlite = await sqliteRuntime();
    const frames = [];
    const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: (frame) => frames.push(JSON.parse(frame)) });
    subscribeChatListUpdates(socket, { kind: 'global' });
    resetScoutChatRegistry();
    await sqlite.api.importChatsBatchAsync([{ id: 'imported-visible', title: 'Scout child', titleSource: 'manual', readOnlyScout: true }]);
    assert.equal(await isScoutReadOnlyChatIdAsync('imported-visible'), true);
    assert.ok(frames.some((frame) => frame.reason === 'import' && frame.chatId === 'imported-visible'));
    __clearChatListUpdateClientsForTest();
    await sqlite.runtime.close();
  });

  it('exports and imports conversations through the sqlite facade', async () => {
    const sqlite = await sqliteRuntime();
    const previous = setActiveChatsRuntime(sqlite.runtime);
    const temp = tempDir('chats-backup-sqlite-');
    const memoryHistory = new Map();
    const store = createDefaultConversationStore({
      async loadHistory(id) { return memoryHistory.get(id) ?? null; },
      async writeHistory(id, cursorSessionId, events) { memoryHistory.set(id, { headSeq: events.length, events: events.map((rec, i) => ({ seq: i + 1, rec })) }); },
      async deleteHistory(id) { memoryHistory.delete(id); },
    });
    try {
      await sqlite.api.addChatAsync('source-session', 'Source', undefined, '/workspace', 'model', { id: 'source-chat' });
      memoryHistory.set('source-chat', { headSeq: 1, events: [{ seq: 1, rec: { kind: 'localUser', text: 'sqlite backup' } }] });
      const service = createConversationsBackupService({ store, jobsDir: path.join(temp, 'jobs') });
      const exported = await buildConversationsExport(store, { scope: 'all', includeArchived: true, includeSubchats: true });
      assert.equal(exported.summary.chatCount, 1);
      const job = service.startExport({ scope: 'all', includeArchived: true });
      const done = await service.jobs.wait(job.id);
      assert.equal(done.status, 'succeeded');
      const archive = exported.bytes;
      const staged = await service.stageImport(archive);
      const preview = await service.previewImport({ stageId: staged.stageId, options: { duplicate: true } });
      assert.ok(preview.plan?.chats?.length >= 1 || preview.items?.length >= 1);
      const applied = await service.importer.apply({ previewId: preview.previewId });
      assert.equal(applied.imported.length, 1);
      assert.ok(await sqlite.api.getChatByIdAsync(applied.mapping['source-chat']));
    } finally {
      setActiveChatsRuntime(previous);
      await sqlite.runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('refuses a whole-collection write on sqlite and keeps the sync API legacy-only', async () => {
    const sqlite = await sqliteRuntime();
    await assert.rejects(sqlite.api.saveChatsAsync([]), { code: 'chats_save_all_unsupported' });
    const previous = setActiveChatsRuntime(sqlite.runtime);
    try {
      assert.throws(() => loadChats(), { code: 'chats_sync_api_unavailable' });
      assert.throws(() => addChat('x', 'T'), { code: 'chats_sync_api_unavailable' });
      assert.equal((await (await import('../lib/persist/chats-persist.js')).loadChatsAsync()).length, 0);
    } finally {
      setActiveChatsRuntime(previous);
    }
    assert.doesNotThrow(() => loadChats());
  });
});

// ---------------------------------------------------------------------------------------------------
// Marker, gate and store validation
// ---------------------------------------------------------------------------------------------------

function sqliteMarker(dataDir, overrides = {}) {
  return writeChatsBackendMarker(dataDir, { backend: 'sqlite', datasetGeneration: GEN, storeFile: 'chats.sqlite', ...overrides }, { expectedRevision: 0 });
}

function createStoreFile(dir, { bind = GEN } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const handle = openStorageDb({ dir, filename: 'chats.sqlite', create: true });
  try {
    if (bind) bindDatasetGeneration(handle.db, bind);
  } finally {
    handle.close();
  }
}

const GATE_ON = { [CHATS_RUNTIME_TEST_HOOK]: { sqliteEnabled: true } };
const runtimeOptions = (dataDir, extra = {}) => ({ dataDir, writeGate: WRITE_GATE_TEST_EXEMPTION, handlersPath: HANDLERS_PATH, ...extra });

describe('backend marker', () => {
  it('no marker means the legacy runtime', async () => {
    const dir = tempDir('chats-marker-');
    const runtime = await openChatsRuntime(runtimeOptions(dir));
    assert.equal(runtime.backendKind, 'legacy');
    assert.equal(runtime.marker.revision, 0);
  });

  it('sqlite marker with the gate off is chats_sqlite_not_enabled even for a valid store', async () => {
    const dir = tempDir('chats-marker-');
    createStoreFile(dir);
    sqliteMarker(dir);
    await assert.rejects(openChatsRuntime(runtimeOptions(dir)), { code: 'chats_sqlite_not_enabled' });
    // And it does not fall back: the legacy file stays untouched and is not consulted.
    assert.equal(fs.existsSync(path.join(dir, 'chats.json')), false);
  });

  it('with the gate on: missing, empty, unbound and mismatched stores refuse with their own codes', async () => {
    const missing = tempDir('chats-marker-');
    sqliteMarker(missing);
    await assert.rejects(openChatsRuntime(runtimeOptions(missing, GATE_ON)), { code: 'chats_store_missing' });
    assert.equal(fs.existsSync(path.join(missing, 'chats.sqlite')), false, 'an empty store is never created');

    const empty = tempDir('chats-marker-');
    fs.writeFileSync(path.join(empty, 'chats.sqlite'), '');
    sqliteMarker(empty);
    await assert.rejects(openChatsRuntime(runtimeOptions(empty, GATE_ON)), { code: 'chats_store_missing' });

    const unbound = tempDir('chats-marker-');
    createStoreFile(unbound, { bind: null });
    sqliteMarker(unbound);
    await assert.rejects(openChatsRuntime(runtimeOptions(unbound, GATE_ON)), { code: 'chats_store_unbound' });

    const mismatch = tempDir('chats-marker-');
    createStoreFile(mismatch, { bind: 'gen-other' });
    sqliteMarker(mismatch);
    await assert.rejects(openChatsRuntime(runtimeOptions(mismatch, GATE_ON)), { code: 'chats_generation_mismatch' });
  });

  it('with the gate on and a matching store the sqlite runtime serves the async API only', async () => {
    const dir = tempDir('chats-marker-');
    createStoreFile(dir);
    sqliteMarker(dir);
    const runtime = await openChatsRuntime(runtimeOptions(dir, { ...GATE_ON, deps: recordingDeps([]) }));
    try {
      assert.equal(runtime.backendKind, 'sqlite');
      await runtime.api.addChatAsync('s', 'T', undefined, '/w/a', undefined, { id: 'a' });
      assert.equal((await runtime.api.getChatByIdAsync('a')).title, 'T');
    } finally {
      await runtime.close();
    }
  });

  it('an unreadable or inconsistent marker refuses and never opens an empty store', async () => {
    const cases = {
      'not json': '{nope',
      'wrong schema': JSON.stringify({ schema: 'x', backend: 'sqlite', revision: 1 }),
      'unknown backend': JSON.stringify({ schema: 'cretli-chats-backend-v1', backend: 'mongo', revision: 1 }),
      'bad revision': JSON.stringify({ schema: 'cretli-chats-backend-v1', backend: 'sqlite', revision: 0, datasetGeneration: GEN, storeFile: 'chats.sqlite' }),
      'sqlite without generation': JSON.stringify({ schema: 'cretli-chats-backend-v1', backend: 'sqlite', revision: 1, storeFile: 'chats.sqlite' }),
      'store file with a path': JSON.stringify({ schema: 'cretli-chats-backend-v1', backend: 'sqlite', revision: 1, datasetGeneration: GEN, storeFile: '../chats.sqlite' }),
      'rollback without manifest': JSON.stringify({ schema: 'cretli-chats-backend-v1', backend: 'legacy-rollback', revision: 1 }),
    };
    for (const [label, text] of Object.entries(cases)) {
      const dir = tempDir('chats-marker-');
      fs.writeFileSync(path.join(dir, 'chats-backend.json'), text);
      await assert.rejects(openChatsRuntime(runtimeOptions(dir, GATE_ON)), { code: 'chats_marker_invalid' }, label);
      assert.equal(fs.existsSync(path.join(dir, 'chats.sqlite')), false, label);
    }
    const dirMarker = tempDir('chats-marker-');
    fs.mkdirSync(path.join(dirMarker, 'chats-backend.json'));
    await assert.rejects(openChatsRuntime(runtimeOptions(dirMarker)), { code: 'chats_marker_invalid' });
  });

  it('a valid rollback marker parses but is not activated before the rollback leaf', async () => {
    const dir = tempDir('chats-marker-');
    writeChatsBackendMarker(dir, { backend: 'legacy-rollback', exportManifestHash: 'sha256:x', exportDir: 'exports/r1' }, { expectedRevision: 0 });
    assert.equal(readChatsBackendMarker(dir).backend, 'legacy-rollback');
    await assert.rejects(openChatsRuntime(runtimeOptions(dir, GATE_ON)), { code: 'chats_backend_unsupported' });
  });

  it('marker writes are compare-and-swap on revision', () => {
    const dir = tempDir('chats-marker-');
    const first = sqliteMarker(dir);
    assert.equal(first.revision, 1);
    assert.throws(
      () => writeChatsBackendMarker(dir, { backend: 'sqlite', datasetGeneration: GEN, storeFile: 'chats.sqlite' }, { expectedRevision: 0 }),
      (err) => err instanceof ChatsBackendError && err.code === 'chats_marker_conflict',
    );
    const second = writeChatsBackendMarker(dir, { backend: 'sqlite', datasetGeneration: GEN, storeFile: 'chats.sqlite' }, { expectedRevision: 1 });
    assert.equal(second.revision, 2);
  });
});

// ---------------------------------------------------------------------------------------------------
// Durability of the sqlite adapter
// ---------------------------------------------------------------------------------------------------

/** Store proxy that records calls and can inject faults around the real store. */
function instrument(store, hooks = {}) {
  const calls = [];
  const proxy = { ...store };
  for (const op of ['add', 'update', 'updateMany', 'remove', 'archive', 'markRead', 'importBatch']) {
    proxy[op] = async (args) => {
      calls.push({ op, commandId: args.commandId, args });
      const verdict = hooks.before?.(op, args, calls.length);
      if (verdict?.throwBefore) throw verdict.throwBefore;
      const reply = await hooks.around?.(op, args, () => store[op](args)) ?? await store[op](args);
      if (verdict?.throwAfter) throw verdict.throwAfter;
      return reply;
    };
  }
  proxy.resolveUnknown = async (args) => {
    calls.push({ op: 'resolveUnknown', commandId: args.commandId, args });
    return hooks.resolve ? hooks.resolve(args, () => store.resolveUnknown(args)) : store.resolveUnknown(args);
  };
  return { proxy, calls };
}

const unknownCommit = () => new StorageError('unknown_commit', 'lost reply');
const casConflict = () => new StorageError('conflict', 'cas', { details: { conflictKind: 'chat_cas', commitState: 'not_committed' } });

async function seeded(hooks, backendOptions = {}) {
  const { store } = await startStore();
  const { proxy, calls } = instrument(store, hooks);
  await store.add({ commandId: 'seed', chat: { id: 'a', title: 'T', workspaceFolder: '/w/a', createdAt: '2026-01-01' } });
  const backend = createSqliteChatsBackend({ store: proxy, ...backendOptions });
  return { store, backend, calls };
}

describe('sqlite adapter write durability', () => {
  it('replays the same commandId and digest to the stored result and refuses another digest', async () => {
    const { store } = await startStore();
    const chat = { id: 'r', title: 'T', createdAt: '2026-01-01' };
    const first = await store.add({ commandId: 'same', chat });
    const again = await store.add({ commandId: 'same', chat });
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    await assert.rejects(store.add({ commandId: 'same', chat: { ...chat, title: 'Other' } }), (err) => err.details?.conflictKind === 'receipt_digest_mismatch');
    assert.equal((await store.counts({})).total, 1);
  });

  it('unknown_commit that did commit resolves to the stored result without a second command', async () => {
    const { backend, calls, store } = await seeded({ before: (op) => (op === 'update' ? { throwAfter: unknownCommit() } : undefined) });
    const updated = await backend.updateChat('a', { model: 'm1' });
    assert.equal(updated.model, 'm1');
    assert.equal(calls.filter((c) => c.op === 'update').length, 1);
    assert.equal(calls.filter((c) => c.op === 'resolveUnknown').length, 1);
    assert.equal((await store.get({ id: 'a' })).chat.model, 'm1');
    assert.equal((await store.get({ id: 'a' })).revision, 2);
  });

  it('unknown_commit that did not commit retries the very same command', async () => {
    let first = true;
    const { backend, calls, store } = await seeded({
      before: (op) => {
        if (op === 'update' && first) { first = false; return { throwBefore: unknownCommit() }; }
        return undefined;
      },
    });
    const updated = await backend.updateChat('a', { model: 'm2' });
    assert.equal(updated.model, 'm2');
    const updates = calls.filter((c) => c.op === 'update');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].commandId, updates[1].commandId);
    assert.deepEqual(updates[0].args, updates[1].args);
    // resolveUnknown ran strictly before the retry.
    assert.ok(calls.findIndex((c) => c.op === 'resolveUnknown') < calls.lastIndexOf(updates[1]));
    assert.equal((await store.get({ id: 'a' })).revision, 2);
  });

  it('an unreconcilable unknown_commit fails closed: no retry, nothing published', async () => {
    const published = [];
    const { backend, calls } = await seeded({
      before: (op) => (op === 'update' ? { throwAfter: unknownCommit() } : undefined),
      resolve: async () => { throw new StorageError('conflict', 'digest', { details: { conflictKind: 'receipt_digest_mismatch' } }); },
    }, { effects: { updated: () => published.push('updated') } });
    await assert.rejects(backend.updateChat('a', { model: 'm3' }), (err) => err.details?.conflictKind === 'receipt_digest_mismatch');
    assert.equal(calls.filter((c) => c.op === 'update').length, 1);
    assert.deepEqual(published, []);
  });

  it('a persistent unknown_commit that never commits gives up after one retry', async () => {
    const { backend, calls } = await seeded({ before: (op) => (op === 'update' ? { throwBefore: unknownCommit() } : undefined) });
    await assert.rejects(backend.updateChat('a', { model: 'm4' }), { code: 'unknown_commit' });
    assert.equal(calls.filter((c) => c.op === 'update').length, 2);
  });

  it('a CAS conflict is retried on fresh state and surfaces as CONFLICT after 3 attempts', async () => {
    const published = [];
    const { backend, calls } = await seeded({ before: (op) => (op === 'update' ? { throwBefore: casConflict() } : undefined) }, { effects: { updated: () => published.push('updated') } });
    await assert.rejects(backend.updateChat('a', { model: 'm5' }), { code: 'CONFLICT' });
    assert.equal(calls.filter((c) => c.op === 'update').length, 3);
    assert.deepEqual(published, []);
  });

  it('a CAS conflict that clears on the second attempt succeeds with a new command on fresh state', async () => {
    const { backend, calls, store } = await seeded({
      before: (op, _args, n) => (op === 'update' && n === 1 ? { throwBefore: casConflict() } : undefined),
    });
    // A competing writer committed before the adapter's first command was refused.
    await store.update({ commandId: 'rival', id: 'a', expectedRevision: 1, set: { title: 'Rival' } });
    const updated = await backend.updateChat('a', { model: 'm6' });
    assert.equal(updated.title, 'Rival');
    assert.equal(updated.model, 'm6');
    const updates = calls.filter((c) => c.op === 'update');
    assert.equal(updates.length, 2);
    assert.notEqual(updates[0].commandId, updates[1].commandId, 'a new attempt is a new command');
    assert.equal(updates[1].args.expectedRevision, 2);
    assert.equal((await store.get({ id: 'a' })).revision, 3);
  });

  it('cache, push, broadcast and listeners are published only after COMMIT', async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let backendRef;
    const { backend, store } = await seeded({
      around: async (op, args, run) => {
        order.push(`${op}:start`);
        if (op === 'update') {
          assert.equal(backendRef.peekCachedRevision('a'), 1, 'cache still holds the old revision while the command is in flight');
          await gate;
        }
        const reply = await run();
        order.push(`${op}:committed`);
        return reply;
      },
    }, {
      effects: {
        updated: (id, chat) => order.push(`effect:updated:${chat.model}`),
        created: (entry) => order.push(`effect:created:${entry.id}`),
      },
    });
    backendRef = backend;
    const pending = backend.updateChat('a', { model: 'late' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(order, ['update:start']);
    release();
    await pending;
    assert.deepEqual(order, ['update:start', 'update:committed', 'effect:updated:late']);
    assert.equal(backend.peekCachedRevision('a'), 2);
    order.length = 0;
    await backend.addChat('s', 'New', undefined, undefined, undefined, { id: 'n' });
    assert.deepEqual(order, ['add:start', 'add:committed', 'effect:created:n']);
    assert.equal((await store.get({ id: 'n' })).chat.title, 'New');
  });

  it('a rejected command publishes nothing and leaves the cache on the committed revision', async () => {
    const published = [];
    const { backend, store } = await seeded({ before: (op) => (op === 'update' ? { throwBefore: new StorageError('conflict', 'x', { details: { conflictKind: 'chat_invalid_record' } }) } : undefined) },
      { effects: { updated: () => published.push('updated') } });
    await assert.rejects(backend.updateChat('a', { model: 'm' }), (err) => err.details?.conflictKind === 'chat_invalid_record');
    assert.deepEqual(published, []);
    assert.equal((await store.get({ id: 'a' })).revision, 1);
  });

  it('a lost race on a reserved id returns the winner row', async () => {
    const { backend } = await seeded({});
    const row = await backend.addChat('s2', 'Other', undefined, undefined, undefined, { id: 'a' });
    assert.equal(row.title, 'T');
  });
});

// ---------------------------------------------------------------------------------------------------
// Static guarantees
// ---------------------------------------------------------------------------------------------------

describe('static guarantees of the new modules', () => {
  const root = fileURLToPath(new URL('../lib/persist/', import.meta.url));
  const files = ['chats-runtime.js', 'chats-backend-domain.js', 'chats-backend-legacy.js', 'chats-backend-marker.js', 'chats-backend-sqlite.js'];
  const code = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('never blocks the thread on a worker', () => {
    for (const file of files) {
      assert.doesNotMatch(code(file), /Atomics\.wait|Atomics\.waitAsync|readFileSync\([^)]*sqlite/, file);
      assert.doesNotMatch(code(file), /child_process|execSync|spawnSync/, file);
    }
  });

  it('holds no lock across an await', () => {
    for (const file of files) {
      assert.doesNotMatch(code(file), /withFileLock|withChatsLock|acquireLock|\.lock\(|proper-lockfile|new Mutex|Semaphore/i, file);
    }
  });

  it('reads no chats.json outside the legacy adapter, marker and migration tools', () => {
    const rootDir = fileURLToPath(new URL('../', import.meta.url));
    const allowed = new Set([
      'lib/persist/chats-persist.js', 'lib/persist/chats-backend-legacy.js',
      'lib/persist/chats-backend-marker.js', 'scripts/chat-workspace-ids-migrate.mjs',
      'lib/persist/chats-backend-domain.js',
      // Writes a synthetic legacy dataset into its own temp data dir.
      'scripts/perf-bench.mjs',
    ]);
    const walk = (dir) => fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      return entry.isDirectory() ? (entry.name === 'node_modules' ? [] : walk(rel)) : (/\.(js|ts|mjs)$/.test(entry.name) ? [rel] : []);
    });
    const filesToCheck = [...walk('lib'), ...walk('scripts')];
    const directPath = /(?:resolveDataPath\s*\(\s*['"]chats\.json|(?:path\.)?join\([^\n;]*['"]chats\.json|['"](?:\.\.\/)?data\/chats\.json['"])/;
    for (const file of filesToCheck) {
      const rel = file.split(path.sep).join('/');
      if (allowed.has(rel)) continue;
      const source = fs.readFileSync(path.join(rootDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(source, directPath, rel);
    }
  });

  it('keeps the gate a code constant that is off by default', () => {
    assert.match(code('chats-runtime.js'), /export const CHATS_SQLITE_RUNTIME_ENABLED = false;/);
    assert.equal(CHATS_SQLITE_RUNTIME_ENABLED, false);
  });
});

describe('sqlite adapter multi-row atomicity', () => {
  /**
   * Archived subtree a -> b -> c, so restoring `a` rewrites three rows. `around(op, store, call)` wraps only the
   * commands issued after the setup (the setup archive is a multi-row command too).
   */
  async function archivedTree(around) {
    let armed = false;
    const ref = {};
    const ctx = await seeded({ around: (op, _args, call) => (armed && around ? around(op, ref.store, call) : call()) });
    ref.store = ctx.store;
    await ctx.store.add({ commandId: 's-b', chat: { id: 'b', title: 'B', forkParentChatId: 'a', workspaceFolder: '/w/a', createdAt: '2026-01-02' } });
    await ctx.store.add({ commandId: 's-c', chat: { id: 'c', title: 'C', forkParentChatId: 'b', workspaceFolder: '/w/a', createdAt: '2026-01-03' } });
    await ctx.backend.updateChat('a', { archived: true });
    armed = true;
    ctx.calls.length = 0;
    return ctx;
  }
  const states = async (store) => (await store.getMany({ ids: ['a', 'b', 'c'] })).chats.map((r) => [r.chat.id, r.revision, Boolean(r.chat.archivedAt)]);
  /** Another writer touches `c` right before the wrapped command runs. */
  const touchC = async (store) => {
    const row = await store.get({ id: 'c' });
    await store.update({ commandId: `other-${Math.random()}`, id: 'c', expectedRevision: row.revision, set: { model: String(Math.random()) } });
  };

  it('restore of a subtree is one updateMany command', async () => {
    const { backend, calls, store } = await archivedTree();
    await backend.updateChat('a', { archived: false });
    assert.equal(calls.filter((c) => c.op === 'updateMany').length, 1);
    assert.equal(calls.filter((c) => c.op === 'update').length, 0);
    assert.ok((await states(store)).every(([, , archived]) => !archived));
  });

  it('a failure in the command leaves every row unchanged', async () => {
    const { backend, store } = await archivedTree(async (op, _st, call) => {
      if (op === 'updateMany') throw new Error('boom');
      return call();
    });
    const before = await states(store);
    await assert.rejects(backend.updateChat('a', { archived: false }), /boom/);
    assert.deepEqual(await states(store), before);
    assert.ok(before.every(([, , archived]) => archived));
  });

  it('a stale revision on a non-target row commits nothing and the whole operation retries', async () => {
    let bumped = false;
    const { backend, calls, store } = await archivedTree(async (op, st, call) => {
      if (op === 'updateMany' && !bumped) { bumped = true; await touchC(st); }
      return call();
    });
    await backend.updateChat('a', { archived: false });
    assert.equal(calls.filter((c) => c.op === 'updateMany').length, 2);
    assert.ok((await states(store)).every(([, , archived]) => !archived));
  });

  it('a persistent CAS conflict ends in CONFLICT with nothing committed', async () => {
    const { backend, store } = await archivedTree(async (op, st, call) => {
      if (op === 'updateMany') await touchC(st);
      return call();
    });
    await assert.rejects(backend.updateChat('a', { archived: false }), (err) => err.code === 'CONFLICT');
    assert.ok((await states(store)).every(([, , archived]) => archived));
  });

  it('a subtree above the batch limit is rejected up-front with zero rows changed', async () => {
    const { backend, store, calls } = await archivedTree();
    const kids = Array.from({ length: 201 }, (_, n) => ({ id: `k${n}`, title: 'K', forkParentChatId: 'a', workspaceFolder: '/w/a', createdAt: '2026-01-04', archivedAt: 'T' }));
    for (let n = 0; n < kids.length; n += 200) await store.importBatch({ commandId: `kids-${n}`, chats: kids.slice(n, n + 200) });
    calls.length = 0;
    const before = await states(store);
    await assert.rejects(backend.updateChat('a', { archived: false }), (err) => err.code === 'chats_subtree_too_large');
    assert.equal(calls.filter((c) => c.op === 'update' || c.op === 'updateMany').length, 0);
    assert.deepEqual(await states(store), before);
    assert.equal((await store.get({ id: 'k200' })).revision, 1);
  });
});
