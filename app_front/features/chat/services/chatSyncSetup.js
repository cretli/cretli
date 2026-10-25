/**
 * Chat list/history sync services started once at chat module load.
 */
import { isUiFreezeTraceActive } from '../../../lib/uiFreezeTrace.js';
import { appLogger } from '../../../core/logging/logger.js';
import { sharedState } from '../../../state/index.js';
import { initPushInboxResumeConsumer } from '../../pwa/pushInbox.js';
import { getUiFreezeMetrics } from '../../sidebar/sidebarRenderMetrics.js';
import { isSidebarArchiveSectionOpen } from '../../sidebar/sidebarVisibleChats.js';
import { initChatHistorySyncPoll } from '../chatHistorySyncPoll.js';
import { createChatListLiveSync } from '../chatListLiveSync.js';
import { initChatListResumeSync } from '../chatListResumeSync.js';
import { getChatBootListHydrationController } from '../chatLocalBootAsyncHydrate.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { chatShell } from '../state/chatShellState.js';
import { handleServerTitleChanged } from '../views/chatSettingsModal.js';
import {
  chatListExplicitReloadGuard,
  consumePushInboxFromStore,
  syncSdkHistoryOnResume,
} from './chatHistorySync.js';
import { loadChatsFromServer, markChatSeenIfUnread } from './chatSelection.js';
import { scheduleChatListStateRefresh } from './chatSidebarState.js';

/**
 * Start the history poll, resume sync, push-inbox consumer and live list sync.
 * @param {{ chatView: any, getChatController: () => any }} deps
 */
export function initChatSyncServices({ chatView, getChatController }) {
  // The controller is created after this runs, so its methods are resolved on call.
  const chatController = {
    patchChatTitle: (...args) => getChatController().patchChatTitle(...args),
    patchChatReadState: (...args) => getChatController().patchChatReadState(...args),
  };
  initChatHistorySyncPoll({
    getChats: () => chats,
    getActiveChatId: () => chatRuntime.activeChatId,
    syncSdkHistoryOnResume,
    appLogger,
    getSdkRoomBusMode: () => chatShell.sdkRoomBusMode,
    hasOpenHarnessWs: () => chats.some((chat) => chat?.ws && chat.ws.readyState === 1),
    onPendingHistoryChange: (changedChats, meta) => {
      // Task 1.2: patch the open modal's pending badges in place. No renderChatList,
      // so a pending batch builds/writes no boot cache and refreshes no model labels,
      // and untouched rows keep their DOM identity. A closed modal is a no-op here.
      chatView.applyChatListPendingBadges(changedChats, meta);
    },
    onAgentStatesChange: (dirtyIds) => {
      scheduleChatListStateRefresh(dirtyIds);
    },
  });

  initChatListResumeSync({
    refresh: (query) => loadChatsFromServer(query),
  });

  initPushInboxResumeConsumer({ consume: consumePushInboxFromStore });

  chatShell.chatListLiveSyncApi = createChatListLiveSync({
    refresh: (query) => loadChatsFromServer(query),
    shouldIncludeArchived: () => isSidebarArchiveSectionOpen(),
    onTitleChanged: (chatId) => handleServerTitleChanged(chatId),
    // The title frame carries the new row content, so one chat is patched in place and the
    // list keeps its `GET /api/chats` for structural changes only.
    onTitlePatched: (chatId, title, titleSource) => (
      chatController.patchChatTitle(chatId, title, titleSource) === true
    ),
    // Read markers: one row is patched, then only its sidebar chip is repainted.
    onReadPatched: (chatId, lastFinishedAt, lastSeenAt) => {
      if (chatController.patchChatReadState(chatId, lastFinishedAt, lastSeenAt) !== true) return false;
      scheduleChatListStateRefresh([chatId]);
      if (chatId === chatRuntime.activeChatId) markChatSeenIfUnread(chatId);
      return true;
    },
    onWatcherChanged: () => {
      sharedState.bumpWatcher();
    },
    // Requirement 4b: chatsChanged frames/sec split by reason. Guarded here at the
    // callsite; the seam defaults to a no-op so chatListLiveSync stays DOM-free.
    onChatsChangedFrame: (msg) => {
      if (isUiFreezeTraceActive()) {
        getUiFreezeMetrics()?.recordChatsChangedFrame({ reason: msg?.reason });
      }
    },
    shouldSuppressChatsChanged: (frame) => chatListExplicitReloadGuard.shouldSuppressChatsChanged(frame),
    onBeforeListReload: () => getChatBootListHydrationController().bumpListRevision(),
  });
}
