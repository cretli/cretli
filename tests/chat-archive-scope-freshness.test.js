/**
 * Scoped archive workspace list-load freshness (cross-workspace must not share TTL).
 *
 * Run: node tests/chat-archive-scope-freshness.test.js
 */
import assert from 'node:assert/strict';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { __resetChatBootListHydrationControllerForTest } from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';
import {
  buildChatListLoadScopeKey,
  decideChatListNetworkLoad,
  normalizeChatListLoadQuery,
  trimPendingChatListLoadQuery,
} from '../app_front/features/chat/chatListLoadFreshness.js';

const WS_A = '/home/user/ws-a';
const WS_B = '/home/user/ws-b';

{
  const keyA = buildChatListLoadScopeKey(normalizeChatListLoadQuery({
    includeArchived: true,
    archiveWorkspace: WS_A,
  }));
  const keyB = buildChatListLoadScopeKey(normalizeChatListLoadQuery({
    includeArchived: true,
    archiveWorkspace: `${WS_B}\\`,
  }));
  assert.equal(keyA, 'full:/home/user/ws-a');
  assert.equal(keyB, 'full:/home/user/ws-b');
  assert.notEqual(keyA, keyB);
  assert.equal(
    buildChatListLoadScopeKey(normalizeChatListLoadQuery({ includeArchived: true })),
    'full',
  );
}

{
  const snapshot = {
    scopeKey: buildChatListLoadScopeKey(normalizeChatListLoadQuery({
      includeArchived: true,
      archiveWorkspace: WS_A,
    })),
    completedAtMs: 10_000,
    sessionId: 's1',
    generation: 1,
    listRevisionAtComplete: 0,
  };
  const needB = normalizeChatListLoadQuery({ includeArchived: true, archiveWorkspace: WS_B });
  const decisionB = decideChatListNetworkLoad({
    nowMs: 10_000 + 1000,
    normalized: needB,
    hasInFlight: false,
    inFlightScopeKey: null,
    lastSuccess: snapshot,
    session: { sessionId: 's1', generation: 1 },
    listRevision: 0,
  });
  assert.equal(decisionB, 'fetch', 'workspace B must fetch after A within TTL');

  const decisionSame = decideChatListNetworkLoad({
    nowMs: 10_000 + 1000,
    normalized: normalizeChatListLoadQuery({ includeArchived: true, archiveWorkspace: WS_A }),
    hasInFlight: false,
    inFlightScopeKey: null,
    lastSuccess: snapshot,
    session: { sessionId: 's1', generation: 1 },
    listRevision: 0,
  });
  assert.equal(decisionSame, 'skip-fresh', 'same workspace repeat stays skip-fresh');

  const joinB = decideChatListNetworkLoad({
    nowMs: 10_000,
    normalized: needB,
    hasInFlight: true,
    inFlightScopeKey: snapshot.scopeKey,
    lastSuccess: null,
    session: { sessionId: 's1', generation: 1 },
    listRevision: 0,
  });
  assert.equal(joinB, 'fetch', 'B must not join A in-flight');

  assert.ok(
    trimPendingChatListLoadQuery(snapshot.scopeKey, { includeArchived: true, archiveWorkspace: WS_B }),
    'pending B must not be trimmed by completed A',
  );
  assert.equal(
    trimPendingChatListLoadQuery(snapshot.scopeKey, { includeArchived: true, archiveWorkspace: WS_A }),
    null,
  );
}

function makeController(getChatsApi) {
  const chats = [];
  return {
    chats,
    controller: createChatController({
      api: { getChats: getChatsApi },
      CHAT_BUFFER_MAX: 100,
      LAST_CHAT_ID_KEY: 'last',
      getChats: () => chats,
      getActiveChatId: () => '',
      setActiveChatId: () => {},
      getWorkspaces: () => [],
      setWorkspaces: () => {},
      getSelectedWorkspaceFile: () => '',
      setSelectedWorkspaceFolder: () => {},
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
      getBootActivitySession: () => ({ sessionId: 's1', generation: 1 }),
      onArchiveCatalogHydrate: async () => {},
      invalidateArchiveCatalog: () => {},
    }),
  };
}

__resetChatBootListHydrationControllerForTest();

{
  let getChatsCalls = 0;
  const now = { t: 20_000 };
  const originalDateNow = Date.now;
  Date.now = () => now.t;
  try {
    const { controller } = makeController((query) => {
      getChatsCalls += 1;
      const ws = query?.archiveWorkspace || '';
      if (ws.includes('ws-a')) {
        return Promise.resolve({
          ok: true,
          fullIndex: false,
          chats: [
            { id: 'live-1', title: 'Live', workspaceFile: WS_A },
            { id: 'arch-a1', title: 'A1', archivedAt: '2026-01-01', workspaceFile: WS_A },
          ],
        });
      }
      return Promise.resolve({
        ok: true,
        fullIndex: false,
        chats: [
          { id: 'live-1', title: 'Live', workspaceFile: WS_A },
          { id: 'arch-b1', title: 'B1', archivedAt: '2026-01-02', workspaceFile: WS_B },
        ],
      });
    });
    await controller.loadChatsFromServer({
      includeArchived: true,
      archiveWorkspace: WS_A,
      skipAutoSelect: true,
    });
    assert.equal(getChatsCalls, 1);
    await controller.loadChatsFromServer({
      includeArchived: true,
      archiveWorkspace: WS_B,
      skipAutoSelect: true,
    });
    assert.equal(getChatsCalls, 2, 'controller must GET again for workspace B within TTL');
    await controller.loadChatsFromServer({
      includeArchived: true,
      archiveWorkspace: WS_A,
      skipAutoSelect: true,
    });
    assert.equal(getChatsCalls, 3, 'workspace A fetch again after B replaced freshness scope');
    getChatsCalls = 0;
    await controller.loadChatsFromServer({
      includeArchived: true,
      archiveWorkspace: WS_A,
      skipAutoSelect: true,
    });
    assert.equal(getChatsCalls, 0, 'immediate repeat for same workspace skips GET');
  } finally {
    Date.now = originalDateNow;
  }
}

console.log('chat-archive-scope-freshness.test.js OK');
