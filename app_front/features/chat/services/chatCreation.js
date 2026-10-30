/** Created-chat adoption, temporary forks and todo-agent chats. */
import { normalizeNewChatHarness, isEmbedWidgetMode } from './newChatHarnessState.js';
import { normalizeSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../../../../lib/sdk/sdk-ui-mode.ts';
import { getChatWidgetPinnedUrl } from '../chatWidgetPin.js';
import { chats } from '../state/chatRuntimeState.js';
import { isSamePageUrl, isWidgetHostNavigationAvailable, requestWidgetHostUrl } from '../../../embed/widgetHostNavigation.js';
import { sendPromptWhenChatReady } from './harnessSwitch.js';
import * as api from '../../../core/api/index.js';
import { sendTextWithEnterToTerminalState } from '../../terminal/services/inputDispatch.js';
import { appLogger } from '../../../core/logging/logger.js';
import { t } from '../../../i18n/index.js';
import { recoverChatAfterCompressionFailure } from '../chatContextCompressionRecovery.js';
import { performSelectChat, selectChat } from './chatSelection.js';
import { renderChatList } from './chatSidebarState.js';
import { getWorkspaceContextForChat } from './chatWorkspaceContext.js';
import { closeChat } from './chatLifecycle.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

/**
 * Selects a chat that was just created on the current host page.
 * Skips widget URL navigation so the new pane is shown immediately.
 * @param {string} chatId
 */
export function selectNewlyCreatedChat(chatId) {
  if (!chatId) return;
  chatShell.pinnedChatSelectionGuard = true;
  try {
    performSelectChat(chatId);
  } finally {
    chatShell.pinnedChatSelectionGuard = false;
  }
}

/**
 * Merge server fields onto an existing runtime chat without dropping the pane/WS.
 * @param {object} target
 * @param {object} source
 */
export function mergeCreatedChatRecord(target, source) {
  target.agentTransport = normalizeNewChatHarness(source.agentTransport || target.agentTransport || 'sdk');
  target.sdkMode = normalizeSdkMode(source.sdkMode || target.sdkMode);
  target.sdkUiMode = normalizeSdkUiMode(source.sdkUiMode || target.sdkUiMode);
  if (source.title) target.title = source.title;
  if (source.model) target.model = source.model;
  if (source.workspaceFile) target.workspaceFile = source.workspaceFile;
  if (source.workspaceFolder) target.workspaceFolder = source.workspaceFolder;
  if (typeof source.widgetPinnedUrl === 'string' && source.widgetPinnedUrl.trim()) {
    target.widgetPinnedUrl = source.widgetPinnedUrl.trim();
  }
  if (typeof source.todoId === 'string' && source.todoId.trim()) {
    target.todoId = source.todoId.trim();
  }
}

/**
 * Inserts a newly created chat (or reuses the existing row) and shows its pane.
 * @param {object} chat
 * @returns {object | null}
 */
export function adoptCreatedChat(chat) {
  if (!chat?.id) return null;
  chat.agentTransport = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  chat.sdkMode = normalizeSdkMode(chat.sdkMode);
  chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
  const pinnedUrl = getChatWidgetPinnedUrl(chat);
  if (pinnedUrl) {
    chats.forEach((item) => {
      if (item.id === chat.id) return;
      const otherPinned = getChatWidgetPinnedUrl(item);
      if (otherPinned && isSamePageUrl(otherPinned, pinnedUrl)) {
        delete item.widgetPinnedUrl;
      }
    });
  }
  const existing = chats.find((entry) => entry.id === chat.id);
  if (existing) {
    mergeCreatedChatRecord(existing, chat);
    if (!existing.pane) chatHost.openTerminal(existing);
    renderChatList();
    selectNewlyCreatedChat(existing.id);
    return existing;
  }
  chats.push(chat);
  renderChatList();
  chatHost.openTerminal(chat);
  selectNewlyCreatedChat(chat.id);
  return chat;
}

export function openCreatedChatWithPrompt(chat, initialPrompt, displayText) {
  const live = adoptCreatedChat(chat);
  if (!live) return null;
  sendPromptWhenChatReady(live, initialPrompt, displayText);
  return live;
}

/**
 * Open a conversation fork without sending. The continue/handoff prompt stays in
 * the send field and is delivered on the first user send.
 *
 * @param {object} chat
 * @param {string} initialPrompt
 * @param {string} [displayText]
 * @returns {object|null}
 */
export function openCreatedForkChat(chat, initialPrompt, displayText) {
  const prompt = typeof initialPrompt === 'string' ? initialPrompt.trim() : '';
  const draft = typeof displayText === 'string' ? displayText.trim() : '';
  if (chat?.id && draft) chatHost.writeChatDraft(chat.id, draft);
  const live = adoptCreatedChat(chat);
  if (!live) return null;
  if (prompt) {
    live._pendingInheritedPrompt = prompt;
    live._pendingInheritedDisplayText = draft;
  }
  return live;
}

/**
 * Pins an explicit new chat to the current widget host page.
 * forceNewPinnedChat avoids reusing the chat already linked to that URL.
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, unknown>>}
 */
export async function attachWidgetHostPinToCreatePayload(payload) {
  if (!isEmbedWidgetMode() || !isWidgetHostNavigationAvailable()) return payload;
  try {
    const current = await requestWidgetHostUrl();
    const hostPageUrl = typeof current?.url === 'string' ? current.url.trim() : '';
    if (!hostPageUrl) return payload;
    payload.widgetPinnedUrl = hostPageUrl;
    payload.forceNewPinnedChat = true;
  } catch {
    // Pin is optional; the new chat can still start.
  }
  return payload;
}

/**
 * Moves the current page pin onto a chat created by fork/analyze.
 * @param {object} chat
 */
export async function pinCreatedChatToHostIfWidget(chat) {
  if (!chat?.id) return;
  const payload = {};
  await attachWidgetHostPinToCreatePayload(payload);
  const hostPageUrl = typeof payload.widgetPinnedUrl === 'string' ? payload.widgetPinnedUrl.trim() : '';
  if (!hostPageUrl) return;
  try {
    const data = await api.patchChat(chat.id, { widgetPinnedUrl: hostPageUrl });
    chat.widgetPinnedUrl = data?.chat?.widgetPinnedUrl || hostPageUrl;
  } catch {
    chat.widgetPinnedUrl = hostPageUrl;
  }
}

export function getWorkspaceDefaultFolder(workspace) {
  if (!workspace || typeof workspace !== 'object') return '';
  if (typeof workspace.workspaceDir === 'string' && workspace.workspaceDir.trim()) {
    return workspace.workspaceDir.trim();
  }
  if (!Array.isArray(workspace.folders) || workspace.folders.length === 0) return '';
  const first = workspace.folders.find(
    (folder) => folder && typeof folder.resolvedPath === 'string' && folder.resolvedPath.trim()
  );
  return first?.resolvedPath?.trim() || '';
}

/**
 * Open the chat linked to a Todo (new or existing) and optionally send a start prompt.
 * @param {object} chat
 * @param {{ initialPrompt?: string, continuationPrompt?: string, reused?: boolean }} [options]
 */
export function openTodoAgentChat(chat, options = {}) {
  if (!chat?.id) return;
  const existing = chats.find((c) => c.id === chat.id);
  if (existing) {
    const next = { ...chat };
    if (!next.agentTransport) delete next.agentTransport;
    if (!next.sdkMode) delete next.sdkMode;
    if (next.agentTransport) {
      next.agentTransport = normalizeNewChatHarness(next.agentTransport);
    }
    Object.assign(existing, next);
  } else {
    chat.agentTransport = normalizeNewChatHarness(chat.agentTransport || 'sdk');
    // Plan mode is an explicit choice; an unknown mode must not silently start a
    // todo chat read-only. Leave it unset so the server's mode wins on connect.
    chats.push(chat);
  }
  renderChatList();
  chatHost.openTerminal(existing || chat);
  const active = chats.find((c) => c.id === chat.id) || chat;
  selectChat(active.id);

  const continuationPrompt = typeof options.continuationPrompt === 'string' ? options.continuationPrompt.trim() : '';
  const initialPrompt = continuationPrompt
    || (typeof options.initialPrompt === 'string' ? options.initialPrompt.trim() : '');
  if (!initialPrompt || (options.reused && !continuationPrompt)) return;

  const maxAttempts = 80;
  let attempts = 0;
  const trySend = () => {
    attempts += 1;
    if (active.ws?.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        sendTextWithEnterToTerminalState(active, initialPrompt, {
          // Unknown mode: omit it so the server runs the chat's stored mode.
          sdkMode: active.sdkMode,
          focusDelayMs: 600,
          sendEnterDelayMs: 250,
        });
      }, 400);
      return;
    }
    if (attempts >= maxAttempts) return;
    setTimeout(trySend, 250);
  };
  chatHost.ensureChatConnection(active);
  trySend();
}

/**
 * Register a temporary fork chat on the list, connect in the background, and send the start prompt.
 * @param {object} chat
 * @param {{ initialPrompt?: string }} [options]
 */
export function openTemporaryForkChat(chat, options = {}) {
  if (!chat?.id) return;
  chat.agentTransport = 'sdk';
  if (!chat.sdkMode) chat.sdkMode = 'agent';
  chat.isTemporary = true;
  const ctx = getWorkspaceContextForChat();
  if (!chat.workspaceFile && ctx?.workspaceFile) chat.workspaceFile = ctx.workspaceFile;
  if (!chat.workspaceFolder && ctx?.workspaceFolder) chat.workspaceFolder = ctx.workspaceFolder;
  const existing = chats.find((c) => c.id === chat.id);
  if (existing) {
    Object.assign(existing, chat);
  } else {
    chats.push(chat);
  }
  renderChatList();
  appLogger.log('fork-temp-chat', 'temporary chat added', {
    tempChatId: chat.id,
    forkParentChatId: chat.forkParentChatId,
    forkKind: chat.forkKind,
  });
  const active = chats.find((c) => c.id === chat.id) || chat;

  const initialPrompt = typeof options.initialPrompt === 'string' ? options.initialPrompt.trim() : '';
  if (!initialPrompt) {
    chatHost.syncBackgroundChatConnections();
    return;
  }

  const maxAttempts = 80;
  let attempts = 0;
  const trySend = () => {
    attempts += 1;
    if (active.ws?.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        sendTextWithEnterToTerminalState(active, initialPrompt, {
          sdkMode: active.sdkMode || 'agent',
          focus: false,
          focusDelayMs: 400,
        });
      }, 400);
      return;
    }
    if (attempts >= maxAttempts) {
      appLogger.log('fork-temp-chat', 'initial prompt send exhausted', {
        tempChatId: active.id,
        forkKind: active.forkKind,
      });
      active._sdkRichView?.appendMetaNotice?.(t('chat.summaryForkWsFailed'));
      if (active.forkKind === 'summary' && active.forkParentChatId) {
        const parentChat = chats.find((entry) => entry.id === active.forkParentChatId);
        if (parentChat) {
          recoverChatAfterCompressionFailure(parentChat, 'summary_fork_ws_exhausted');
        }
      }
      return;
    }
    setTimeout(trySend, 250);
  };
  chatHost.ensureChatConnection(active);
  chatHost.syncBackgroundChatConnections();
  trySend();
}

/**
 * Removes the temporary fork chat from the UI; the server deletes it after the callback.
 * @param {string|null|undefined} tempChatId
 * @param {string|null|undefined} parentChatId
 */
export function dismissTemporaryForkChat(tempChatId, parentChatId) {
  if (!tempChatId) return;
  const chat = chats.find((c) => c.id === tempChatId);
  if (!chat?.isTemporary) return;
  closeChat(tempChatId, {
    skipApiDelete: true,
    switchToChatId: parentChatId || chat.forkParentChatId || null,
  });
}
