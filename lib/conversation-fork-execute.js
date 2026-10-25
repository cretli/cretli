/**
 * Production conversation-fork path used by POST /api/chats/:id/fork.
 * Tests and the live SDK probe must call this instead of assembling a prompt
 * with Agent.create + buildConversationForkPrompt alone.
 */

import { normalizeAgentTransport } from './agent-transport.js';
import { appendRelatedChatHistoryLinks } from './chat-relation-history.js';
import { formatChatHistoryEventsToText } from './context-compression.js';
import { buildForkInitialPrompt } from './conversation-fork.js';
import { resolveForkSourceText } from './fork-chat-text.js';
import { copyChatHistory, copyChatHistoryUntil, loadChatHistory } from './persist/chat-history-service.js';
import { createConversationForkChat } from './persist/chats-persist.js';

/** Supported fork modes; a missing mode keeps the copy-history behavior. */
export const CONVERSATION_FORK_MODES = Object.freeze(['reference']);

/** Validation failure that the route maps to a 4xx status. */
export class ConversationForkError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, code: string }} meta
   */
  constructor(message, meta) {
    super(message);
    this.name = 'ConversationForkError';
    this.status = meta.status;
    this.code = meta.code;
  }
}

/**
 * @typedef {{
 *   parentChat: object,
 *   message?: string,
 *   analyze?: boolean,
 *   mode?: unknown,
 *   sourceText?: string,
 *   upToCreatedAt?: string,
 *   workspaceFile?: string,
 *   workspaceFolder?: string,
 *   title?: string,
 *   model?: string,
 *   agentTransport?: string,
 *   copyFailedMessage?: string,
 * }} ExecuteConversationForkInput
 */

/**
 * Create a fork chat, copy (or cut) history, and build the initial prompt.
 *
 * @param {ExecuteConversationForkInput} input
 * @returns {Promise<{
 *   chat: object,
 *   initialPrompt: string,
 *   copiedThroughSeq: number,
 *   partial: boolean,
 *   analyze: boolean,
 *   parentChatId: string,
 * }>}
 */
export async function executeConversationFork(input = {}) {
  const parentChat = input.parentChat;
  if (!parentChat?.id) {
    throw new TypeError('Parent chat is required');
  }
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const analyze = input.analyze === true;
  // An explicit mode (even empty or non-string) must be a supported one.
  const hasMode = input.mode !== undefined;
  const mode = typeof input.mode === 'string' ? input.mode.trim() : '';
  if (hasMode && !CONVERSATION_FORK_MODES.includes(mode)) {
    throw new ConversationForkError('Unsupported fork mode', { status: 400, code: 'invalid_fork_mode' });
  }
  if (mode === 'reference' && analyze) {
    throw new ConversationForkError('Reference mode cannot be combined with analyze', { status: 400, code: 'invalid_fork_mode' });
  }
  const referenceOnly = mode === 'reference';
  const clientSourceText = typeof input.sourceText === 'string' ? input.sourceText : '';
  const upToCreatedAt = typeof input.upToCreatedAt === 'string' ? input.upToCreatedAt.trim() : '';
  const partialFork = !analyze && !referenceOnly && upToCreatedAt !== '';
  let promptSourceText = '';
  let historyPointer = false;
  let historyPointerChatId = '';
  if (referenceOnly) {
    // Validate before any chat row exists; the child only points at the parent.
    const savedSource = await loadChatHistory(parentChat.id);
    if (!Array.isArray(savedSource?.events) || savedSource.events.length === 0) {
      throw new ConversationForkError('Parent chat has no saved history to reference', {
        status: 409,
        code: 'reference_requires_saved_history',
      });
    }
    historyPointer = true;
    historyPointerChatId = parentChat.id;
  } else if (!analyze && !partialFork) {
    const savedSource = await loadChatHistory(parentChat.id);
    if (Array.isArray(savedSource?.events) && savedSource.events.length > 0) {
      // The saved transcript is reachable through Cretli MCP; keep it out of the prompt.
      historyPointer = true;
      historyPointerChatId = parentChat.id;
    } else {
      // Unsaved or SDK-only source: keep the inline transcript fallback.
      promptSourceText = await resolveForkSourceText(parentChat.id, clientSourceText);
    }
  }
  const requestedWorkspaceFile =
    typeof input.workspaceFile === 'string' ? input.workspaceFile.trim() : '';
  const requestedWorkspaceFolder =
    typeof input.workspaceFolder === 'string' ? input.workspaceFolder.trim() : '';
  const requestedTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const requestedModel = typeof input.model === 'string' ? input.model.trim() : '';
  const hasTransportOverride =
    typeof input.agentTransport === 'string' && input.agentTransport.trim() !== '';
  const toHarness = hasTransportOverride
    ? normalizeAgentTransport(input.agentTransport)
    : normalizeAgentTransport(parentChat.agentTransport);
  const toModel = requestedModel || parentChat.model;
  const chat = createConversationForkChat(parentChat, {
    workspaceFile: requestedWorkspaceFile || undefined,
    workspaceFolder: requestedWorkspaceFolder || undefined,
    title: requestedTitle || undefined,
    model: requestedModel || undefined,
    agentTransport: hasTransportOverride ? toHarness : undefined,
    forkKind: analyze ? 'analyze' : (referenceOnly ? 'reference' : undefined),
  });
  let copiedThroughSeq = 0;
  if (!analyze && !referenceOnly) {
    const copiedHistory = partialFork
      ? await copyChatHistoryUntil(parentChat.id, chat.id, chat.cursorSessionId, upToCreatedAt)
      : await copyChatHistory(parentChat.id, chat.id, chat.cursorSessionId);
    if (!copiedHistory.ok) {
      throw new Error(copiedHistory.error || input.copyFailedMessage || 'Failed to copy chat history');
    }
    copiedThroughSeq = Number(copiedHistory.headSeq) || 0;
    if (partialFork) {
      const cutText = formatChatHistoryEventsToText(copiedHistory.events || []);
      if (cutText.length > 0) {
        // Point at the cutoff-bounded copied child history. Never resolve the
        // source here: resolveForkSourceText can read past the fork point.
        historyPointer = true;
        historyPointerChatId = chat.id;
      } else {
        promptSourceText = clientSourceText;
      }
    }
  }
  await appendRelatedChatHistoryLinks({
    parentChat,
    childChat: chat,
    reason: analyze ? 'analyze' : (referenceOnly ? 'reference' : 'fork'),
  });
  return {
    chat,
    initialPrompt: buildForkInitialPrompt({
      sourceText: analyze ? '' : promptSourceText,
      message,
      fromHarness: parentChat.agentTransport,
      toHarness,
      fromModel: parentChat.model,
      toModel,
      analyze,
      partial: partialFork,
      sourceChatId: parentChat.id,
      sourceChatTitle: parentChat.title,
      copiedThroughSeq,
      historyPointer,
      historyPointerChatId,
    }),
    copiedThroughSeq,
    partial: partialFork,
    analyze,
    parentChatId: parentChat.id,
  };
}
