/** Composer sends, pinned-chat commands, nav keys and todo mention. */
import { isChatArchived } from '../../../../lib/chat-tree.js';
import { normalizeSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { sendTextWithEnterToTerminalState, sendSequenceToTerminalState } from '../../terminal/services/inputDispatch.js';
import { t } from '../../../i18n/index.js';
import { buildContextSeedPayload } from '../../../lib/context-seed-payload.js';
import { appendOptimisticSdkPrompt } from './sdkHistoryQueue.js';
import { parseWatcherCommand, runWatcherCommand, watcherCommandHelpLines, isWatcherPinnedChat } from '../watcherPinnedChat.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { CHAT_NAV_SEQUENCES } from '../state/chatNavSequences.js';
import { removeTodoMention, resolveTodoContinueBlock, appendTodoRef, parseTodoMention } from '../todoMention.js';
import { hasLiveHarnessWork } from '../chatStatusMeta.js';
import { buildTodoContinueNote } from '../../../../lib/todo-execution-prompt.js';
import * as api from '../../../core/api/index.js';
import { createTodoMentionPicker } from '../todoMentionPicker.js';
import { setAgentState } from './chatSidebarState.js';
import { getActiveSendInput } from './chatLifecycle.js';
import { chatHost } from './chatHost.js';

export function sendTextToAgent(chat, text, opts = {}) {
  if (isChatArchived(chat)) {
    chat._sdkRichView?.appendMetaNotice?.(t('chat.archivedReadOnly'));
    return false;
  }
  const sdkMode = normalizeSdkMode(opts.sdkMode ?? chat?.sdkMode);
  const internal = opts.internal === true;
  const rawText = text == null ? '' : String(text);
  let payloadText = rawText;
  let pendingSeedSummary = '';
  if (!internal && chat && typeof chat._contextSeedSummary === 'string' && chat._contextSeedSummary.trim()) {
    pendingSeedSummary = chat._contextSeedSummary.trim();
    delete chat._contextSeedSummary;
    payloadText = buildContextSeedPayload(pendingSeedSummary, rawText);
  }
  const sdkOutboundType =
    (chat?.agentTransport === 'sdk' || chat?.agentTransport === 'claude') &&
    chat._sdkSteerSupported === true &&
    chat._sdkServerBusy === true
      ? 'steer'
      : 'send';
  sendTextWithEnterToTerminalState(chat, payloadText, {
    sendEnterDelayMs: chatHost.SEND_ENTER_DELAY_MS,
    enterFocusDelayMs: chatHost.ENTER_FOCUS_DELAY_MS,
    sdkMode,
    sdkOutboundType,
    displayText: opts.displayText,
    selectedSkillIds: opts.selectedSkillIds,
    skillMentions: payloadText !== rawText ? false : opts.skillMentions,
    onBeforeSend: () => {
      if (chat.id) chatHost.recordChatActivity(chat.id);
    },
    onAfterSdkSend: (t) => {
      if (!internal) {
        if (pendingSeedSummary && chat._sdkRichView) {
          chat._sdkRichView.appendContextSeedBlock(pendingSeedSummary);
        }
        appendOptimisticSdkPrompt(chat, opts.displayText ?? rawText ?? t);
        setAgentState(chat, 'active');
      }
    },
  });
}

/**
 * Pinned workspace chat: run a slash command through the existing watcher/todo
 * APIs and echo the outcome into the transcript. Plain text is refused (the
 * pinned chat is not an LLM conversation).
 *
 * @param {object} chat
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function handleWatcherPinnedCommandSend(chat, text) {
  const view = chat?._sdkRichView;
  const parsed = parseWatcherCommand(text);
  if (!parsed) {
    view?.appendMetaNotice?.(t('watcherPinned.onlyCommands'));
    return;
  }
  if (parsed.command === 'help') {
    view?.appendMetaNotice?.(
      `${t('watcherPinned.helpTitle')}\n${watcherCommandHelpLines((key) => t(key)).join('\n')}`,
    );
    return;
  }
  const result = await runWatcherCommand({
    command: parsed.command,
    args: parsed.args,
    workspaceFolder: String(chat?.workspaceFolder || ''),
    chatId: String(chat?.id || ''),
  });
  view?.appendMetaNotice?.(`${parsed.raw} → ${result.message}`);
}

/**
 * Reflect pinned mode in the active chat pane: a body class for CSS, a command
 * placeholder on the send field, and a one-time help notice.
 *
 * @param {object | null | undefined} chat
 * @returns {void}
 */
export function applyPinnedChatModeUi(chat) {
  const pinnedMode = isWatcherPinnedChat(chat);
  document.body?.classList.toggle('watcher-pinned-chat', pinnedMode);
  const pane = document.querySelector('.chat-tab-pane.active');
  pane?.classList.toggle('is-watcher-pinned', pinnedMode);
  const input = getActiveSendInput();
  if (input) {
    if (pinnedMode) {
      if (input.dataset.watcherPinnedPlaceholder !== '1') {
        input.dataset.watcherPinnedBase = input.getAttribute('placeholder') || '';
        input.dataset.watcherPinnedPlaceholder = '1';
      }
      input.setAttribute('placeholder', t('watcherPinned.placeholder'));
    } else if (input.dataset.watcherPinnedPlaceholder === '1') {
      input.setAttribute('placeholder', input.dataset.watcherPinnedBase || '');
      delete input.dataset.watcherPinnedPlaceholder;
    }
  }
  if (pinnedMode && chat && !chat._watcherPinnedHelpShown) {
    chat._watcherPinnedHelpShown = true;
    chat._sdkRichView?.appendMetaNotice?.(
      `${t('watcherPinned.helpTitle')}\n${watcherCommandHelpLines((key) => t(key)).join('\n')}`,
      { silent: true },
    );
  }
}

export function sendKeySequenceToActiveChat(sequence) {
  if (!sequence) return false;
  const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  if (isChatArchived(chat)) return false;
  return sendSequenceToTerminalState(chat, sequence, {
    onBeforeSend: () => {
      if (chat?.id) chatHost.recordChatActivity(chat.id);
    },
  });
}

/**
 * Click a pending OpenCode permission or question control in the active chat.
 *
 * @param {'up'|'down'|'left'|'right'|'enter'|'escape'|'y'|'n'} direction
 * @returns {boolean}
 */
export function clickPendingChatPrompt(direction) {
  const chat = chatRuntime.activeChatId ? chats.find((entry) => entry.id === chatRuntime.activeChatId) : null;
  const pane = chat?.pane;
  if (!pane) return false;
  const permission = pane.querySelector(
    '.sdk-rich-opencode-permission:not(.sdk-rich-opencode-permission--answered):not(.sdk-rich-opencode-permission--resolved)'
  );
  if (permission instanceof HTMLElement) {
    if (direction === 'y' || direction === 'enter') {
      const onceBtn = permission.querySelector('.sdk-rich-opencode-permission-once');
      if (onceBtn instanceof HTMLElement) {
        onceBtn.click();
        return true;
      }
    }
    if (direction === 'n' || direction === 'escape') {
      const rejectBtn = permission.querySelector('.sdk-rich-opencode-permission-reject');
      if (rejectBtn instanceof HTMLElement) {
        rejectBtn.click();
        return true;
      }
    }
  }
  const question = pane.querySelector(
    '.sdk-rich-opencode-question:not(.sdk-rich-opencode-question--answered):not(.sdk-rich-opencode-question--rejected)'
  );
  if (question instanceof HTMLElement) {
    if (direction === 'y' || direction === 'enter') {
      const submitBtn = question.querySelector('.sdk-rich-opencode-question-submit');
      if (submitBtn instanceof HTMLElement) {
        submitBtn.click();
        return true;
      }
    }
    if (direction === 'n' || direction === 'escape') {
      const rejectBtn = question.querySelector('.sdk-rich-opencode-question-reject');
      if (rejectBtn instanceof HTMLElement) {
        rejectBtn.click();
        return true;
      }
    }
  }
  return false;
}

/**
 * Send a navigation or confirm key to the active chat.
 * PTY chats get the raw sequence; harness chats click a pending permission/question.
 *
 * @param {'up'|'down'|'left'|'right'|'enter'|'escape'|'y'|'n'} direction
 * @returns {boolean} true when sent
 */
export function sendNavKeyToActiveChat(direction) {
  const sequence = CHAT_NAV_SEQUENCES[direction];
  if (sequence && sendKeySequenceToActiveChat(sequence)) return true;
  return clickPendingChatPrompt(direction);
}

/**
 * @param {object} chat
 * @param {HTMLInputElement | HTMLTextAreaElement} input
 * @param {{ start: number, end: number } | null | undefined} mention
 */
export function clearTodoMentionToken(chat, input, mention) {
  chat._todoMentionRange = null;
  chat._todoMentionDismissed = '';
  if (!mention) return;
  const next = removeTodoMention(input.value, mention);
  input.value = next.text;
  input.setSelectionRange(next.caret, next.caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * @param {object} chat
 */
/**
 * @param {object} currentChat
 * @param {{ id?: string, chatId?: string, chats?: object[] }} item
 * @returns {{ chatId: string, title: string } | null}
 */
export function readTodoContinueBlock(currentChat, item) {
  const linkedChatIds = [];
  const direct = String(item?.chatId || '').trim();
  if (direct) linkedChatIds.push(direct);
  for (const row of Array.isArray(item?.chats) ? item.chats : []) {
    const id = String(row?.id || '').trim();
    if (id) linkedChatIds.push(id);
  }
  return resolveTodoContinueBlock({
    todoId: item?.id,
    currentChatId: currentChat?.id,
    chats,
    linkedChatIds,
    isBusy: (entry) => hasLiveHarnessWork(entry),
  });
}

/**
 * Play in the open chat: show the todo row and ask this agent to continue it.
 *
 * @param {object} chat
 * @param {object} item
 */
export function continueTodoInActiveChat(chat, item) {
  if (readTodoContinueBlock(chat, item)) return;
  const todoId = String(item?.id || '').trim();
  if (!todoId || !chat?.id) return;
  const input = chat.pane?._sendBar?.input;
  const mention = chat._todoMentionRange;
  if (input) clearTodoMentionToken(chat, input, mention);
  else chat._todoMentionRange = null;
  const typed = String(input?.value || '').trim();
  const note = buildTodoContinueNote(t('sendBar.todoContinuePrompt'));
  const text = appendTodoRef(typed ? `${typed}\n${note}` : note, todoId);
  chat.todoId = todoId;
  if (!chat._todoRowMeta) chat._todoRowMeta = {};
  chat._todoRowMeta[todoId] = {
    title: String(item?.title || ''),
    status: String(item?.status || ''),
  };
  chat._todoChip?.setDraft(null);
  chat._todoChip?.setLinked(null);
  chat._todoBanner?.sync();
  void api.patchChat(chat.id, { todoId }).catch(() => {});
  const sendBar = chat.pane?._sendBar;
  if (input && sendBar && typeof sendBar.submit === 'function') {
    input.value = text;
    sendBar.submit();
    return;
  }
  sendTextToAgent(chat, text);
}

export function ensureTodoMentionPicker(chat) {
  if (chat._todoMentionPicker) return chat._todoMentionPicker;
  chat._todoMentionPicker = createTodoMentionPicker({
    onSelect: (item) => {
      if (readTodoContinueBlock(chat, item)) return;
      const input = chat.pane?._sendBar?.input;
      const mention = chat._todoMentionRange;
      if (input) clearTodoMentionToken(chat, input, mention);
      else chat._todoMentionRange = null;
      chat._todoChip?.setDraft({
        id: String(item?.id || ''),
        title: String(item?.title || ''),
        status: String(item?.status || ''),
      });
    },
    onContinue: (item) => {
      continueTodoInActiveChat(chat, item);
    },
    getContinueBlock: (item) => readTodoContinueBlock(chat, item),
    onClose: () => {
      const mention = chat._todoMentionRange;
      if (!mention) return;
      chat._todoMentionDismissed = `${mention.start}:${mention.end}:${mention.query}`;
    },
  });
  return chat._todoMentionPicker;
}

/**
 * @param {object} chat
 * @param {HTMLInputElement | HTMLTextAreaElement} input
 */
export function syncTodoMention(chat, input) {
  const caret = input.selectionStart ?? input.value.length;
  const mention = parseTodoMention(input.value, caret);
  const picker = ensureTodoMentionPicker(chat);
  if (!mention) {
    chat._todoMentionRange = null;
    chat._todoMentionDismissed = '';
    if (picker?.isOpen()) picker.close();
    return;
  }
  chat._todoMentionRange = mention;
  const key = `${mention.start}:${mention.end}:${mention.query}`;
  if (picker.isOpen()) {
    picker.setQuery(mention.query);
    return;
  }
  if (chat._todoMentionDismissed === key) return;
  picker.open(mention.query);
}

/**
 * @param {Event} event
 */
export function onChatComposerMention(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (!target.classList.contains('send-keys-input')) return;
  const chat = chats.find((entry) => entry.pane?._sendBar?.input === target);
  if (!chat) return;
  syncTodoMention(chat, target);
}

export function openTodoMentionFromMenu() {
  const chat = chatRuntime.activeChatId ? chats.find((entry) => entry.id === chatRuntime.activeChatId) : null;
  if (!chat) return;
  chat._todoMentionDismissed = '';
  chat._todoMentionRange = null;
  ensureTodoMentionPicker(chat).open('');
}

/**
 * @param {object} chat
 */
export function syncChatTodoChip(chat) {
  chat?._todoBanner?.sync();
  const chip = chat?._todoChip;
  if (!chip) return;
  chip.setLinked(null);
}
