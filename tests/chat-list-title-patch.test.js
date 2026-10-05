/**
 * Chat list live sync consumers: a `chatsChanged` reason:'title' frame patches one row in
 * place (no `GET /api/chats`), and a reconcile that produced the same list repaints nothing
 * and rewrites no boot snapshot. Driven through the controller's injectable deps — no DOM.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatController } from '../app_front/features/chat/chatController.js';

function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
      writes.push(String(key));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    _writeCount(key) {
      return key ? writes.filter((entry) => entry === key).length : writes.length;
    },
  };
}

const BOOT_CACHE_KEY = 'cretli-chat-boot-cache-v1';

function createHarness() {
  const storage = createFakeStorage();
  const previousLocalStorage = globalThis.localStorage;
  const previousDocument = globalThis.document;
  globalThis.localStorage = storage;
  globalThis.document = {
    body: { classList: { contains: () => false } },
    getElementById: () => null,
  };
  const chats = [];
  const state = { renders: 0, activeChatId: '', selected: [] };
  const noop = () => {};
  let response = { ok: true, chats: [] };
  const controller = createChatController({
    api: { getChats: () => Promise.resolve(response) },
    CHAT_BUFFER_MAX: 1000,
    LAST_CHAT_ID_KEY: 'cretli-last-chat-id',
    getChats: () => chats,
    getActiveChatId: () => state.activeChatId,
    setActiveChatId: (next) => {
      state.activeChatId = next;
    },
    getWorkspaces: () => [],
    setWorkspaces: noop,
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFile: noop,
    getSelectedWorkspaceFolder: () => '',
    setSelectedWorkspaceFolder: noop,
    getSelectedModel: () => 'auto',
    setSelectedModel: noop,
    readChatBufferForChatRestore: () => null,
    updateFolderSelect: noop,
    renderModelSelectOptions: noop,
    renderChatList: () => {
      state.renders += 1;
    },
    updateChatBarSelect: noop,
    selectChat: (id) => state.selected.push(id),
    syncBackgroundChatConnections: noop,
    bindChatVisibilityAndReconnect: noop,
    startChatBackgroundMonitor: noop,
    startGlobalChatPingLoop: noop,
    ensureChatConnection: noop,
    teardownChatRuntime: noop,
    openTerminal: noop,
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: noop,
  });
  return {
    chats,
    state,
    storage,
    controller,
    restore() {
      globalThis.localStorage = previousLocalStorage;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
    respond(chats, archivedCounts) {
      response = { ok: true, chats, archivedCounts };
    },
    load() {
      return controller.loadChatsFromServer({ skipAutoSelect: true });
    },
  };
}

const serverRow = (overrides = {}) => ({
  id: 'chat-a',
  title: 'Old title',
  cursorSessionId: 'sess-a',
  workspaceFile: '/ws/a.code-workspace',
  workspaceFolder: '/ws/a',
  model: 'auto',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  ...overrides,
});

{
  const h = createHarness();
  try {
    h.respond([serverRow()]);
    await h.load();
    assert.equal(h.state.renders, 1, 'the first reconcile paints the list');
    assert.equal(h.storage._writeCount(BOOT_CACHE_KEY), 1, 'the first reconcile stores a snapshot');
    const row = h.chats.find((chat) => chat.id === 'chat-a');

    // --- a title frame patches the row in place ---------------------------------
    assert.equal(h.controller.patchChatTitle('chat-a', 'Generated title', 'auto'), true);
    assert.equal(row.title, 'Generated title');
    assert.equal(row.titleSource, 'auto');
    assert.equal(h.state.renders, 2, 'the patched row repaints the list once');
    // The list sorts by creation date, so a title change never reorders rows: `updatedAt`
    // stays server-authoritative and is never invented on the client.
    assert.equal(row.updatedAt, '2026-09-02T00:00:00.000Z', 'patching a title keeps updatedAt untouched');

    // --- an identical frame is a no-op (no repaint) -----------------------------
    assert.equal(h.controller.patchChatTitle('chat-a', 'Generated title', 'auto'), true);
    assert.equal(h.state.renders, 2, 'an unchanged title does not repaint the list');

    // --- a row this client does not have cannot be patched ----------------------
    assert.equal(h.controller.patchChatTitle('chat-unknown', 'Whatever', 'manual'), false);
    assert.equal(h.controller.patchChatTitle('', 'Whatever', 'manual'), false);
    assert.equal(h.controller.patchChatTitle('chat-a', '', 'manual'), false);
    assert.equal(h.state.renders, 2, 'a refused patch never repaints');
  } finally {
    h.restore();
  }
}

{
  const h = createHarness();
  try {
    h.respond([serverRow()]);
    await h.load();
    assert.equal(h.state.renders, 1);
    const writesAfterFirst = h.storage._writeCount(BOOT_CACHE_KEY);

    // --- an idempotent reload (the server sent exactly the same list) -----------
    await h.load();
    assert.equal(h.state.renders, 1, 'a reload that changed nothing skips the repaint');
    assert.equal(
      h.storage._writeCount(BOOT_CACHE_KEY),
      writesAfterFirst,
      'a reload that changed nothing rewrites no boot snapshot',
    );

    // --- a real change repaints and re-snapshots --------------------------------
    h.respond([serverRow({ title: 'Renamed by MCP' })]);
    await h.load();
    assert.equal(h.state.renders, 2, 'a changed list repaints');
    assert.equal(h.chats.find((chat) => chat.id === 'chat-a').title, 'Renamed by MCP');
    assert.equal(h.storage._writeCount(BOOT_CACHE_KEY), writesAfterFirst + 1);

    // --- the per-workspace archive count is part of the signature (sidebar badge) -
    h.respond([serverRow({ title: 'Renamed by MCP' })], { '/ws/a.code-workspace\n/ws/a': 2 });
    await h.load();
    assert.equal(h.state.renders, 3, 'a new archive count repaints even with identical rows');
  } finally {
    h.restore();
  }
}

// --- wiring lock: the browser entry point must consume the frame content -------------
// `app_front/chat.js` runs only in a browser, so its wiring is asserted by source scan.
// Without this the pure module and the controller would stay correct but disconnected.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatSource = readFileSync(path.join(root, 'app_front/chat.js'), 'utf8');
assert.match(chatSource, /onTitlePatched:/, 'the live sync must be given a title patcher');
assert.match(
  chatSource,
  /chatController\.patchChatTitle\(chatId, title, titleSource\)/,
  'the title patcher must be wired to the controller row patch',
);

console.log('chat-list-title-patch.test.js OK');
