/**
 * Explicit archive/restore reload: suppress echo `chatsChanged` frames without
 * canceling unrelated live-sync work; one user action stays one GET /api/chats.
 */
import assert from 'node:assert/strict';
import { createChatListExplicitReloadGuard } from '../app_front/features/chat/chatListExplicitReload.js';
import { createChatListLiveSync } from '../app_front/features/chat/chatListLiveSync.js';
import { createChatController } from '../app_front/features/chat/chatController.js';

{
  const guard = createChatListExplicitReloadGuard({ nowFn: () => 1000, ttlMs: 5000 });
  guard.begin(['c1']);
  assert.equal(guard.shouldSuppressChatsChanged({ reason: 'archive', chatId: 'c1' }), true);
  assert.equal(guard.shouldSuppressChatsChanged({ reason: 'restore', chatId: 'c1' }), true);
  assert.equal(guard.shouldSuppressChatsChanged({ reason: 'create', chatId: 'c1' }), false);
  assert.equal(guard.shouldSuppressChatsChanged({ reason: 'archive', chatId: 'c2' }), false);
  guard.end(['c1']);
  assert.equal(guard.shouldSuppressChatsChanged({ reason: 'archive', chatId: 'c1' }), false);
}

{
  const clock = { now: 0 };
  const guard = createChatListExplicitReloadGuard({ nowFn: () => clock.now, ttlMs: 100 });
  guard.begin(['c1']);
  clock.now = 200;
  assert.equal(guard.shouldSuppressChatsChanged({ reason: 'archive', chatId: 'c1' }), false);
}

function createLiveSyncHarness(guard) {
  const timers = [];
  const refreshCalls = [];
  const sync = createChatListLiveSync({
    refresh: async (query) => { refreshCalls.push(query); },
    shouldSuppressChatsChanged: (frame) => guard.shouldSuppressChatsChanged(frame),
    setTimeoutFn: (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeoutFn: () => {},
    debounceMs: 150,
  });
  return { sync, timers, refreshCalls };
}

{
  const guard = createChatListExplicitReloadGuard();
  const { sync, timers, refreshCalls } = createLiveSyncHarness(guard);
  guard.begin(['arch-1']);
  sync.onChatsChanged({ reason: 'archive', chatId: 'arch-1' });
  assert.equal(timers.length, 0, 'suppressed archive frame schedules no reload');
  sync.onChatsChanged({ reason: 'create', chatId: 'other' });
  assert.equal(timers.length, 1, 'independent create still schedules reload');
  timers[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshCalls.length, 1);
  guard.end(['arch-1']);
}

{
  const guard = createChatListExplicitReloadGuard();
  const { sync, timers, refreshCalls } = createLiveSyncHarness(guard);
  sync.onChatsChanged({ reason: 'create', chatId: 'pending' });
  assert.equal(timers.length, 1, 'unrelated reload already pending');
  guard.begin(['arch-2']);
  sync.onChatsChanged({ reason: 'archive', chatId: 'arch-2' });
  assert.equal(timers.length, 1, 'guard must not cancel the unrelated timer');
  timers[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshCalls.length, 1);
  guard.end(['arch-2']);
}

{
  const chats = [{ id: 'a', title: 'A' }];
  let getChatsCalls = 0;
  let resolveGetChats;
  const getChatsPromise = new Promise((resolve) => {
    resolveGetChats = resolve;
  });
  const controller = createChatController({
    api: {
      getChats: () => {
        getChatsCalls += 1;
        return getChatsPromise;
      },
    },
    CHAT_BUFFER_MAX: 100,
    LAST_CHAT_ID_KEY: 'last',
    getChats: () => chats,
    getActiveChatId: () => '',
    setActiveChatId: () => {},
    getWorkspaces: () => [],
    setWorkspaces: () => {},
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFolder: () => '',
    getSelectedModel: () => 'auto',
    readChatBufferForChatRestore: () => null,
    updateFolderSelect: () => {},
    renderModelSelectOptions: () => {},
    renderChatList: () => {},
    updateChatBarSelect: () => {},
    selectChat: () => {},
    syncBackgroundChatConnections: () => {},
    bindChatVisibilityAndReconnect: () => {},
    startChatBackgroundMonitor: () => {},
    startGlobalChatPingLoop: () => {},
    ensureChatConnection: () => {},
    teardownBlockedChatRuntime: () => {},
    teardownChatRuntime: () => {},
    openTerminal: () => {},
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: () => {},
  });
  const guard = createChatListExplicitReloadGuard();
  const refreshCalls = [];
  const sync = createChatListLiveSync({
    refresh: (query) => {
      refreshCalls.push(query);
      return controller.loadChatsFromServer(query);
    },
    shouldSuppressChatsChanged: (frame) => guard.shouldSuppressChatsChanged(frame),
    setTimeoutFn: (fn) => { fn(); return 1; },
    clearTimeoutFn: () => {},
    debounceMs: 0,
  });
  guard.begin(['a']);
  const explicitLoad = controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  sync.onChatsChanged({ reason: 'archive', chatId: 'a' });
  resolveGetChats({ ok: true, chats: [{ id: 'a', title: 'A' }] });
  await explicitLoad;
  await Promise.resolve();
  assert.equal(getChatsCalls, 1, 'explicit reload plus suppressed WS stays one GET');
  assert.equal(refreshCalls.length, 0, 'suppressed frame must not invoke refresh');
  guard.end(['a']);
}

/**
 * The `chatsChanged` archive/restore frame carries only `{ reason, chatId }` (the server
 * never puts the row state in it), so the guard cannot tell "my own trailing echo" from a
 * genuinely independent change of the same id by the frame alone. It recognizes the echo
 * by the CURRENT list state instead of a wall-clock window: a frame is redundant exactly
 * when the list already reflects its state. The predicate mirrors the one wired in
 * `chat.js` against the live `chats` array.
 */
function statePredicate(chats) {
  return (reason, chatId) => {
    const row = chats.find((entry) => entry.id === chatId);
    if (!row) return false;
    const archived = Boolean(String(row.archivedAt || '').trim());
    return reason === 'restore' ? !archived : archived;
  };
}

function makeReloadHarness(chats, serverSnapshot, reloadGuard) {
  let getChatsCalls = 0;
  const controller = createChatController({
    api: {
      getChats: () => {
        getChatsCalls += 1;
        // A fresh clone per call: the controller mutates rows in place then rebuilds the
        // shared `chats` array, so the caller's view tracks the server snapshot.
        return Promise.resolve({ ok: true, chats: serverSnapshot.map((c) => ({ ...c })) });
      },
    },
    CHAT_BUFFER_MAX: 100,
    LAST_CHAT_ID_KEY: 'last',
    getChats: () => chats,
    getActiveChatId: () => '',
    setActiveChatId: () => {},
    getWorkspaces: () => [],
    setWorkspaces: () => {},
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFolder: () => '',
    getSelectedModel: () => 'auto',
    readChatBufferForChatRestore: () => null,
    updateFolderSelect: () => {},
    renderModelSelectOptions: () => {},
    renderChatList: () => {},
    updateChatBarSelect: () => {},
    selectChat: () => {},
    syncBackgroundChatConnections: () => {},
    bindChatVisibilityAndReconnect: () => {},
    startChatBackgroundMonitor: () => {},
    startGlobalChatPingLoop: () => {},
    ensureChatConnection: () => {},
    teardownBlockedChatRuntime: () => {},
    teardownChatRuntime: () => {},
    openTerminal: () => {},
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: () => {},
  });
  const sync = createChatListLiveSync({
    refresh: (query) => controller.loadChatsFromServer(query),
    shouldIncludeArchived: () => false,
    shouldSuppressChatsChanged: (frame) => reloadGuard.shouldSuppressChatsChanged(frame),
    setTimeoutFn: (fn) => { fn(); return 1; },
    clearTimeoutFn: () => {},
    debounceMs: 0,
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { controller, sync, flush, getChatsCalls: () => getChatsCalls };
}

{
  // Own-echo recognition at the guard level: after end() clears the in-flight TTL, a
  // trailing archive frame whose state is already reflected is STILL suppressed, while an
  // independent restore of the same id (state not yet reflected) reloads. No arbitrary TTL
  // that would swallow the independent same-id change.
  const list = [{ id: 'x', archivedAt: '2026-10-05T00:00:00.000Z' }];
  const g = createChatListExplicitReloadGuard({
    nowFn: () => 1000,
    ttlMs: 5000,
    isChatStateAlreadyApplied: statePredicate(list),
  });
  g.begin(['x']);
  g.end(['x']); // reload finished; the HTTP-window TTL entry is gone.
  assert.equal(g.shouldSuppressChatsChanged({ reason: 'archive', chatId: 'x' }), true,
    'post-end() own archive echo still suppressed via list state');
  assert.equal(g.shouldSuppressChatsChanged({ reason: 'restore', chatId: 'x' }), false,
    'independent restore of same id is NOT suppressed (no wall-clock window)');
  // Once the list reflects the restore, its echo is redundant but an archive is a real change.
  list[0].archivedAt = '';
  assert.equal(g.shouldSuppressChatsChanged({ reason: 'restore', chatId: 'x' }), true);
  assert.equal(g.shouldSuppressChatsChanged({ reason: 'archive', chatId: 'x' }), false);
}

{
  // The exact finding, end to end: the explicit archive reload runs, `finally` calls end(),
  // THEN the trailing archive frame lands on the socket — still at most one full GET.
  const chats = [{ id: 'x', title: 'X' }];
  const snapshot = [{ id: 'x', title: 'X', archivedAt: '2026-10-05T00:00:00.000Z' }];
  const guard = createChatListExplicitReloadGuard({ isChatStateAlreadyApplied: statePredicate(chats) });
  const h = makeReloadHarness(chats, snapshot, guard);
  guard.begin(['x']);
  await h.controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(h.getChatsCalls(), 1, 'explicit archive reload issued one GET');
  assert.equal(chats.find((c) => c.id === 'x')?.archivedAt, snapshot[0].archivedAt,
    'the reload left the row archived in the shared list');
  guard.end(['x']); // requestArchiveChat's finally clears the TTL exactly here.
  h.sync.onChatsChanged({ reason: 'archive', chatId: 'x' }); // trailing echo, after end().
  await h.flush();
  assert.equal(h.getChatsCalls(), 1, 'trailing archive echo after end() stays one GET (max 1)');
  // An independent restore of the same id (server restored, list still archived) MUST reload.
  h.sync.onChatsChanged({ reason: 'restore', chatId: 'x' });
  await h.flush();
  assert.equal(h.getChatsCalls(), 2, 'independent restore of the same id still reloads');
}

{
  // Settled group / multi: begin(ids) -> one reload -> end(ids), then one trailing echo per
  // id. Each id's state is already reflected, so the whole group stays a single GET.
  const chats = [{ id: 'g1', title: 'A' }, { id: 'g2', title: 'B' }];
  const snapshot = [
    { id: 'g1', title: 'A', archivedAt: '2026-10-05T00:00:00.000Z' },
    { id: 'g2', title: 'B', archivedAt: '2026-10-05T00:00:00.000Z' },
  ];
  const guard = createChatListExplicitReloadGuard({ isChatStateAlreadyApplied: statePredicate(chats) });
  const h = makeReloadHarness(chats, snapshot, guard);
  guard.begin(['g1', 'g2']);
  await h.controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  guard.end(['g1', 'g2']);
  h.sync.onChatsChanged({ reason: 'archive', chatId: 'g1' });
  h.sync.onChatsChanged({ reason: 'archive', chatId: 'g2' });
  await h.flush();
  assert.equal(h.getChatsCalls(), 1, 'group trailing echoes stay one GET');
  // Only one child was independently restored -> exactly that frame reloads, not the other.
  h.sync.onChatsChanged({ reason: 'restore', chatId: 'g1' });
  h.sync.onChatsChanged({ reason: 'archive', chatId: 'g2' });
  await h.flush();
  assert.equal(h.getChatsCalls(), 2, 'one independent same-id change still reloads once');
}

console.log('chat-list-explicit-reload.test.js OK');
