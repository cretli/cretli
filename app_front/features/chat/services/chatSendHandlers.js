/**
 * Composer send flow for a chat pane (page picks, delegation commands, title prompts, todo refs).
 */
import { chatHost } from './chatHost.js';
import { isChatArchived } from '../../../../lib/chat-tree.js';
import { AUTO_TITLE_PROMPT } from '../../../config.js';
import { formatHostPagePickContextBlock } from '../../../embed/widgetHostPagePick.js';
import { t } from '../../../i18n/index.js';
import { consumeSelectedSkillIds } from '../../sendBar/sendBarContextPicker.js';
import { sendSequenceToTerminalState } from '../../terminal/services/inputDispatch.js';
import { parseDelegationCommand } from '../chatDelegations.js';
import { AUTO_TITLE_TIMEOUT_MS } from '../chatTitleFork.js';
import { appendTodoRef } from '../todoMention.js';
import { isWatcherPinnedChat } from '../watcherPinnedChat.js';
import { handleWatcherPinnedCommandSend, readTodoContinueBlock, sendTextToAgent } from './chatComposer.js';
import { debugAutoTitle } from './chatDebugLogs.js';
import { hideChatResumeAdvice } from './chatResumeAdvice.js';
import { handleExecuteDelegationCommand } from './chatSdkMode.js';
import { isTerminalTextareaMode } from './chatSidebarState.js';
import { maybeAutoNameNewChat } from './chatTitlesOutput.js';
import { consumePendingInheritedPrompt } from './sdkHistoryQueue.js';

/**
 * Build the composer send callback for one chat pane.
 * @param {any} chat
 * @returns {{ chatOnSend: (text: string, meta?: Record<string, any>) => boolean }}
 */
export function createChatSendHandlers(chat) {
  function sendKeyToAgent(sequence) {
    if (isChatArchived(chat)) return;
    const focusDelayMs = sequence === '\r' ? chatHost.ENTER_FOCUS_DELAY_MS : 0;
    sendSequenceToTerminalState(chat, sequence, {
      focusDelayMs,
      onBeforeSend: () => {
        if (chat.id) chatHost.recordChatActivity(chat.id);
      },
    });
  }

  function chatOnSend(text, meta = {}) {
    if (isChatArchived(chat)) {
      chat._sdkRichView?.appendMetaNotice?.(t('chat.archivedReadOnly'));
      return false;
    }
    chat._awaitingInput = false;
    const rawText = typeof meta.rawText === 'string' ? meta.rawText : text || '';
    const trimmed = (text || '').trim();
    const hasPageSelection = !!meta.pageSelectionContext;
    const hasAttachments = Array.isArray(meta.attachmentPaths) && meta.attachmentPaths.some(Boolean);
    const draftTodoId = String(chat._todoChip?.getDraft()?.id || '').trim();
    const textareaMode = isTerminalTextareaMode(chat);
    if (!trimmed && !hasPageSelection && !hasAttachments && !draftTodoId) {
      if (textareaMode) return false;
      sendKeyToAgent('\r');
      return true;
    }
    if (isWatcherPinnedChat(chat)) {
      // Pinned workspace chat is a command shell over the watcher APIs, not a
      // model conversation. Never start an agent run from it.
      void handleWatcherPinnedCommandSend(chat, trimmed || rawText);
      chatHost.writeChatDraft(chat.id, '');
      return true;
    }
    const executeCommand = parseDelegationCommand(rawText);
    if (executeCommand) {
      void handleExecuteDelegationCommand(chat, executeCommand.extraInstructions);
      chatHost.writeChatDraft(chat.id, '');
      return true;
    }
    if (!chat.ws || chat.ws.readyState !== WebSocket.OPEN) {
      chatHost.ensureChatConnection(chat);
      chat._sdkRichView?.appendMetaNotice?.(t('chat.agentConnectionLostResend'));
      return false;
    }
    const isTitlePrompt =
      trimmed === AUTO_TITLE_PROMPT.trim() ||
      (trimmed.includes('Reply with a single line of JSON') && trimmed.includes('"title"'));
    if (isTitlePrompt) {
      debugAutoTitle('sendKeys', { chatId: chat.id, setPending: true, msg: 'prompt sent from the input field – now waiting for the JSON reply' });
      if (chat._autoTitleTimeout) {
        clearTimeout(chat._autoTitleTimeout);
        chat._autoTitleTimeout = null;
      }
      chat._pendingAutoTitle = true;
      chat._autoTitleBuffer = '';
      chat._autoTitleRequestAt = Date.now();
      chat._autoTitleTimeout = setTimeout(() => {
        debugAutoTitle('timeout (Enter)', { chatId: chat.id, msg: 'expired – no longer waiting for the JSON reply' });
        chat._pendingAutoTitle = false;
        chat._autoTitleBuffer = '';
        chat._autoTitleTimeout = null;
      }, AUTO_TITLE_TIMEOUT_MS);
    }
    let payloadText = rawText;
    let displayText = rawText;
    if (hasPageSelection) {
      const pageBlock = formatHostPagePickContextBlock(meta.pageSelectionContext);
      payloadText = pageBlock + (rawText.trim() ? `\n\n${rawText}` : '');
    }
    if (!isTitlePrompt) {
      const inherited = consumePendingInheritedPrompt(chat, payloadText);
      if (inherited) {
        payloadText = inherited.payloadText;
        displayText = inherited.displayText || rawText;
      }
      maybeAutoNameNewChat(chat, rawText);
    }
    if (draftTodoId && !isTitlePrompt) {
      const block = readTodoContinueBlock(chat, { id: draftTodoId });
      if (block) {
        chat._sdkRichView?.appendMetaNotice?.(t('sendBar.todoContinueBusy', { title: block.title }));
        chat._todoChip?.clearDraft();
        if (!trimmed && !hasPageSelection && !hasAttachments) return false;
      } else {
        payloadText = appendTodoRef(payloadText, draftTodoId);
        displayText = appendTodoRef(displayText, draftTodoId);
        chat._todoChip?.clearDraft();
      }
    }
    hideChatResumeAdvice(chat);
    // Picked skills travel as structured IDs; @name in the typed text is honoured only
    // when the payload is exactly what the user typed (no page, seed or inherited block).
    const selectedSkillIds = consumeSelectedSkillIds(rawText);
    sendTextToAgent(chat, payloadText, { displayText, selectedSkillIds, skillMentions: payloadText === rawText });
    chatHost.writeChatDraft(chat.id, '');
    return true;
  }
  return { chatOnSend };
}
