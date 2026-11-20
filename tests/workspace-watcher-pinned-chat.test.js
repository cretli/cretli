/**
 * Pinned Workspace Chat tests.
 *
 * Covers: idempotent ensure/recover, the persisted `watcher` notice record, the
 * live presence row, autopilot materialization, and the GET/POST routes.
 *
 * Uses the isolated data dir helper (first import) and temp cwds.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChatAsync, deleteChatAsync, loadChatsAsync } from '../lib/persist/chats-persist.js';
import { appendChatNotice, loadChatHistory } from '../lib/persist/chat-history-persist.js';
import {
  getWorkspaceWatcher,
  loadWorkspaceWatchers,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  appendWorkspaceWatcherNotice,
  ensurePinnedChat,
} from '../lib/workspace-watcher-pinned-chat.js';
import { workspaceWatcherPresenceRows } from '../lib/workspace-watcher-live.js';
import { applyWorkspaceWatcherPatch } from '../lib/workspace-watcher-control.js';
import { registerWorkspaceWatcherRoutes } from '../lib/routes/workspace-watcher-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { registerChatsBackendTeardown, useChatsBackendFromEnv } from './helpers/chats-backends.js';

await useChatsBackendFromEnv();

let failed = 0;
/** Cases run one after another: they share the chats store and the watcher registry. */
let queue = Promise.resolve();

function runCase(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      console.log('OK:', name);
    } catch (err) {
      fail(name, err);
    }
  });
}

function fail(name, err) {
  failed += 1;
  console.error('FAIL:', name);
  console.error(err && err.stack ? err.stack : String(err));
}

const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-pinned-'));
const otherCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-pinned-other-'));
const dataDir = path.join(cwd, 'data');

function makeApp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
    put(p, fn) { handlers.set(`PUT ${p}`, fn); },
    patch(p, fn) { handlers.set(`PATCH ${p}`, fn); },
    delete(p, fn) { handlers.set(`DELETE ${p}`, fn); },
  };
  registerWorkspaceWatcherRoutes(app, { dataDir, getCurrentCwd: () => cwd });
  return (method, urlPath, req = {}) => {
    const fn = handlers.get(`${method} ${urlPath}`);
    if (!fn) throw new Error(`no handler ${method} ${urlPath}`);
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); },
      };
      fn({ params: {}, query: {}, body: {}, ...req }, res);
    });
  };
}

runCase('ensurePinnedChat creates one durable chat and stores pinnedChatId', async () => {
  const result = await ensurePinnedChat({ workspaceFolder: cwd, dataDir });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.ok(result.chatId);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.pinnedChatId, result.chatId);
  const chat = (await loadChatsAsync()).find((entry) => entry.id === result.chatId);
  assert.equal(chat.watcherPinned, true);
  assert.equal(chat.workspaceFolder, cwd);
});

runCase('ensurePinnedChat is idempotent while the chat exists', async () => {
  const first = await ensurePinnedChat({ workspaceFolder: cwd, dataDir });
  const before = (await loadChatsAsync()).filter((entry) => entry.watcherPinned === true).length;
  const second = await ensurePinnedChat({ workspaceFolder: cwd, dataDir });
  assert.equal(second.chatId, first.chatId);
  assert.equal(second.created, false);
  assert.equal((await loadChatsAsync()).filter((entry) => entry.watcherPinned === true).length, before);
});

runCase('ensurePinnedChat recreates the chat when it was deleted', async () => {
  const first = await ensurePinnedChat({ workspaceFolder: cwd, dataDir });
  await deleteChatAsync(first.chatId);
  assert.equal((await loadChatsAsync()).some((entry) => entry.id === first.chatId), false);
  const recreated = await ensurePinnedChat({ workspaceFolder: cwd, dataDir });
  assert.equal(recreated.ok, true);
  assert.equal(recreated.created, true);
  assert.equal(recreated.chatId, first.chatId, 'reuses the stored id so the feed stays continuous');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).pinnedChatId, first.chatId);
});

runCase('ensurePinnedChat recovers a surviving marked chat whose row id was lost', async () => {
  const survivor = await addChatAsync('sess', 'Workspace watcher — recovered', null, otherCwd, undefined, {
    watcherPinned: true,
  });
  const recovered = await ensurePinnedChat({ workspaceFolder: otherCwd, dataDir });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.chatId, survivor.id);
  assert.equal(recovered.created, false);
  assert.equal(recovered.adopted, true);
  assert.equal(getWorkspaceWatcher(otherCwd, { dataDir }).pinnedChatId, survivor.id);
});

runCase('appendChatNotice stores a parseable watcher meta record', async () => {
  const pinned = await ensurePinnedChat({ workspaceFolder: cwd, dataDir });
  const result = appendChatNotice(pinned.chatId, 'Cycle started', {
    action: 'cycle_start',
    level: 'info',
    todoId: 'todo-1234',
  });
  assert.equal(result.ok, true);
  const doc = loadChatHistory(pinned.chatId);
  const rec = doc.events[doc.events.length - 1].rec;
  assert.equal(rec.kind, 'meta');
  assert.equal(rec.variant, 'watcher');
  const payload = JSON.parse(rec.payload);
  assert.equal(payload.text, 'Cycle started');
  assert.equal(payload.action, 'cycle_start');
  assert.equal(payload.todoId, 'todo-1234');
  assert.ok(Number.isFinite(Date.parse(payload.at)));
});

runCase('appendChatNotice rejects empty text and unknown chats', async () => {
  const pinned = await ensurePinnedChat({ workspaceFolder: cwd, dataDir });
  assert.equal(appendChatNotice(pinned.chatId, '   ').ok, false);
  assert.equal(appendChatNotice('../escape', 'x').ok, false);
});

runCase('appendWorkspaceWatcherNotice materializes the pinned chat on first notice', async () => {
  const noticeCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-pinned-notice-'));
  const result = await appendWorkspaceWatcherNotice({
    workspaceFolder: noticeCwd,
    dataDir,
    action: 'decision',
    level: 'info',
    text: 'Decision: start_cycle (ready)',
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  const doc = loadChatHistory(result.chatId);
  assert.ok(doc.events.length >= 1);
  const payload = JSON.parse(doc.events[doc.events.length - 1].rec.payload);
  assert.equal(payload.action, 'decision');
  assert.equal(payload.workspaceFolder.replace(/\\/g, '/'), noticeCwd.replace(/\\/g, '/'));
});

runCase('presence rows carry pinnedChatId for the sidebar', async () => {
  const presenceCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-pinned-presence-'));
  const pinned = await ensurePinnedChat({ workspaceFolder: presenceCwd, dataDir });
  upsertWorkspaceWatcher(presenceCwd, { mode: 'autopilot' }, { dataDir });
  const rows = workspaceWatcherPresenceRows(loadWorkspaceWatchers({ dataDir }));
  const row = rows.find((entry) => entry.workspaceFolder === presenceCwd);
  assert.ok(row, 'autopilot row is present');
  assert.equal(row.pinnedChatId, pinned.chatId);
});

runCase('enabling autopilot materializes the pinned chat', async () => {
  const autoCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-pinned-auto-'));
  const watcher = applyWorkspaceWatcherPatch({
    dataDir,
    workspaceFolder: autoCwd,
    patch: { mode: 'autopilot' },
  });
  // The patch returns synchronously; the chat is materialized in the background and the row gets its id afterwards.
  let stored = watcher;
  for (let i = 0; i < 100 && !stored?.pinnedChatId; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    stored = getWorkspaceWatcher(autoCwd, { dataDir });
  }
  assert.ok(stored?.pinnedChatId);
  assert.ok((await loadChatsAsync()).some((entry) => entry.id === stored.pinnedChatId && entry.watcherPinned === true));
});

runCase('concurrent ensurePinnedChat calls share one resolution and create a single chat', async () => {
  const raceCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-pinned-race-'));
  const results = await Promise.all([
    ensurePinnedChat({ workspaceFolder: raceCwd, dataDir }),
    ensurePinnedChat({ workspaceFolder: raceCwd, dataDir }),
    ensurePinnedChat({ workspaceFolder: raceCwd, dataDir }),
  ]);
  assert.equal(new Set(results.map((entry) => entry.chatId)).size, 1);
  const pinned = (await loadChatsAsync()).filter((entry) => entry.watcherPinned === true && entry.workspaceFolder === raceCwd);
  assert.equal(pinned.length, 1);
});

runCase('ensurePinnedChat rejects a missing workspace without touching the store', async () => {
  assert.deepEqual(await ensurePinnedChat({ workspaceFolder: '', dataDir }), { ok: false, reason: 'no_workspace' });
});

runCase('GET/POST /api/workspace-watcher/pinned-chat', async () => {
  const invoke = makeApp();
  const freshCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-pinned-route-'));
  const empty = await invoke('GET', '/api/workspace-watcher/pinned-chat', { query: { workspaceFolder: freshCwd } });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.ok, true);
  assert.equal(empty.body.chatId, '', 'GET must not create the chat');

  const created = await invoke('POST', '/api/workspace-watcher/pinned-chat', { body: { workspaceFolder: freshCwd } });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.ok(created.body.chatId);

  const again = await invoke('POST', '/api/workspace-watcher/pinned-chat', { body: { workspaceFolder: freshCwd } });
  assert.equal(again.body.chatId, created.body.chatId, 'POST is idempotent');

  const read = await invoke('GET', '/api/workspace-watcher/pinned-chat', { query: { workspaceFolder: freshCwd } });
  assert.equal(read.body.chatId, created.body.chatId);
});

await queue;
removeIsolatedDataDir();
if (failed > 0) {
  console.error(`${failed} pinned chat test(s) failed`);
  process.exit(1);
}
console.log('workspace watcher pinned chat tests passed');

registerChatsBackendTeardown();
