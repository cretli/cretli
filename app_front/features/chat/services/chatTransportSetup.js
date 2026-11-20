/**
 * Wiring of the chat transport to the app-level chat services.
 */
import {
  buildCatchUpSignature,
  drainCatchUpOutputChunks,
  enqueueCatchUpOutputChunk,
} from '../../../../lib/catchup-flow.js';
import {
  CHAT_PING_INTERVAL_MS,
  CHAT_RECONNECT_DELAYS,
  CHAT_RECONNECT_MAX,
  CHAT_RESIZE_SEND_DEBOUNCE_MS,
  WS_PATH_AGENT_SDK,
} from '../../../config.js';
import { setChatStatus } from '../../connection/connectionStatus.js';
import { appLogger } from '../../../core/logging/logger.js';
import { getNotificationStore } from '../../notifications/notificationStore.js';
import { applyRemoteSidebarLayout } from '../../sidebar/sidebarLayoutSync.js';
import { handleChatConnectionLost } from '../chatServerRecovery.js';
import {
  getMaintainSessionsEnabled,
  getSdkVerboseLogsEnabled,
  getSkipCatchUpOnResume,
} from '../chatSettingsPrefs.js';
import { createChatTransport } from '../chatTransport.js';
import { createPresenceFrameCoalescer } from '../presenceFrameCoalescer.js';
import { chatRuntime, chats, removedChatIds } from '../state/chatRuntimeState.js';
import { chatShell } from '../state/chatShellState.js';
import { onChatSdkRunFinished, resetChatSdkContext } from './chatContextCompression.js';
import { applyAgentPresenceFrames, syncSdkHistoryOnResume } from './chatHistorySync.js';
import { closeChat, scrollChatTerminalToBottom } from './chatLifecycle.js';
import { onChatSdkModeChange, syncChatSdkModeUi } from './chatSdkMode.js';
import {
  renderChatTerminalState,
  scheduleChatListStateRefresh,
  setAgentState,
  updateAwaitingInput,
} from './chatSidebarState.js';
import { processAgentOutput, processAgentOutputCatchUp, writeCatchUpToTerminal } from './chatTitlesOutput.js';
import {
  appendSdkQueuedPromptLine,
  appendSdkUserPromptLine,
  consumeOptimisticSdkPrompt,
  consumeOptimisticSdkQueuedPrompt,
  flushSdkStructuredHistoryNow,
  promoteSdkQueuedPromptLine,
  removeSdkQueuedPromptLine,
} from './sdkHistoryQueue.js';

/**
 * Create the app-wide chat transport with its presence frame coalescer.
 * @param {{ getChatActivityAt: Function, getResizeColsRows: Function, setLaunchCommand: Function }} deps
 */
export function createAppChatTransport({ getChatActivityAt, getResizeColsRows, setLaunchCommand }) {
  const agentPresenceCoalescer = createPresenceFrameCoalescer({ onFlush: applyAgentPresenceFrames });
  return createChatTransport({
    WS_PATH_AGENT_SDK,
    CHAT_RECONNECT_MAX,
    CHAT_RECONNECT_DELAYS,
    CHAT_PING_INTERVAL_MS,
    CHAT_RESIZE_SEND_DEBOUNCE_MS,
    getChats: () => chats,
    getActiveChatId: () => chatRuntime.activeChatId,
    getMaintainSessionsEnabled,
    getChatActivityAt,
    getSkipCatchUpOnResume,
    appLogger,
    setChatStatus,
    setAgentState,
    renderChatTerminalState,
    buildCatchUpSignature,
    enqueueCatchUpOutputChunk,
    drainCatchUpOutputChunks,
    getResizeColsRows,
    processAgentOutput,
    processAgentOutputCatchUp,
    writeCatchUpToTerminal,
    updateAwaitingInput,
    onBackgroundSyncComplete: (ids) => scheduleChatListStateRefresh(ids),
    flushSdkStructuredHistoryNow,
    setLaunchCommand,
    scrollChatTerminalToBottom,
    appendSdkQueuedPromptLine,
    promoteSdkQueuedPromptLine,
    removeSdkQueuedPromptLine,
    appendSdkUserPromptLine,
    consumeOptimisticSdkPrompt,
    consumeOptimisticSdkQueuedPrompt,
    getSdkVerboseLogsEnabled,
    onSdkModeChange: onChatSdkModeChange,
    onSdkRunFinished: onChatSdkRunFinished,
    onSdkResume: syncSdkHistoryOnResume,
    onSdkModelChange: (chat) => syncChatSdkModeUi(chat),
    onSdkInvalidSession: (chat) => resetChatSdkContext(chat, null),
    onChatGone: (chat) => {
      if (!chat?.id) return;
      if (chat._sdkContextResetPending || chat._sdkContextFreshSession) return;
      removedChatIds.add(chat.id);
      closeChat(chat.id, { skipApiDelete: true });
    },
    onConnectionLost: handleChatConnectionLost,
    onChatsChanged: (msg) => {
      chatShell.chatListLiveSyncApi?.onChatsChanged(msg);
    },
    onSidebarLayout: (msg) => {
      applyRemoteSidebarLayout(msg);
    },
    onAgentPresence: (msg) => {
      agentPresenceCoalescer.push(msg);
    },
    onNotificationsChanged: (msg) => {
      // The notification store is created by initNotificationCenter (App boot); a
      // frame before that resolves is simply dropped and the store's first GET
      // catches up.
      void getNotificationStore()?.handleChangedFrame(msg);
    },
  });
}
