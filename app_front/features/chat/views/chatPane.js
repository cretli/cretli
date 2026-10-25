/**
 * Mount the chat pane for a chat (send bar, rich view, connection) and start its history hydration.
 */
import { chatHost } from '../services/chatHost.js';
import { mountChatMobileOverscrollActions } from './chatMobileActions.js';
import { createChatSendHandlers } from '../services/chatSendHandlers.js';
import { buildChatRichViewOptions } from '../services/chatRichViewOptions.js';
import { hydrateOpenedChat } from '../services/chatOpenHydration.js';
import { setChatStatus } from '../../connection/connectionStatus.js';
import * as api from '../../../core/api/index.js';
import { getHostPagePickLabel } from '../../../embed/widgetHostPagePick.js';
import { t } from '../../../i18n/index.js';
import { createSdkRichView } from '../../../lib/sdk-rich-view.js';
import { createSendBar } from '../../sendBar/index.js';
import { clearPushPreview } from '../../pwa/pushInbox.js';
import { createSendBarTodoChip } from '../../sendBar/sendBarTodoChip.js';
import { resetViewAppliedState } from '../chatHistoryConvergence.js';
import { getChatSendBarResizeObserver, scheduleChatSendBarReserveSync } from '../chatSendBarLayout.js';
import { isChatDiagEnabled } from '../chatSettingsPrefs.js';
import { isBlockingPersistedLocalChatHarnessState } from '../persistedLocalChatState.js';
import { beginSdkOpenTerminalHydration } from '../sdkEventReplayGuard.js';
import { syncChatTodoChip } from '../services/chatComposer.js';
import { syncArchivedChatSendUi } from '../services/chatDeleteArchive.js';
import {
  isChatPaneMounted,
  isPersistedLocalChatBlockedNoticeMounted,
  isPersistedLocalChatBlockedPaneMounted,
  removeMountedPersistedLocalChatBlockedPane,
  renderPersistedLocalChatBlockedPane,
  replaceMountedPersistedLocalChatBlockedPane,
  scheduleOpenTerminalWhenReady,
} from '../services/chatLifecycle.js';
import { checkChatResumeAdvice, createChatFromSendAction } from '../services/chatResumeAdvice.js';
import { bindChatToSharedSdkModeBar } from '../services/chatSdkMode.js';
import { selectChat } from '../services/chatSelection.js';
import { renderChatTerminalState, updateAwaitingInput } from '../services/chatSidebarState.js';
import {
  resolveSendBarHostPagePick,
  resolveSendBarHostScreenshotCapture,
} from '../services/widgetHostCapture.js';
import { chatRuntime } from '../state/chatRuntimeState.js';

export function openTerminal(chat) {
  // Opening the chat supersedes any transient push-inbox preview.
  clearPushPreview(chat);
  if (isChatPaneMounted(chat)) {
    if (isBlockingPersistedLocalChatHarnessState(chat)) {
      // The plugin state can turn blocking after the SDK pane was already mounted (list
      // refresh): swap the live runtime for the blocked notice instead of returning as-is.
      if (!isPersistedLocalChatBlockedPaneMounted(chat)) {
        replaceMountedPersistedLocalChatBlockedPane(chat);
      }
      return;
    }
    // The blocking state can also clear (blocked -> not_loaded / missing / restored).
    // Only a mounted notice is stale here; a mounted regular pane keeps its fast-path return.
    if (!isPersistedLocalChatBlockedNoticeMounted(chat)) return;
    removeMountedPersistedLocalChatBlockedPane(chat);
  }
  if (chat.pane && !chat.pane.isConnected) {
    try {
      chat._sdkRichView?.destroy?.();
    } catch {
      // Detached pane — rebuild a fresh one with a send bar.
    }
    resetViewAppliedState(chat.id, chat);
    chat.pane = null;
    chat._sdkRichView = null;
    chat.term = null;
    chat.fitAddon = null;
  }
  if (!document.getElementById('chat-tabs')) {
    scheduleOpenTerminalWhenReady(chat);
    return;
  }
  if (isBlockingPersistedLocalChatHarnessState(chat)) {
    renderPersistedLocalChatBlockedPane(chat);
    return;
  }
  const pane = document.createElement('div');
  pane.className = 'chat-tab-pane';
  pane.dataset.chatId = chat.id;
  const launchDiv = document.createElement('div');
  launchDiv.className = 'chat-launch-command';
  launchDiv.setAttribute('aria-hidden', 'true');
  launchDiv.style.display = 'none';
  pane.appendChild(launchDiv);
  chat.launchCommandEl = launchDiv;
  if (!chat.sdkMode) chat.sdkMode = 'agent';
  bindChatToSharedSdkModeBar(chat);
  pane.appendChild(chatRuntime.chatDiagnosticsApi.createChatDiagPanel(chat));
  if (chat.delegationParentChatId) {
    const parentLink = document.createElement('button');
    parentLink.type = 'button';
    parentLink.className = 'chat-delegation-parent-link';
    parentLink.textContent = t('chat.delegationOpenParent');
    parentLink.addEventListener('click', () => {
      selectChat(chat.delegationParentChatId, { byUser: true });
    });
    pane.appendChild(parentLink);
  }
  if (isChatDiagEnabled()) chatRuntime.chatDiagnosticsApi.startChatDiagPolling(chat);
  const viewportWrap = document.createElement('div');
  viewportWrap.className = 'terminal-viewport-wrap';
  const container = document.createElement('div');
  viewportWrap.appendChild(container);
  mountChatMobileOverscrollActions({ chat, pane, container, viewportWrap });
  pane.appendChild(viewportWrap);
  const { chatOnSend } = createChatSendHandlers(chat);

  const sendBar = createSendBar({
    placeholder: t('chat.commandPlaceholder'),
    showToggleExtra: true,
    getExtraBarWrap: () => document.getElementById('chat-extra-bar-wrap'),
    showArrows: false,
    // Stop lives in chat settings (next to Delete chat), not on the send bar.
    showStop: false,
    showExtraBarStop: false,
    onSend: chatOnSend,
    onContextLayoutChange: () => scheduleChatSendBarReserveSync(),
    onArrowUp: () => {},
    onArrowDown: () => {},
    showScreenshotButton: true,
    showVoiceReadButton: true,
    uploadScreenshot: api.uploadScreenshot,
    captureHostScreenshot: resolveSendBarHostScreenshotCapture(),
    getCaptureHostScreenshot: resolveSendBarHostScreenshotCapture,
    requestHostPagePick: resolveSendBarHostPagePick(),
    getRequestHostPagePick: resolveSendBarHostPagePick,
    getHostPagePickLabel,
    sendActions: [
      {
        id: 'fork-chat',
        label: t('sendBar.forkChatWithMessage'),
        icon: 'mdi-source-fork',
        onSelect: (message) => createChatFromSendAction(chat, message, true),
      },
      {
        id: 'new-chat',
        label: t('sendBar.newChatWithMessage'),
        icon: 'mdi-message-plus-outline',
        onSelect: (message) => createChatFromSendAction(chat, message, false),
      },
    ],
  });
  pane._sendBar = sendBar;
  const resumeAdviceHost = document.createElement('div');
  resumeAdviceHost.className = 'chat-resume-advice-host';
  resumeAdviceHost.hidden = true;
  chat._resumeAdviceHost = resumeAdviceHost;
  pane.appendChild(sendBar.root);
  // First idle focus of the composer; the throttle in checkChatResumeAdvice avoids repeats.
  pane.addEventListener('focusin', (event) => {
    if (event.target instanceof Element && event.target.classList.contains('send-keys-input')) {
      void checkChatResumeAdvice(chat);
    }
  });
  if (sendBar.todoChipHost instanceof HTMLElement) {
    chat._todoChip = createSendBarTodoChip({
      host: sendBar.todoChipHost,
      onOpen: (todoId) => {
        void import('../../todo/index.js').then((mod) => mod.openTodo(todoId));
      },
      onLayoutChange: () => sendBar.syncContextStack?.(),
    });
    syncChatTodoChip(chat);
  }
  if (getChatSendBarResizeObserver() && sendBar.root instanceof HTMLElement) {
    getChatSendBarResizeObserver().observe(sendBar.root);
  }
  scheduleChatSendBarReserveSync();
  const restoredDraft = chatHost.readChatDraft(chat.id);
  if (restoredDraft) {
    const inputEl = sendBar.input;
    if (inputEl) inputEl.value = restoredDraft;
  }
  pane.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.classList.contains('send-keys-input')) return;
    chatHost.writeChatDraft(chat.id, target.value || '');
  });
  chat._stopDictationOnSend = sendBar.stopDictation;
  chat._startDictation = sendBar.startDictation;

  const chatTabs = document.getElementById('chat-tabs');
  if (!chatTabs) {
    scheduleOpenTerminalWhenReady(chat);
    return;
  }
  chatTabs.appendChild(pane);
  if (chat.id === chatRuntime.activeChatId) pane.classList.add('active');

  function scrollChatPaneIntoView() {
    const scrollIntoView = () => {
      viewportWrap.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };
    if (typeof window !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent)) {
      setTimeout(scrollIntoView, 150);
    } else {
      scrollIntoView();
    }
  }
  pane.addEventListener('focusin', scrollChatPaneIntoView);

  chat._connectionStatus = 'connecting';
  if (chat.id === chatRuntime.activeChatId) setChatStatus('connecting');
  chat.pane = pane;
  syncArchivedChatSendUi(chat);

  chat._sdkRichView = createSdkRichView(chat, container, buildChatRichViewOptions(chat));
  // Keep advice outside the replayed stream, inside the scrollable conversation.
  container.appendChild(resumeAdviceHost);
  chat.term = null;
  chat.fitAddon = null;
  chat._termContainer = container;
  chat._sdkOpenedAt = Date.now();
  beginSdkOpenTerminalHydration(chat);
  chatHost.ensureChatConnection(chat);
  updateAwaitingInput(chat);
  renderChatTerminalState(chat);
  void hydrateOpenedChat(chat);
}
