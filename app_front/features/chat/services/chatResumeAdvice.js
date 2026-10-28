/** Resume advice banner wiring and send-action chat creation. */
import { createResumeAdviceController, createResumeAdviceScheduler } from '../chatResumeAdviceBanner.js';
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { formatUsd } from '../../../../lib/usage/usage-rates.js';
import { hasProtocolAgentRun } from '../chatStatusMeta.js';
import { chatRuntime } from '../state/chatRuntimeState.js';
import { createReferenceChat } from '../chatReferenceFork.js';
import { flushPendingPush } from '../../../lib/sdk-chat-history-store.js';
import { normalizeNewChatHarness } from './newChatHarnessState.js';
import { stripAnsi } from '../chatTitleParsing.js';
import { FORK_MIN_TEXT_LEN } from '../chatTitleFork.js';
import { getChatAgentState, notifySidebar } from './chatSidebarHooks.js';
import { attachWidgetHostPinToCreatePayload, openCreatedChatWithPrompt, openCreatedForkChat, pinCreatedChatToHostIfWidget } from './chatCreation.js';
import { getWorkspaceContextForChat } from './chatWorkspaceContext.js';
import { notifyWidgetParentPagePinChanged, syncWidgetPinUrlUi } from './chatWidgetPin.js';
import { readChatBufferFromLocalStorage } from './chatTitlesOutput.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';
import { requestArchiveChatConfirmed } from './chatDeleteArchive.js';

/** Lazily built controller of the inline cheap-resume notice. */
export function getChatResumeAdviceController() {
  if (!chatShell.chatResumeAdviceController) {
    chatShell.chatResumeAdviceController = createResumeAdviceController({
      api,
      storage: typeof localStorage !== 'undefined' ? localStorage : null,
      t,
      formatUsd,
      getHost: (chat) => chat._resumeAdviceHost || null,
      onReference: createReferenceChatFromAdvice,
      onArchive: (chat) => requestArchiveChatConfirmed(chat.id),
    });
  }
  return chatShell.chatResumeAdviceController;
}

/** Scheduler semantics are documented on createResumeAdviceScheduler. */
export function getChatResumeAdviceScheduler() {
  if (!chatShell.chatResumeAdviceScheduler) {
    chatShell.chatResumeAdviceScheduler = createResumeAdviceScheduler({
      check: (chat) => getChatResumeAdviceController().check(chat),
      isBusy: (chat) => hasProtocolAgentRun(chat) || getChatAgentState(chat) === 'active',
    });
  }
  return chatShell.chatResumeAdviceScheduler;
}

/** Select / first idle composer focus. The server owns harness and TTL knowledge. */
export function checkChatResumeAdvice(chat) {
  if (!chat?.id || chat.id !== chatRuntime.activeChatId) return Promise.resolve();
  return getChatResumeAdviceScheduler().request(chat);
}

/** The user sent a message: the cache is about to be warm again, so drop the banner. */
export function hideChatResumeAdvice(chat) {
  getChatResumeAdviceScheduler().reset(chat);
  getChatResumeAdviceController().hide(chat);
}

/**
 * "New chat with reference": a no-copy fork that points at the old chat.
 * @param {object} parentChat
 * @returns {Promise<{ ok: boolean, code?: string }>}
 */
export function createReferenceChatFromAdvice(parentChat, options = {}) {
  return createReferenceChat(parentChat, {
    flushPendingPush,
    postChatFork: (id, payload) => api.postChatFork(id, payload),
    postChatForkWithSummary: (id, payload) => api.postChatForkWithSummary(id, payload),
    // The chat was created as a plain reference chat; tell the user why there is no summary.
    onSummaryFallback: ({ error }) => alert(t('chat.resumeAdviceSummaryFailed', { error })),
    pinCreatedChat: pinCreatedChatToHostIfWidget,
    fillMissingContext: (created, parent) => {
      const workspaceContext = getWorkspaceContextForChat();
      created.workspaceFile ||= parent.workspaceFile || workspaceContext?.workspaceFile;
      created.workspaceFolder ||= parent.workspaceFolder || workspaceContext?.workspaceFolder;
    },
    readDraft: (chat) => chat.pane?._sendBar?.input?.value || chatHost.readChatDraft(chat.id),
    clearDraft: (chat) => {
      const input = chat.pane?._sendBar?.input;
      if (input) input.value = '';
      chatHost.writeChatDraft(chat.id, '');
    },
    openForkChat: (created, prompt, displayText, { carriedDraft }) => {
      const live = openCreatedForkChat(created, prompt, displayText);
      // A carried draft is not the default text: the first send (edited or not)
      // then appends exactly one copy of it to the inherited prompt.
      if (live && carriedDraft) live._pendingInheritedDisplayText = '';
      notifySidebar();
    },
    defaultDisplayText: t('chat.resumeAdviceDisplayText'),
  }, options);
}

export async function createChatFromSendAction(parentChat, message, forkConversation) {
  if (!parentChat?.id || !message?.trim()) return false;
  const parentTransport = normalizeNewChatHarness(parentChat?.agentTransport || 'sdk');
  let data;
  try {
    if (forkConversation) {
      const historySynced = await flushPendingPush(
        parentChat.id,
        parentChat.cursorSessionId || ''
      );
      if (!historySynced) {
        alert(t('sendBar.forkSyncFailed'));
        return false;
      }
      let sourceText = stripAnsi(
        parentChat._sdkRichView?.getCopyText?.() ||
        (typeof parentChat._buffer === 'string' ? parentChat._buffer : '') ||
        readChatBufferFromLocalStorage(parentChat.id)
      ).trim();
      if (sourceText.length < FORK_MIN_TEXT_LEN) {
        const fallbackText = await chatRuntime.resolveChatTextForFork(parentChat);
        if (fallbackText.length > sourceText.length) sourceText = fallbackText;
      }
      data = await api.postChatFork(parentChat.id, { message, sourceText });
    } else {
      const payload = {
        workspaceFile: parentChat.workspaceFile,
        workspaceFolder: parentChat.workspaceFolder,
        model: parentChat.model,
        agentTransport: parentTransport,
        sdkMode: parentChat.sdkMode,
        sdkUiMode: parentChat.sdkUiMode,
      };
      await attachWidgetHostPinToCreatePayload(payload);
      data = await api.postChat(payload);
    }
  } catch (_) {
    alert(t('chat.serverConnectionError'));
    return false;
  }
  if (!data?.ok || !data.chat) {
    alert(data?.error || t('chat.createFailed', { detail: t('chat.unknownError') }));
    return false;
  }
  const workspaceContext = getWorkspaceContextForChat();
  data.chat.workspaceFile ||= parentChat.workspaceFile || workspaceContext?.workspaceFile;
  data.chat.workspaceFolder ||= parentChat.workspaceFolder || workspaceContext?.workspaceFolder;
  if (forkConversation) {
    await pinCreatedChatToHostIfWidget(data.chat);
  }
  const initialPrompt = forkConversation ? data.initialPrompt || message : message;
  const live = openCreatedChatWithPrompt(data.chat, initialPrompt, message);
  syncWidgetPinUrlUi(live || data.chat);
  notifyWidgetParentPagePinChanged();
  chatHost.writeChatDraft(parentChat.id, '');
  return true;
}
