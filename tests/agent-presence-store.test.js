/**
 * Chat-keyed agent presence store.
 *
 * Presence used to live only as `_serverRunState` on a chat object, and every apply walked
 * the *current* `chats` array, so any id the client did not have yet was dropped: the WS
 * subscription snapshot lands while `GET /api/chats` is still in flight, a delegation
 * sub-chat is appended a moment later, and the server re-sends a row only when its
 * fingerprint changes. These tests pin the store, both producers
 * (`applyAgentPresenceToChats`, `applyAgentStatesToChats`) and the `chatController`
 * hydration that makes a remembered row land on the chat object the moment it exists,
 * without waiting for another frame.
 *
 * `app_front/chat.js` runs only in a browser, so its wiring is asserted by source scan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __resetAgentPresenceStoreForTest,
  agentRunStateDedupeKey,
  applyDelta,
  applySnapshot,
  forget,
  get,
  hydrateChat,
} from '../app_front/features/chat/agentPresenceStore.js';
import {
  applyAgentPresenceToChats,
  applyAgentStatesToChats,
} from '../app_front/features/chat/chatHistorySyncPoll.js';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { writeChatLocalBootCache } from '../app_front/features/chat/chatLocalBootCache.js';
import { shouldApplyPushInboxPresenceRecord } from '../lib/push-inbox-logic.js';

const WS_BUSY = { state: 'busy', activityKey: 'read', activityArg: 'a.js' };
const WS_WAITING = { state: 'waiting', waitingAgentCount: 2, delegationId: 'd1' };

function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
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
    },
    removeItem(key) {
      map.delete(String(key));
    },
  };
}

const previousGlobals = {
  localStorage: globalThis.localStorage,
  document: globalThis.document,
};

function installBrowserShims(storage) {
  globalThis.localStorage = storage;
  globalThis.document = {
    body: { classList: { contains: () => false } },
    getElementById: () => null,
  };
}

function restoreBrowserShims() {
  if (previousGlobals.localStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousGlobals.localStorage;
  if (previousGlobals.document === undefined) delete globalThis.document;
  else globalThis.document = previousGlobals.document;
}

/**
 * Drives the real controller through its injectable deps (same shape as
 * `chat-local-boot-cache.test.js`). `onPresenceHydrate` receives the ids whose presence
 * changed while the list was merged — that is what schedules the in-place sidebar refresh.
 *
 * @param {{
 *   chats: object[],
 *   serverChats: object[] | null,
 *   storage?: ReturnType<typeof createFakeStorage>,
 *   onPresenceHydrate?: (ids: string[]) => void,
 * }} input
 * Installs the browser shims and leaves them in place: the controller reads
 * `localStorage`/`document` when `loadChatsFromServer` runs, so the caller restores them
 * after the load settles.
 */
function createControllerHarness(input) {
  const noop = () => {};
  const chats = input.chats;
  installBrowserShims(input.storage || createFakeStorage());
  // `null` server chats model a request that has not answered yet: only the synchronous
  // boot-cache path runs, which is what the "first render already shows busy" case needs.
  const getChats = input.serverChats === null
    ? () => new Promise(() => {})
    : () => Promise.resolve({ ok: true, chats: input.serverChats, archivedCounts: {} });
  return createChatController({
    api: { getChats },
    CHAT_BUFFER_MAX: 1000,
    LAST_CHAT_ID_KEY: 'cretli-last-chat-id',
    getChats: () => chats,
    getActiveChatId: () => '',
    setActiveChatId: noop,
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
    renderChatList: noop,
    updateChatBarSelect: noop,
    selectChat: noop,
    syncBackgroundChatConnections: noop,
    bindChatVisibilityAndReconnect: noop,
    startChatBackgroundMonitor: noop,
    startGlobalChatPingLoop: noop,
    ensureChatConnection: noop,
    teardownChatRuntime: noop,
    teardownBlockedChatRuntime: noop,
    openTerminal: noop,
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: noop,
    onPresenceHydrate: input.onPresenceHydrate,
  });
}

test('snapshot replaces the whole store, delta only touches named ids', () => {
  __resetAgentPresenceStoreForTest();
  const at = applySnapshot({ a: WS_BUSY }, 1000);
  assert.equal(at, 1000);
  assert.deepEqual(get('a'), WS_BUSY);
  applyDelta({ b: WS_WAITING }, [], 1100);
  assert.deepEqual(get('b'), WS_WAITING);
  // "Not named by this snapshot" is an explicit idle, and it applies to remembered rows
  // for chats the client has no object for either.
  applySnapshot({ a: WS_BUSY }, 1200);
  assert.equal(get('b'), null, 'a snapshot clears a remembered row for an absent id');
  assert.deepEqual(get('a'), WS_BUSY);
});

test('delta cleared list marks an id idle without dropping its watermark', () => {
  __resetAgentPresenceStoreForTest();
  applyDelta({ c: WS_BUSY }, [], 1000);
  assert.equal(hydrateChat({ id: 'c' }), true);
  applyDelta({}, ['c'], 2000);
  assert.equal(get('c'), null);
  const chat = { id: 'c' };
  assert.equal(hydrateChat(chat), false, 'idle onto idle is no visible change');
  assert.equal(chat._serverRunStateAt, 2000, 'the watermark still advances');
});

test('hydrateChat never rolls a chat object back to an older server row', () => {
  __resetAgentPresenceStoreForTest();
  applyDelta({ a: WS_BUSY }, [], 1000);
  const chat = { id: 'a', _serverRunState: WS_WAITING, _serverRunStateAt: 5000 };
  assert.equal(hydrateChat(chat), false);
  assert.deepEqual(chat._serverRunState, WS_WAITING);
  assert.equal(chat._serverRunStateAt, 5000);
});

test('an unknown chat id is left untouched (no state, no watermark)', () => {
  __resetAgentPresenceStoreForTest();
  const chat = { id: 'never-seen' };
  assert.equal(hydrateChat(chat), false);
  assert.equal(chat._serverRunState, undefined);
  assert.equal(chat._serverRunStateAt, undefined);
});

test('forget drops the remembered row so a deleted chat cannot resurrect a status', () => {
  __resetAgentPresenceStoreForTest();
  applyDelta({ gone: WS_BUSY }, [], 1000);
  assert.equal(forget('gone'), true);
  assert.equal(forget('gone'), false);
  assert.equal(get('gone'), null);
  const chat = { id: 'gone' };
  assert.equal(hydrateChat(chat), false);
  assert.equal(chat._serverRunStateAt, undefined);
});

test('the WS producers write through the store before touching chat objects', () => {
  __resetAgentPresenceStoreForTest();
  // The subscription snapshot lands while the list is still empty.
  const snapshot = applyAgentPresenceToChats([], { snapshot: true, states: { late: WS_BUSY } });
  assert.deepEqual(snapshot, { changed: false, dirtyIds: [] });
  assert.deepEqual(get('late'), WS_BUSY);
  const lateChat = { id: 'late' };
  assert.equal(hydrateChat(lateChat), true);
  assert.equal(lateChat._serverRunState.state, 'busy');
  assert.ok(lateChat._serverRunStateAt > 0);

  // A delta naming a delegation sub-chat the client has never seen is remembered too.
  const chats = [{ id: 'known' }];
  const delta = applyAgentPresenceToChats(chats, {
    snapshot: false,
    states: { known: WS_WAITING, 'unknown-child': WS_BUSY },
    cleared: ['unknown-cleared'],
  });
  assert.deepEqual(delta.dirtyIds, ['known']);
  assert.deepEqual(get('unknown-child'), WS_BUSY);
  const child = { id: 'unknown-child' };
  assert.equal(hydrateChat(child), true);
  assert.equal(child._serverRunState.state, 'busy');
  assert.equal(get('unknown-cleared'), null);
  const cleared = { id: 'unknown-cleared' };
  assert.equal(hydrateChat(cleared), false, 'a cleared unknown id has nothing to paint');
  assert.ok(cleared._serverRunStateAt > 0, 'but its server watermark still blocks an older push record');

  // A snapshot that omits an id clears it even when no chat object exists for it.
  applyAgentPresenceToChats([{ id: 'known' }], { snapshot: true, states: { known: WS_WAITING } });
  assert.equal(get('unknown-child'), null);
  const stale = { id: 'unknown-child', _serverRunState: WS_BUSY };
  assert.equal(hydrateChat(stale), true);
  assert.equal(stale._serverRunState, null);
});

test('applyAgentStatesToChats updates inFlightChildCount when state and waitingAgentCount are unchanged', () => {
  __resetAgentPresenceStoreForTest();
  const waitingBase = { state: 'waiting', waitingAgentCount: 1 };
  const chats = [{
    id: 'archived-parent',
    _serverRunState: { ...waitingBase, inFlightChildCount: 1 },
  }];
  const dropChild = applyAgentStatesToChats(chats, {
    'archived-parent': { ...waitingBase, inFlightChildCount: 0 },
  });
  assert.equal(dropChild.changed, true);
  assert.deepEqual(dropChild.dirtyIds, ['archived-parent']);
  assert.equal(chats[0]._serverRunState.inFlightChildCount, 0);

  const addChild = applyAgentStatesToChats(chats, {
    'archived-parent': { ...waitingBase, inFlightChildCount: 1 },
  });
  assert.equal(addChild.changed, true);
  assert.deepEqual(addChild.dirtyIds, ['archived-parent']);
  assert.equal(chats[0]._serverRunState.inFlightChildCount, 1);
});

test('agentRunStateDedupeKey treats inFlightChildCount as part of visible identity', () => {
  const base = { state: 'waiting', waitingAgentCount: 1, inFlightChildCount: 1 };
  assert.equal(
    agentRunStateDedupeKey(base),
    agentRunStateDedupeKey({ ...base, inFlightChildCount: 1 }),
    'identical counters must dedupe'
  );
  assert.notEqual(
    agentRunStateDedupeKey(base),
    agentRunStateDedupeKey({ ...base, inFlightChildCount: 0 }),
    'inFlightChildCount alone must change the key'
  );
});

test('hydrateChat applies inFlightChildCount when only that counter changes', () => {
  __resetAgentPresenceStoreForTest();
  const waitingBase = { state: 'waiting', waitingAgentCount: 1 };
  applyDelta({
    parent: { ...waitingBase, inFlightChildCount: 0 },
  }, [], 1000);
  const chat = {
    id: 'parent',
    _serverRunState: { ...waitingBase, inFlightChildCount: 1 },
    _serverRunStateAt: 0,
  };
  assert.equal(hydrateChat(chat), true);
  assert.equal(chat._serverRunState.inFlightChildCount, 0);
});

test('the HTTP agent-states map replaces the store like a snapshot', () => {
  __resetAgentPresenceStoreForTest();
  applyAgentPresenceToChats([], { snapshot: false, states: { remembered: WS_BUSY } });
  const chats = [{ id: 'known', _serverRunState: WS_BUSY }];
  const applied = applyAgentStatesToChats(chats, {
    known: { state: 'waiting', waitingAgentCount: 3 },
  });
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.dirtyIds, ['known']);
  assert.equal(get('remembered'), null, 'the full HTTP map is authoritative for every id');
  assert.deepEqual(get('known'), { state: 'waiting', waitingAgentCount: 3 });
  assert.equal(chats[0]._serverRunStateAt, get && chats[0]._serverRunStateAt);

  // An unchanged HTTP response is still authoritative: both watermarks move together.
  const before = chats[0]._serverRunStateAt;
  const unchanged = applyAgentStatesToChats(chats, { known: { state: 'waiting', waitingAgentCount: 3 } });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.dirtyIds, [], 'a watermark-only advance dirties no row');
  assert.ok(chats[0]._serverRunStateAt >= before);
  assert.ok(chats[0]._serverRunStateAt > 0);
});

test('a push-inbox record older than the hydrated watermark is still rejected', () => {
  __resetAgentPresenceStoreForTest();
  applyAgentStatesToChats([], { 'future-child': WS_BUSY });
  const child = { id: 'future-child' };
  assert.equal(hydrateChat(child), true);
  const watermark = child._serverRunStateAt;
  assert.ok(watermark > 0);
  assert.equal(
    shouldApplyPushInboxPresenceRecord({ receivedAt: watermark - 1 }, child, watermark),
    false,
    'the server row must keep blocking an older push record'
  );
  assert.equal(
    shouldApplyPushInboxPresenceRecord({ receivedAt: watermark + 1 }, child, watermark + 2),
    true,
    'a genuinely newer push record must still get through'
  );
});

test('a chat row created by loadChatsFromServer starts with its remembered presence', async () => {
  __resetAgentPresenceStoreForTest();
  applyAgentPresenceToChats([], { snapshot: true, states: { 'late-child': WS_BUSY } });
  const chats = [];
  const hydratedBatches = [];
  const controller = createControllerHarness({
    chats,
    serverChats: [
      { id: 'late-child', title: 'Late', cursorSessionId: 's-late' },
      { id: 'fresh', title: 'Fresh', cursorSessionId: 's-fresh' },
    ],
    onPresenceHydrate: (ids) => hydratedBatches.push(ids),
  });
  try {
    await controller.loadChatsFromServer({ skipAutoSelect: true });
  } finally {
    restoreBrowserShims();
  }
  const late = chats.find((chat) => chat.id === 'late-child');
  assert.equal(late._serverRunState?.state, 'busy', 'no second frame may be needed');
  assert.ok(late._serverRunStateAt > 0);
  assert.equal(chats.find((chat) => chat.id === 'fresh')._serverRunState, undefined,
    'a chat the server never mentioned gets no watermark');
  assert.deepEqual(hydratedBatches, [['late-child']]);
});

test('a boot-cache row is hydrated before the cached list is rendered', () => {
  __resetAgentPresenceStoreForTest();
  const storage = createFakeStorage();
  installBrowserShims(storage);
  writeChatLocalBootCache(storage, {
    activeChatId: 'cached-child',
    workspaceContext: { workspaceFile: '', workspaceFolder: '' },
    workspaces: [],
    chats: [{ id: 'cached-child', title: 'Cached', cursorSessionId: 's-cached' }],
  });
  applyAgentPresenceToChats([], { snapshot: true, states: { 'cached-child': WS_WAITING } });

  const chats = [];
  const hydratedBatches = [];
  const controller = createControllerHarness({
    chats,
    serverChats: null,
    storage,
    onPresenceHydrate: (ids) => hydratedBatches.push(ids),
  });
  try {
    // The cache path is synchronous: the status must already be correct on this frame.
    void controller.loadChatsFromServer({});
    assert.equal(chats.length, 1);
    assert.equal(chats[0].id, 'cached-child');
    assert.equal(chats[0]._serverRunState?.state, 'waiting');
    assert.ok(chats[0]._serverRunStateAt > 0);
    assert.deepEqual(hydratedBatches, [['cached-child']]);
  } finally {
    restoreBrowserShims();
  }
});

test('a live presence frame still wins over the remembered row', () => {
  __resetAgentPresenceStoreForTest();
  applySnapshot({ a: WS_BUSY }, 1000);
  const chats = [{ id: 'a', _serverRunState: WS_BUSY, _serverRunStateAt: 1000 }];
  assert.equal(hydrateChat(chats[0]), false);
  const result = applyAgentPresenceToChats(chats, { snapshot: false, states: { a: WS_WAITING } });
  assert.deepEqual(result.dirtyIds, ['a']);
  assert.equal(chats[0]._serverRunState.state, 'waiting');
  assert.equal(get('a').state, 'waiting');
});

test('chat.js clears the store entry on delete and the controller hydrates on load', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const chatSource = readFileSync(path.join(root, 'app_front/chat.js'), 'utf8');
  assert.match(chatSource, /agentPresenceStore\.js'/, 'chat.js must import the store');
  assert.match(chatSource, /forgetPresenceChat\(/, 'deleting a chat must drop its remembered row');

  const controllerSource = readFileSync(
    path.join(root, 'app_front/features/chat/chatController.js'),
    'utf8'
  );
  assert.match(controllerSource, /hydratePresenceChat\(/, 'the controller must hydrate new rows');
  assert.match(controllerSource, /onPresenceHydrate/, 'and report the ids it changed');
});

test('the store is never persisted and keeps the shared presence identity', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const storeSource = readFileSync(
    path.join(root, 'app_front/features/chat/agentPresenceStore.js'),
    'utf8'
  );
  assert.doesNotMatch(storeSource, /localStorage|sessionStorage|indexedDB/i,
    'a cached busy row would be worse than a momentary absence');

  // One identity function for every presence producer (WS, HTTP, push-inbox).
  const pollSource = readFileSync(
    path.join(root, 'app_front/features/chat/chatHistorySyncPoll.js'),
    'utf8'
  );
  assert.doesNotMatch(pollSource, /export function agentRunStateDedupeKey/,
    'the dedupe key must not be redefined outside the store');
  assert.equal(applySnapshot({}, 1), 1);
});
