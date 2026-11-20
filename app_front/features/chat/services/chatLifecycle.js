/** Chat pane mounting, teardown, close and active-chat accessors. */
import { chatRuntime, chats, removedChatIds } from '../state/chatRuntimeState.js';
import { resetViewAppliedState } from '../chatHistoryConvergence.js';
import { resolveBlockingPersistedLocalChatStateCode, resolvePersistedLocalChatUnavailableMessage } from '../persistedLocalChatState.js';
import { t } from '../../../i18n/index.js';
import { setChatStatus } from '../../connection/connectionStatus.js';
import { forget as forgetPresenceChat } from '../agentPresenceStore.js';
import * as api from '../../../core/api/index.js';
import { removeStorageValueWithAlias } from '../../../lib/storageKeyAlias.js';
import { normalizeNewChatHarness } from './newChatHarnessState.js';
import { writeTextToClipboard } from '../../../lib/clipboard.js';
import { renderChatList, updateChatBarSelect } from './chatSidebarState.js';
import { findLastVisibleChatId } from './chatDeleteArchive.js';
import { selectChat } from './chatSelection.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

/** After new output, scroll the terminal to the bottom so the latest replies stay visible. */
export function scrollChatTerminalToBottom(term) {
  if (!term || typeof term.scrollToBottom !== 'function') return;
  requestAnimationFrame(() => {
    try {
      term.scrollToBottom();
    } catch (_) {}
  });
}

export const EMBED_BOOT_READY_EVENT = 'cr-embed-boot-ready';

export const EMBED_BOOT_READY_TIMEOUT_MS = 10_000;

export const OPEN_TERMINAL_RETRY_MS = 50;

export const OPEN_TERMINAL_MAX_ATTEMPTS = 80;

export function isEmbedBootDomReady() {
  if (typeof document === 'undefined') return true;
  if (!document.body?.classList.contains('embed-mode')) return true;
  return !!document.getElementById('chat-tabs');
}

/** Waits until embed SPA finished boot (chat-tabs in DOM). No-op outside embed mode. */
export function waitForEmbedBootReady() {
  if (isEmbedBootDomReady()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener(EMBED_BOOT_READY_EVENT, onReady);
      resolve();
    };
    const onReady = () => finish();
    window.addEventListener(EMBED_BOOT_READY_EVENT, onReady, { once: true });
    window.setTimeout(finish, EMBED_BOOT_READY_TIMEOUT_MS);
  });
}

export function scheduleOpenTerminalWhenReady(chat, attempt = 0) {
  if (!chat || isChatPaneMounted(chat)) return;
  if (isEmbedBootDomReady()) {
    chatHost.openTerminal(chat);
    return;
  }
  if (attempt >= OPEN_TERMINAL_MAX_ATTEMPTS) return;
  window.setTimeout(() => scheduleOpenTerminalWhenReady(chat, attempt + 1), OPEN_TERMINAL_RETRY_MS);
}

export function isChatPaneMounted(chat) {
  return !!(chat?.pane && chat.pane.isConnected);
}

/**
 * Drop a chat's rich view and pane. The chat row stays; the next open rebuilds the pane.
 *
 * @param {object} chat
 */
export function unmountChatPane(chat) {
  if (!chat?.pane) return;
  chatRuntime.chatDiagnosticsApi?.stopChatDiagPolling?.(chat);
  chat.pane?._sendBar?.destroy?.();
  try {
    chat._sdkRichView?.destroy?.();
  } catch {
    // A partially mounted rich view may throw on destroy.
  }
  resetViewAppliedState(chat.id, chat);
  if (chat.term && typeof chat.term.dispose === 'function') chat.term.dispose();
  if (chat.pane.parentNode) chat.pane.remove();
  chat.pane = null;
  chat._sdkRichView = null;
  chat.term = null;
  chat.fitAddon = null;
  chat._termContainer = null;
  chat.sdkModeBarEl = null;
}

/**
 * Keep the active chat and the most recently opened ones mounted. Older panes leave the DOM.
 *
 * @param {string} nextActiveId
 */
export function retainMountedChatPanes(nextActiveId) {
  const nextId = String(nextActiveId || '').trim();
  if (!nextId) return;
  // Most recently opened first; the tail beyond the cap is unmounted.
  chatShell.recentChatPaneIds = [nextId, ...chatShell.recentChatPaneIds.filter((id) => id !== nextId)].slice(0, chatHost.RETAINED_CHAT_PANE_LIMIT);
  const keep = new Set(chatShell.recentChatPaneIds);
  for (const chat of chats) {
    if (!chat?.pane || keep.has(chat.id)) continue;
    unmountChatPane(chat);
  }
}

/**
 * Whether the mounted pane already shows the blocked notice for the chat's current code.
 * Re-rendering every select would needlessly replace an identical notice.
 *
 * @param {object} chat
 * @returns {boolean}
 */
export function isPersistedLocalChatBlockedPaneMounted(chat) {
  if (!isChatPaneMounted(chat)) return false;
  const code = resolveBlockingPersistedLocalChatStateCode(chat);
  if (!code) return false;
  return chat.pane.dataset?.persistedLocalStateCode === code;
}

/**
 * Whether the mounted pane is the minimal blocked notice for any code, regardless of the
 * chat's current harness state. This detects a stale notice once the persisted state has
 * turned non-blocking (e.g. `not_loaded`, a missing state, or restored availability): the
 * notice pane records its code in `dataset.persistedLocalStateCode`.
 *
 * @param {object} chat
 * @returns {boolean}
 */
export function isPersistedLocalChatBlockedNoticeMounted(chat) {
  if (!isChatPaneMounted(chat)) return false;
  const mountedCode = chat.pane.dataset?.persistedLocalStateCode;
  return typeof mountedCode === 'string' && mountedCode !== '';
}

/**
 * Drop the mounted blocked notice so `openTerminal` can run the ordinary pane construction.
 * The notice owns no rich view, send bar, shared mode bar, or socket, so only the DOM node
 * and the pane reference are released — the standard path then appends exactly one normal
 * pane (no duplicate pane).
 *
 * @param {object} chat
 */
export function removeMountedPersistedLocalChatBlockedPane(chat) {
  if (!isPersistedLocalChatBlockedNoticeMounted(chat)) return;
  chat.pane.remove();
  chat.pane = null;
  chat.sdkModeBarEl = null;
}

/**
 * Replace a live SDK pane with the blocked notice when a persisted local chat's plugin
 * turns missing/disabled/not-chat-capable/host-incompatible at runtime. Tears down the
 * rich view, send bar, shared mode-bar binding, diagnostics polling, history timers, and
 * socket first, then renders exactly one blocked pane in place of the removed one.
 *
 * @param {object} chat
 */
export function replaceMountedPersistedLocalChatBlockedPane(chat) {
  if (!chat) return;
  if (chat._sdkHistoryFlushTimer) {
    clearTimeout(chat._sdkHistoryFlushTimer);
    chat._sdkHistoryFlushTimer = null;
  }
  chat._sdkHistoryPending = [];
  if (chat._reconnectTimer) {
    clearTimeout(chat._reconnectTimer);
    chat._reconnectTimer = null;
  }
  chatRuntime.chatDiagnosticsApi?.stopChatDiagPolling?.(chat);
  chat.pane?._sendBar?.destroy?.();
  try {
    chat._sdkRichView?.destroy?.();
  } catch {
    // A partially mounted rich view may throw on destroy — the pane is dropped anyway.
  }
  resetViewAppliedState(chat.id, chat);
  if (chat.term && typeof chat.term.dispose === 'function') chat.term.dispose();
  chat._termContainer = null;
  chat.sdkModeBarEl = null;
  // Delegate the socket teardown to the transport helper: it detaches every callback
  // exactly once before close and releases the connect slot. Never null `chat.ws` here
  // (a bare close would leave live listeners and a held slot).
  chatHost.chatTransport.teardownBlockedChatRuntime(chat);
  if (chat.pane && chat.pane.parentNode) chat.pane.remove();
  chat.pane = null;
  chat._sdkRichView = null;
  chat.term = null;
  chat.fitAddon = null;
  renderPersistedLocalChatBlockedPane(chat);
}

/**
 * Minimal pane for a persisted local chat whose plugin is unavailable, disabled,
 * not chat-capable, or host-incompatible. It deliberately skips the SDK rich view,
 * send bar, shared mode bar, history fetch, and WebSocket: the chat stays visible with
 * a localized reason until the plugin state changes. `chat.agentTransport` is never
 * rewritten, so the sidebar and diagnostics keep showing the raw plugin id.
 *
 * @param {object} chat
 */
export function renderPersistedLocalChatBlockedPane(chat) {
  const chatTabs = document.getElementById('chat-tabs');
  if (!chatTabs) return;
  const pane = document.createElement('div');
  pane.className = 'chat-tab-pane';
  pane.dataset.chatId = chat.id;
  pane.dataset.persistedLocalStateCode = resolveBlockingPersistedLocalChatStateCode(chat);
  const notice = document.createElement('div');
  notice.className = 'chat-terminal-statebar chat-terminal-statebar--disconnected';
  notice.setAttribute('role', 'note');
  notice.textContent = resolvePersistedLocalChatUnavailableMessage(chat, t);
  pane.appendChild(notice);
  chatTabs.appendChild(pane);
  if (chat.id === chatRuntime.activeChatId) pane.classList.add('active');
  chat.pane = pane;
  chat._sdkRichView = null;
  chat.sdkModeBarEl = null;
  chat.term = null;
  chat.fitAddon = null;
  chat._connectionStatus = 'disconnected';
  if (chat.id === chatRuntime.activeChatId) setChatStatus('disconnected');
}

/**
 * Tear down live pane/socket state for a chat row without removing it from the list or API.
 *
 * @param {object | null | undefined} chat
 */
export function teardownChatRuntime(chat) {
  if (!chat || typeof chat !== 'object') return;
  if (chat._sdkHistoryFlushTimer) {
    clearTimeout(chat._sdkHistoryFlushTimer);
    chat._sdkHistoryFlushTimer = null;
  }
  chat._sdkHistoryPending = [];
  if (chat._recentOutputExpireTimer) {
    clearTimeout(chat._recentOutputExpireTimer);
    chat._recentOutputExpireTimer = null;
  }
  if (chat._reconnectTimer) {
    clearTimeout(chat._reconnectTimer);
    chat._reconnectTimer = null;
  }
  chatHost.chatTransport.teardownBlockedChatRuntime(chat);
  if (chat._sdkRichView && typeof chat._sdkRichView.destroy === 'function') {
    chat._sdkRichView.destroy();
    chat._sdkRichView = null;
  }
  resetViewAppliedState(chat.id, chat);
  chatRuntime.chatDiagnosticsApi.stopChatDiagPolling(chat);
  if (chat.term && typeof chat.term.dispose === 'function') chat.term.dispose();
  chat.term = null;
  chat._termContainer = null;
  chat.pane?._sendBar?.destroy?.();
  if (chat.pane && chat.pane.parentNode) chat.pane.remove();
  chat.pane = null;
}

/**
 * Full chat delete: close the connection, UI, clear localStorage, remove on the backend.
 * @param {string} id - chat id (uuid)
 * @param {{ skipApiDelete?: boolean, switchToChatId?: string|null, keepRow?: boolean, render?: boolean }} [options]
 *   `keepRow` closes runtime/presence/local data but leaves the list row in place (archive);
 *   `render:false` defers the repaint to a batched caller.
 */
export function closeChat(id, options = {}) {
  const keepRow = options.keepRow === true;
  const shouldRender = options.render !== false;
  const idx = chats.findIndex((c) => c.id === id);
  const chat = idx === -1 ? null : chats[idx];
  const switchToChatId =
    typeof options.switchToChatId === 'string' && options.switchToChatId.trim()
      ? options.switchToChatId.trim()
      : null;
  // The presence store outlives the chat object, so a deleted id must not hydrate a future
  // row that happens to reuse it.
  forgetPresenceChat(id);
  if (!chat) {
    if (!options.skipApiDelete && !keepRow) {
      removedChatIds.add(id);
      api.deleteChat(id).catch(() => {});
    }
    if (chatRuntime.activeChatId === id) {
      const fallbackId =
        switchToChatId && chats.some((c) => c.id === switchToChatId && !c.archivedAt)
          ? switchToChatId
          : findLastVisibleChatId(id);
      chatRuntime.activeChatId = fallbackId;
      if (chatRuntime.activeChatId) selectChat(chatRuntime.activeChatId);
    }
    if (shouldRender) renderChatList();
    return;
  }
  teardownChatRuntime(chat);
  if (!keepRow) chats.splice(idx, 1);
  chatHost.clearChatLocalData(id);
  if (!options.skipApiDelete && !keepRow) {
    removedChatIds.add(id);
    api.deleteChat(id).catch(() => {});
  }
  if (chatRuntime.activeChatId === id) {
    const fallbackId =
      switchToChatId && chats.some((c) => c.id === switchToChatId && !c.archivedAt)
        ? switchToChatId
        : findLastVisibleChatId(id);
    chatRuntime.activeChatId = fallbackId;
    if (chatRuntime.activeChatId) {
      selectChat(chatRuntime.activeChatId);
    } else {
      if (typeof localStorage !== 'undefined') removeStorageValueWithAlias(localStorage, chatHost.LAST_CHAT_ID_KEY);
      document.querySelectorAll('.chat-tab-pane').forEach((p) => p.classList.remove('active'));
    }
  }
  if (shouldRender) renderChatList();
}

/**
 * Return the Send field in the active chat pane (for quick commands).
 * When a send bar exists (e.g. multiline mode with a textarea above the bar), its input wins.
 * @returns {HTMLInputElement | HTMLTextAreaElement | null}
 */
export function getActiveSendInput() {
  const bar = getActiveSendBar();
  if (bar && bar.input) return bar.input;
  const pane = document.querySelector('.chat-tab-pane.active');
  return pane ? pane.querySelector('.send-keys-input') : null;
}

/**
 * Return the send bar of the active chat pane (for multiline mode).
 * @returns {{ setMultiline: (b: boolean) => void, isMultiline: () => boolean } | null}
 */
export function getActiveSendBar() {
  const pane = document.querySelector('.chat-tab-pane.active');
  return pane?._sendBar ?? null;
}

/**
 * Returns the terminal / transport state of the active chat (PTY, copying, special characters).
 * @returns {{ term: import('@xterm/xterm').Terminal | null, ws: WebSocket | null, agentTransport?: string }}
 */
export function getActiveChatTerminalState() {
  const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  if (!chat) return { term: null, ws: null };
  return {
    term: chat.term ?? null,
    ws: chat.ws || null,
    agentTransport: normalizeNewChatHarness(chat.agentTransport || 'sdk'),
  };
}

/**
 * Copies from the active chat: xterm (selection / buffer) or SDK mode (text from the buffer).
 * @returns {Promise<boolean>}
 */
export async function copyActiveChatToClipboard() {
  const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  if (!chat?._sdkRichView) return false;
  const text = chat._sdkRichView.getCopyText().trimEnd();
  if (!text) return false;
  return writeTextToClipboard(text);
}

export function getActiveChatBufferTail(limit = 4000) {
  const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  if (!chat || typeof chat._buffer !== 'string') return '';
  return chat._buffer.slice(-Math.max(1, Number(limit) || 4000));
}

/**
 * Pull only name/model changes from the backend and merge them into the local list.
 * Does not touch terminals/WS, so it also works for an inactive chat.
 */
export function syncChatTitlesFromServer() {
  if (chatShell.chatTitlesSyncInFlight) return;
  if (chatHost.chatController.isChatsListLoadInFlight()) return;
  if (typeof document !== 'undefined') {
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    const chatPanel = document.getElementById('chat-panel');
    if (!chatPanel?.classList.contains('active')) return;
  }
  if (chats.length === 0) return;
  chatShell.chatTitlesSyncInFlight = true;
  api.getChats().then((data) => {
    if (!data?.ok || !Array.isArray(data.chats)) return;
    const serverIds = new Set(data.chats.map((c) => c.id));
    let changed = false;
    for (const local of [...chats]) {
      if (!local.isTemporary || serverIds.has(local.id)) continue;
      closeChat(local.id, {
        skipApiDelete: true,
        switchToChatId: local.forkParentChatId || null,
      });
      changed = true;
    }
    for (const serverChat of data.chats) {
      const local = chats.find((c) => c.id === serverChat.id);
      if (!local) continue;
      const nextTitle = typeof serverChat.title === 'string' ? serverChat.title : local.title;
      const nextModel = typeof serverChat.model === 'string' ? serverChat.model : local.model;
      if ((local.title || '') !== (nextTitle || '')) {
        local.title = nextTitle;
        changed = true;
      }
      if ((local.model || 'auto') !== (nextModel || 'auto')) {
        local.model = nextModel || 'auto';
      }
    }
    if (!changed) return;
    renderChatList();
    updateChatBarSelect();
  }).catch((err) => {
    console.warn('[chat] title sync failed:', err?.message || err);
  }).finally(() => {
    chatShell.chatTitlesSyncInFlight = false;
  });
}
