/** Harness switching for an open chat: old-chat disposition, handoff and in-place switch. */
import * as api from '../../../core/api/index.js';
import { showChoiceDialog } from '../../../lib/choiceDialog.js';
import { buildHarnessHandoffPrompt } from '../../../../lib/conversation-fork.js';
import { resolveHarnessSwitchNest, isChatArchived } from '../../../../lib/chat-tree.js';
import { t } from '../../../i18n/index.js';
import { normalizeSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../../../../lib/sdk/sdk-ui-mode.ts';
import { saveLastSelectedHarness, normalizeModelValue } from '../chatSettingsPrefs.js';
import { stripAnsi } from '../chatTitleParsing.js';
import { FORK_MIN_TEXT_LEN } from '../chatTitleFork.js';
import { getChatWidgetPinnedUrl } from '../chatWidgetPin.js';
import { requestWidgetHostUrl } from '../../../embed/widgetHostNavigation.js';
import {
  clearPendingHarnessSwitch,
  normalizeHarnessActionChoice,
  rememberPendingHarnessSwitch,
  resolvePendingHarnessSwitch,
} from './harnessModelCatalog.js';
import { isEmbedWidgetMode, normalizeNewChatHarness } from './newChatHarnessState.js';
import { chatRuntime, chats, removedChatIds } from '../state/chatRuntimeState.js';
import { chatHost } from './chatHost.js';

function getOldChatDispositionOptions() {
  return [
    {
      value: 'archive',
      label: t('chat.harnessSwitchOldChatArchive'),
      hint: t('chat.harnessSwitchOldChatArchiveHint'),
      variant: 'primary',
    },
    {
      value: 'delete',
      label: t('chat.harnessSwitchOldChatDelete'),
      hint: t('chat.harnessSwitchOldChatDeleteHint'),
      variant: 'danger',
    },
    {
      value: 'keep',
      label: t('chat.harnessSwitchOldChatKeep'),
      hint: t('chat.harnessSwitchOldChatKeepHint'),
    },
  ];
}

async function promptOldChatDispositionChoice() {
  await new Promise((resolve) => {
    window.setTimeout(resolve, 250);
  });
  const answer = await showChoiceDialog({
    heading: t('chat.harnessSwitchOldChatTitle'),
    body: t('chat.harnessSwitchOldChatBody'),
    cancelLabel: t('chat.cancel'),
    checkboxLabel: t('chat.harnessSwitchIncludeContext'),
    checkboxHint: t('chat.harnessSwitchIncludeContextHint'),
    checkboxChecked: true,
    options: getOldChatDispositionOptions(),
  });
  if (answer == null) return null;
  const action = typeof answer === 'string' ? answer : answer.value;
  return {
    action: normalizeHarnessActionChoice(action),
    includeContext: typeof answer === 'object' && answer.checked === true,
  };
}

async function applyOldChatDisposition(oldChat, newChatId, action) {
  if (!oldChat?.id) return 'keep';
  const nest = resolveHarnessSwitchNest(oldChat, newChatId);
  if (action === 'delete') {
    let data = null;
    try {
      data = await api.deleteChat(oldChat.id);
    } catch {
      data = null;
    }
    if (!data?.ok) {
      window.alert(data?.error || t('chat.harnessSwitchDeleteFailed'));
      chatHost.closeChat(oldChat.id, { skipApiDelete: false, switchToChatId: newChatId });
    } else {
      removedChatIds.add(oldChat.id);
      chatHost.closeChat(oldChat.id, { skipApiDelete: true, switchToChatId: newChatId });
    }
    if (nest?.childId === newChatId) {
      await nestChatUnderParent(nest.childId, nest.parentId);
    }
    return 'delete';
  }
  if (nest) await nestChatUnderParent(nest.childId, nest.parentId);
  if (action === 'archive') {
    await chatHost.requestArchiveChat(oldChat.id, { switchToChatId: newChatId });
    return 'archive';
  }
  try {
    const data = await api.patchChat(oldChat.id, { widgetPinnedUrl: null });
    if (data?.ok && data.chat) {
      const live = chats.find((entry) => entry.id === oldChat.id);
      if (live) Object.assign(live, data.chat);
      chatHost.renderChatList();
      chatHost.notifySidebar();
    }
  } catch (err) {
    console.warn('[chat] unpin widget url failed:', err?.message || err);
  }
  return 'keep';
}

/**
 * Persist sidebar nesting after a harness switch.
 *
 * @param {string} childId
 * @param {string} parentId
 * @returns {Promise<void>}
 */
async function nestChatUnderParent(childId, parentId) {
  const id = String(childId || '').trim();
  const nextParentId = String(parentId || '').trim();
  if (!id || !nextParentId || id === nextParentId) return;
  const live = chats.find((entry) => entry.id === id);
  if (live) live.forkParentChatId = nextParentId;
  chatHost.notifySidebar();
  try {
    const data = await api.patchChat(id, { forkParentChatId: nextParentId });
    if (!data?.ok || !data.chat) return;
    const next = chats.find((entry) => entry.id === id);
    if (!next) return;
    if (typeof data.chat.forkParentChatId === 'string' && data.chat.forkParentChatId.trim()) {
      next.forkParentChatId = data.chat.forkParentChatId.trim();
    } else {
      delete next.forkParentChatId;
    }
    chatHost.notifySidebar();
    refreshRelatedChatHistoryLinks(next);
    refreshRelatedChatHistoryLinks(chats.find((entry) => entry.id === nextParentId));
  } catch (err) {
    console.warn('[chat] nest harness chat failed:', err?.message || err);
  }
}

/**
 * Show clickable parent/child links in the open chat stream.
 *
 * @param {object | null | undefined} chat
 */
export function refreshRelatedChatHistoryLinks(chat) {
  const view = chat?._sdkRichView;
  if (!chat?.id || typeof view?.ensureRelatedChatLinks !== 'function') return;
  const parentId = String(chat.forkParentChatId || chat.delegationParentChatId || '').trim();
  const parent = parentId ? chats.find((entry) => entry.id === parentId) : null;
  const children = chats.filter((entry) => {
    if (!entry?.id || entry.id === chat.id || entry.isTemporary === true) return false;
    if (isChatArchived(entry)) return false;
    const kind = String(entry.forkKind || '');
    if (kind === 'title' || kind === 'summary') return false;
    return String(entry.forkParentChatId || '') === chat.id
      || String(entry.delegationParentChatId || '') === chat.id;
  });
  view.ensureRelatedChatLinks({
    parent: parent && !isChatArchived(parent)
      ? {
        chatId: parentId,
        title: parent.title || parentId.slice(0, 8),
        reason: String(chat.forkKind || ''),
      }
      : null,
    children: children.map((entry) => ({
      chatId: entry.id,
      title: entry.title || String(entry.id).slice(0, 8),
      reason: String(entry.forkKind || ''),
    })),
  });
}

/**
 * Creates a new workspace chat with another harness (regular app, not widget).
 *
 * @param {object} chat
 * @param {string} nextHarness
 * @param {string} nextModel
 * @returns {Promise<{ ok: boolean, chat?: object, error?: string }>}
 */
async function createAppChatForHarnessSwitch(chat, nextHarness, nextModel) {
  const ctx = chatHost.getWorkspaceContextForChat();
  const workspaceFile = String(chat?.workspaceFile || ctx?.workspaceFile || '').trim();
  const workspaceFolder = String(chat?.workspaceFolder || ctx?.workspaceFolder || '').trim();
  if (!workspaceFile) {
    return { ok: false, error: t('chat.noWorkspaceSelected') };
  }
  if (!workspaceFolder) {
    return { ok: false, error: t('chat.selectFolderInNewChatForm') };
  }
  const payload = {
    workspaceFile,
    workspaceFolder,
    agentTransport: nextHarness,
    model: nextModel,
    sdkMode: String(chat?.sdkMode || 'agent').trim() || 'agent',
    sdkUiMode: String(chat?.sdkUiMode || 'compact').trim() || 'compact',
  };
  const worktreeTodoId = chat?.onWorktree === true
    ? String(chat.todoId || '').trim()
    : '';
  if (worktreeTodoId) payload.worktreeTodoId = worktreeTodoId;
  let data = null;
  try {
    data = await api.postChat(payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!data?.ok || !data.chat?.id) {
    return { ok: false, error: data?.error || t('chat.harnessSwitchFailed') };
  }
  const created = data.chat;
  created.agentTransport = normalizeNewChatHarness(created.agentTransport);
  created.sdkMode = normalizeSdkMode(created.sdkMode);
  created.sdkUiMode = normalizeSdkUiMode(created.sdkUiMode);
  if (!chats.some((entry) => entry.id === created.id)) chats.push(created);
  chatHost.renderChatList();
  chatHost.notifySidebar();
  return { ok: true, chat: created };
}

/**
 * @param {object} chat
 * @returns {Promise<string>}
 */
export async function readChatTranscriptForHandoff(chat) {
  if (!chat?.id) return '';
  let sourceText = stripAnsi(
    chat._sdkRichView?.getCopyText?.() ||
      (typeof chat._buffer === 'string' ? chat._buffer : '') ||
      chatHost.readChatBufferFromLocalStorage(chat.id)
  ).trim();
  if (sourceText.length >= FORK_MIN_TEXT_LEN) return sourceText;
  const fallbackText = await chatRuntime.resolveChatTextForFork(chat);
  if (fallbackText.length > sourceText.length) return fallbackText;
  return sourceText;
}

/**
 * @param {object} chat
 * @param {string} initialPrompt
 * @param {string} [displayText]
 */
export function sendPromptWhenChatReady(chat, initialPrompt, displayText) {
  if (!chat?.id) return;
  const prompt = typeof initialPrompt === 'string' ? initialPrompt.trim() : '';
  if (!prompt) return;
  let attempts = 0;
  const trySend = () => {
    const live = chats.find((entry) => entry.id === chat.id) || chat;
    attempts += 1;
    if (live.ws?.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        chatHost.sendTextToAgent(live, prompt, {
          displayText,
          sdkMode: live.sdkMode,
        });
        chatHost.maybeAutoNameNewChat(live, prompt);
      }, 400);
      return;
    }
    if (attempts >= 80) return;
    setTimeout(trySend, 250);
  };
  chatHost.ensureChatConnection(chat);
  trySend();
}

/**
 * Create a new chat on another harness and optionally hand off the transcript.
 *
 * @param {object} chat
 * @param {string} nextHarness
 * @param {string} nextModel
 * @param {{ action: string, includeContext: boolean }} choice
 * @returns {Promise<{ ok: boolean, chatId?: string, title?: string, harness?: string, oldChat?: string, handoff?: boolean, error?: string }>}
 */
export async function executeHarnessSwitch(chat, nextHarness, nextModel, choice) {
  const currentHarness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  const disposition = choice.action;
  const includeContext = choice.includeContext === true;
  let handoffPrompt = '';
  if (includeContext) {
    // The source chat is persisted server-side and readable through Cretli MCP,
    // so the handoff carries a compact history pointer instead of a copied
    // transcript. Keep the inline read only for a chat that was never saved.
    const historyPointer = Boolean(chat.id);
    const sourceText = historyPointer ? '' : await readChatTranscriptForHandoff(chat);
    handoffPrompt = buildHarnessHandoffPrompt({
      sourceText,
      fromHarness: currentHarness,
      toHarness: nextHarness,
      fromModel: chat.model,
      toModel: nextModel,
      sourceChatId: chat.id,
      sourceChatTitle: chat.title,
      historyPointer,
    });
  }
  const oldChatId = chat.id;
  const widgetMode = isEmbedWidgetMode();
  let pageUrl = '';
  /** @type {{ ok?: boolean, chat?: { id?: string }, error?: string } | null} */
  let result = null;
  if (widgetMode) {
    const host = await requestWidgetHostUrl().catch(() => ({ url: '' }));
    const hostPageUrl = typeof host?.url === 'string' ? host.url.trim() : '';
    pageUrl = hostPageUrl || getChatWidgetPinnedUrl(chat) || '';
    if (!pageUrl) {
      return { ok: false, error: t('chat.harnessSwitchMissingPageUrl') };
    }
    result = await chatHost.createPageLinkedChat({
      pageUrl,
      pageTitle: chat.title,
      harness: nextHarness,
      forceNew: true,
      workspaceFile: chat.workspaceFile,
      workspaceFolder: chat.workspaceFolder,
      model: nextModel,
      sdkMode: chat.sdkMode,
      sdkUiMode: chat.sdkUiMode,
    });
  } else {
    result = await createAppChatForHarnessSwitch(chat, nextHarness, nextModel);
  }
  if (!result?.ok || !result.chat?.id) {
    return { ok: false, error: result?.error || t('chat.harnessSwitchFailed') };
  }
  chatRuntime.selectedHarness = nextHarness;
  saveLastSelectedHarness(chatRuntime.selectedHarness);
  await applyOldChatDisposition(chat, result.chat.id, disposition);
  if (widgetMode && pageUrl) {
    await chatHost.loadChatsFromServer({
      pinnedTo: pageUrl,
      includeArchived: true,
      preferChatId: result.chat.id,
      skipAutoSelect: true,
    });
  }
  if (disposition === 'delete' && chats.some((entry) => entry.id === oldChatId)) {
    chatHost.closeChat(oldChatId, { skipApiDelete: false, switchToChatId: result.chat.id });
  }
  chatHost.adoptCreatedChat(result.chat);
  if (handoffPrompt) {
    const liveChat = chats.find((entry) => entry.id === result.chat.id) || result.chat;
    sendPromptWhenChatReady(liveChat, handoffPrompt, t('chat.harnessHandoffDisplayText'));
  }
  return {
    ok: true,
    chatId: result.chat.id,
    title: String(result.chat.title || '').trim() || 'untitled',
    harness: nextHarness,
    oldChat: disposition,
    handoff: includeContext,
  };
}

export async function switchChatHarnessInWidget(chat, harness, model) {
  if (!chat?.id || chatRuntime.switchHarnessInFlight) return;
  const bar = chat.sdkModeBarEl || chatRuntime.sharedSdkModeBar;
  const requestedHarness = String(harness || '').trim();
  const nextHarness = requestedHarness
    ? normalizeNewChatHarness(requestedHarness)
    : resolvePendingHarnessSwitch(bar, chat);
  const currentHarness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  if (!nextHarness || nextHarness === currentHarness) {
    if (model) void chatHost.setChatModel(chat, model);
    clearPendingHarnessSwitch(chat);
    return;
  }
  rememberPendingHarnessSwitch(chat, nextHarness);
  const nextModel = normalizeModelValue(model || chatRuntime.selectedModel || 'auto');
  chatRuntime.switchHarnessInFlight = true;
  try {
    const choice = await promptOldChatDispositionChoice();
    if (choice == null) {
      clearPendingHarnessSwitch(chat);
      return;
    }
    const result = await executeHarnessSwitch(chat, nextHarness, nextModel, choice);
    if (!result.ok) {
      window.alert(result.error || t('chat.harnessSwitchFailed'));
      clearPendingHarnessSwitch(chat);
    }
  } finally {
    chatRuntime.switchHarnessInFlight = false;
    chatRuntime.pendingWidgetHarnessSwitch = null;
    if (chatRuntime.sharedSdkModeBar) chatRuntime.sharedSdkModeBar.pendingHarness = '';
  }
}
