/**
 * Additive runtime merge after scoped archive list load.
 *
 * Run: node tests/chat-list-scoped-archive-merge.test.js
 */
import assert from 'node:assert/strict';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { mergeRuntimeChatListAfterScopedArchiveLoad } from '../app_front/features/chat/chatListScopedArchiveMerge.js';
import { __resetChatBootListHydrationControllerForTest } from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';

const WS_A = '/proj/ws-a';
const WS_B = '/proj/ws-b';

{
  const existing = [
    { id: 'live-1', title: 'Live', workspaceFile: WS_A },
    { id: 'arch-a-old', title: 'A old', archivedAt: '2026-01-01', workspaceFile: WS_A },
    { id: 'arch-b-keep', title: 'B keep', archivedAt: '2026-01-02', workspaceFile: WS_B },
  ];
  const reconciled = [
    { id: 'live-1', title: 'Live', workspaceFile: WS_A },
    { id: 'arch-a-new', title: 'A new', archivedAt: '2026-01-03', workspaceFile: WS_A },
  ];
  const merged = mergeRuntimeChatListAfterScopedArchiveLoad(existing, reconciled, WS_A);
  const ids = merged.map((row) => row.id).sort();
  assert.deepEqual(ids, ['arch-a-new', 'arch-b-keep', 'live-1']);
  assert.ok(!ids.includes('arch-a-old'), 'same-workspace stale archive not retained');
}

__resetChatBootListHydrationControllerForTest();

{
  const chats = [
    { id: 'live-1', title: 'Live', workspaceFile: WS_A },
    { id: 'arch-a1', title: 'A1', archivedAt: '2026-01-01', workspaceFile: WS_A },
    { id: 'arch-b1', title: 'B1', archivedAt: '2026-01-02', workspaceFile: WS_B },
  ];
  const { chats: runtime, controller } = (() => {
    const rows = chats;
    return {
      chats: rows,
      controller: createChatController({
        api: {
          getChats: () => Promise.resolve({
            ok: true,
            fullIndex: false,
            chats: [
              { id: 'live-1', title: 'Live', workspaceFile: WS_A },
              { id: 'arch-b2', title: 'B2', archivedAt: '2026-01-04', workspaceFile: WS_B },
            ],
          }),
        },
        CHAT_BUFFER_MAX: 100,
        LAST_CHAT_ID_KEY: 'last',
        getChats: () => rows,
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
        getChatsForCurrentWorkspace: () => rows,
        setChatStatus: () => {},
        getBootActivitySession: () => ({ sessionId: 's1', generation: 1 }),
        onArchiveCatalogHydrate: async () => {},
        invalidateArchiveCatalog: () => {},
      }),
    };
  })();
  await controller.loadChatsFromServer({
    includeArchived: true,
    archiveWorkspace: WS_B,
    skipAutoSelect: true,
  });
  const ids = runtime.map((row) => row.id).sort();
  assert.ok(ids.includes('arch-a1'), 'workspace A archived rows stay after scoped B load');
  assert.ok(ids.includes('arch-b2'));
  assert.ok(!ids.includes('arch-b1'), 'B rows replaced by server window');
}

console.log('chat-list-scoped-archive-merge.test.js OK');
