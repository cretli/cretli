/**
 * Window-level listeners of the chat panel (history flush, send bar layout, widget pin).
 */
import {
  getChatSendBarResizeObserver,
  scheduleChatSendBarReserveSync,
  setChatSendBarResizeObserver,
} from '../chatSendBarLayout.js';
import { renderChatTerminalState } from '../services/chatSidebarState.js';
import { syncWidgetPinUrlUi } from '../services/chatWidgetPin.js';
import { flushSdkStructuredHistoryNow } from '../services/sdkHistoryQueue.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';

/** Register the window/viewport listeners. */
export function bindChatPanelWindowEvents() {
  if (typeof window !== 'undefined') {
    // The status label is passed into the mode bar as a plain string, so it has
    // to be recomputed when the language changes.
    window.addEventListener('cr-lang-changed', () => {
      const chat = chats.find((c) => c.id === chatRuntime.activeChatId);
      if (chat) renderChatTerminalState(chat);
    });
    const flushAllSdkStructuredHistory = () => {
      for (const c of chats) {
        if (c.id) flushSdkStructuredHistoryNow(c);
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      flushAllSdkStructuredHistory();
    });
    window.addEventListener('pagehide', flushAllSdkStructuredHistory);
    window.addEventListener('beforeunload', flushAllSdkStructuredHistory);
    window.addEventListener('resize', scheduleChatSendBarReserveSync);
    window.addEventListener('orientationchange', scheduleChatSendBarReserveSync);
    window.addEventListener('cr-keyboard-offset-change', scheduleChatSendBarReserveSync);
    window.addEventListener('cr-widget-connected', () => {
      syncWidgetPinUrlUi(chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleChatSendBarReserveSync);
      window.visualViewport.addEventListener('scroll', scheduleChatSendBarReserveSync);
    }
    if (typeof ResizeObserver !== 'undefined' && !getChatSendBarResizeObserver()) {
      setChatSendBarResizeObserver(new ResizeObserver(() => {
        scheduleChatSendBarReserveSync();
      }));
    }
    if (getChatSendBarResizeObserver()) {
      document.querySelectorAll('#chat-panel .chat-pane-toolbar.chat-send-bar').forEach((el) => {
        if (el instanceof HTMLElement) getChatSendBarResizeObserver().observe(el);
      });
    }
  }
}
