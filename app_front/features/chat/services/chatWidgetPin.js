/** Widget host page pinning and page-linked chat creation. */
import { syncWidgetPinUrlUi as renderWidgetPinUrlUi, notifyWidgetParentPagePinChanged as postWidgetParentPagePinChanged, getChatWidgetPinnedUrl } from '../chatWidgetPin.js';
import { isEmbedWidgetMode, normalizeNewChatHarness } from './newChatHarnessState.js';
import { isWidgetHostNavigationAvailable, isSamePageUrl, markPendingWidgetChatSelection, requestWidgetHostUrl, navigateWidgetHost, clearPendingWidgetChatSelection, findChatPinnedToPageUrl } from '../../../embed/widgetHostNavigation.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import * as api from '../../../core/api/index.js';
import { normalizeSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../../../../lib/sdk/sdk-ui-mode.ts';
import { appLogger } from '../../../core/logging/logger.js';
import { t } from '../../../i18n/index.js';
import { normalizeModelValue } from '../chatSettingsPrefs.js';
import { getWorkspaceContextForChat } from './chatWorkspaceContext.js';
import { renderChatList } from './chatSidebarState.js';
import { setTransientChatActionHint } from './chatContextCompression.js';
import { getChatsList, notifySidebar } from './chatSidebarHooks.js';
import { loadChatsFromServer, setForcedEmbedChatId } from './chatSelection.js';
import { waitForEmbedBootReady } from './chatLifecycle.js';
import { adoptCreatedChat } from './chatCreation.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

/**
 * One WebSocket per chat: always collect output; write to the terminal only when chat.term exists.
 */
export function requestWidgetChatBinding(chat) {
  if (typeof window === 'undefined') return;
  if (!chat?.cursorSessionId) return;
  window.dispatchEvent(new CustomEvent('cr-widget-bind-chat-request', {
    detail: { chatSessionKey: chat.cursorSessionId },
  }));
}

export function syncWidgetPinUrlUi(chat = null) {
  renderWidgetPinUrlUi(isEmbedWidgetMode(), isWidgetHostNavigationAvailable, chat);
}

export function notifyWidgetParentPagePinChanged() {
  postWidgetParentPagePinChanged(isEmbedWidgetMode());
}

export async function createEmbedChatRecordOnly() {
  if (chatShell.embedChatCreationPromise) return chatShell.embedChatCreationPromise;
  const context = getWorkspaceContextForChat();
  if (!context?.workspaceFile || !context?.workspaceFolder) return null;
  const transport = normalizeNewChatHarness(chatRuntime.selectedHarness || 'sdk');

  chatShell.embedChatCreationPromise = api.postChat({
    workspaceFile: context.workspaceFile,
    workspaceFolder: context.workspaceFolder,
    model: window.__crEmbedModel || 'auto',
    agentTransport: transport,
    sdkMode: 'agent',
    sdkUiMode: 'compact',
  }).then((data) => {
    if (!data?.ok || !data.chat) return null;
    const chat = data.chat;
    chat.agentTransport = normalizeNewChatHarness(chat.agentTransport || transport);
    chat.sdkMode = normalizeSdkMode(chat.sdkMode);
    chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
    chats.push(chat);
    renderChatList();
    chatHost.openTerminal(chat);
    return chat;
  }).finally(() => {
    chatShell.embedChatCreationPromise = null;
  });
  return chatShell.embedChatCreationPromise;
}

/**
 * When the user picks a chat pinned to a URL other than the current host page,
 * navigate the host page to the pinned URL and select that chat after reload.
 * @param {string} requestedId
 * @returns {Promise<string|null>}
 */
export async function resolveChatSelectionForCurrentHostPage(requestedId) {
  const requestedChat = chats.find((c) => c.id === requestedId);
  if (!requestedChat) return null;

  const pinnedUrl = getChatWidgetPinnedUrl(requestedChat);
  if (!pinnedUrl) return requestedId;

  let currentUrl = '';
  try {
    const current = await requestWidgetHostUrl();
    currentUrl = typeof current?.url === 'string' ? current.url.trim() : '';
  } catch {
    return requestedId;
  }

  if (!currentUrl || isSamePageUrl(pinnedUrl, currentUrl)) {
    return requestedId;
  }

  markPendingWidgetChatSelection(requestedId);
  try {
    const result = await navigateWidgetHost(pinnedUrl);
    if (result?.skipped) {
      clearPendingWidgetChatSelection();
      return requestedId;
    }
    return null;
  } catch (error) {
    clearPendingWidgetChatSelection();
    throw error;
  }
}

export async function toggleWidgetUrlPin(chat, hintEl = null) {
  if (!chat) {
    setTransientChatActionHint(hintEl, t('chat.noActiveChat'));
    return;
  }
  if (!isEmbedWidgetMode() || !isWidgetHostNavigationAvailable()) {
    setTransientChatActionHint(hintEl, t('chat.pinUrlWidgetOnly'));
    return;
  }

  const currentPinnedUrl = typeof chat.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
  const nextPinnedUrl = currentPinnedUrl ? null : (await requestWidgetHostUrl()).url;
  if (!currentPinnedUrl && !nextPinnedUrl) {
    setTransientChatActionHint(hintEl, t('chat.pinUrlHostUrlFailed'));
    return;
  }

  appLogger.log('api-request', `PATCH /api/chats/${chat.id} (widgetPinnedUrl)`, {
    widgetPinnedUrl: nextPinnedUrl,
  });
  try {
    const data = await api.patchChat(chat.id, { widgetPinnedUrl: nextPinnedUrl });
    appLogger.log('api-response', `PATCH /api/chats/${chat.id} (widgetPinnedUrl)`, data);
    if (!data?.ok || !data.chat) {
      const err = typeof data?.error === 'string' && data.error.trim()
        ? data.error.trim()
        : t('chat.pinUrlSaveFailed');
      setTransientChatActionHint(hintEl, err);
      return;
    }
    Object.assign(chat, data.chat);
    if (nextPinnedUrl) {
      chats.forEach((item) => {
        if (item.id === chat.id) return;
        const pinnedUrl = getChatWidgetPinnedUrl(item);
        if (pinnedUrl && isSamePageUrl(pinnedUrl, nextPinnedUrl)) {
          delete item.widgetPinnedUrl;
        }
      });
    }
    syncWidgetPinUrlUi(chat);
    notifySidebar();
    renderChatList();
    notifyWidgetParentPagePinChanged();
    if (nextPinnedUrl) {
      setTransientChatActionHint(hintEl, t('chat.pinUrlPinned', { url: nextPinnedUrl }));
      return;
    }
    setTransientChatActionHint(hintEl, t('chat.pinUrlUnpinned'));
  } catch (error) {
    appLogger.log('api-error', `PATCH /api/chats/${chat.id} (widgetPinnedUrl)`, String(error));
    setTransientChatActionHint(hintEl, t('chat.pinUrlSaveFailed'));
  }
}

/**
 * Resolves the chat pinned to a host page URL (widget embed).
 * @param {string} pageUrl
 * @returns {Promise<{ id: string, title: string } | null>}
 */
export async function resolvePagePinStateForUrl(pageUrl) {
  const url = String(pageUrl || '').trim();
  if (!url) return null;
  const data = await api.getChats({ pinnedTo: url });
  if (data?.linkedChat?.id) {
    const title = typeof data.linkedChat.title === 'string' ? data.linkedChat.title.trim() : '';
    return { id: data.linkedChat.id, title };
  }
  await loadChatsFromServer();
  const linked = findChatPinnedToPageUrl(getChatsList(), url);
  if (!linked?.id) return null;
  const title = typeof linked.title === 'string' ? linked.title.trim() : '';
  return { id: linked.id, title };
}

/**
 * Creates a new chat pinned to the host page URL, or selects an existing one.
 * @param {{ pageUrl?: string, pageTitle?: string }} params
 * @returns {Promise<{ ok: boolean, chat?: object, reused?: boolean, error?: string }>}
 */
export async function createPageLinkedChat(params = {}) {
  const pageUrl = String(params.pageUrl || '').trim();
  if (!pageUrl) {
    appLogger.log('widget-plus', 'createPageLinkedChat: missing pageUrl');
    return { ok: false, error: t('chat.missingPageUrl') };
  }
  const pageTitle = String(params.pageTitle || '').trim() || t('chat.pageChatTitle');
  const harness = normalizeNewChatHarness(params.harness || chatRuntime.selectedHarness || 'sdk');
  const forceNew = params.forceNew === true;
  const workspaceFile = String(params.workspaceFile || '').trim();
  const workspaceFolder = String(params.workspaceFolder || '').trim();
  const rawModel = typeof params.model === 'string' ? params.model.trim() : '';
  const model = rawModel ? normalizeModelValue(rawModel) : '';
  const sdkMode = String(params.sdkMode || '').trim();
  const sdkUiMode = String(params.sdkUiMode || '').trim();
  appLogger.log('widget-plus', 'createPageLinkedChat start', { pageUrl, pageTitle });
  chatShell.pinnedChatSelectionGuard = true;
  try {
    await waitForEmbedBootReady();
    appLogger.log('widget-plus', 'embed boot ready');
    const lookup = forceNew ? null : await api.getChats({ pinnedTo: pageUrl });
    const existing = lookup?.linkedChat?.id
      ? lookup.linkedChat
      : findChatPinnedToPageUrl(getChatsList(), pageUrl);
    if (!forceNew && existing?.id) {
      appLogger.log('widget-plus', 'reusing existing pinned chat', {
        chatId: existing.id.slice(0, 8),
        pinnedUrl: getChatWidgetPinnedUrl(existing) || pageUrl,
      });
      await loadChatsFromServer({
        pinnedTo: pageUrl,
        skipAutoSelect: true,
        preferChatId: existing.id,
      });
      adoptCreatedChat(existing);
      notifyWidgetParentPagePinChanged();
      return { ok: true, chat: existing, reused: true };
    }
    appLogger.log('widget-plus', 'POST /api/chats', {
      title: pageTitle,
      widgetPinnedUrl: pageUrl,
      agentTransport: harness,
      forceNewPinnedChat: forceNew,
    });
    const payload = {
      title: pageTitle,
      widgetPinnedUrl: pageUrl,
      agentTransport: harness,
      forceNewPinnedChat: forceNew,
      ...(workspaceFile ? { workspaceFile } : {}),
      ...(workspaceFolder ? { workspaceFolder } : {}),
      ...(model ? { model } : {}),
      ...(sdkMode ? { sdkMode } : {}),
      ...(sdkUiMode ? { sdkUiMode } : {}),
    };
    const data = await api.postChat(payload);
    appLogger.log('widget-plus', 'POST /api/chats response', {
      ok: data?.ok === true,
      chatId: data?.chat?.id ? String(data.chat.id).slice(0, 8) : null,
      widgetPinnedUrl: data?.chat?.widgetPinnedUrl || null,
      error: data?.error || null,
    });
    if (!data?.ok || !data.chat?.id) {
      return { ok: false, error: data?.error || t('chat.createChatFailed') };
    }
    setForcedEmbedChatId(data.chat.id);
    await loadChatsFromServer({
      pinnedTo: pageUrl,
      skipAutoSelect: true,
      preferChatId: data.chat.id,
    });
    const createdChat = adoptCreatedChat(data.chat) || data.chat;
    syncWidgetPinUrlUi(createdChat);
    notifySidebar();
    renderChatList();
    notifyWidgetParentPagePinChanged();
    appLogger.log('widget-plus', 'created and selected', {
      chatId: data.chat.id.slice(0, 8),
      pinnedUrl: getChatWidgetPinnedUrl(createdChat) || pageUrl,
      hasPane: !!createdChat?.pane,
    });
    return { ok: true, chat: createdChat, reused: false };
  } catch (error) {
    appLogger.log('widget-plus', 'createPageLinkedChat error', String(error));
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    chatShell.pinnedChatSelectionGuard = false;
  }
}
