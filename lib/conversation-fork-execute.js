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
import { copyChatHistory, copyChatHistoryUntil } from './persist/chat-history-persist.js';
import { createConversationForkChat } from './persist/chats-persist.js';

/**
 * @typedef {{
 *   parentChat: object,
 *   message?: string,
 *   analyze?: boolean,
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
  const clientSourceText = typeof input.sourceText === 'string' ? input.sourceText : '';
  const upToCreatedAt = typeof input.upToCreatedAt === 'string' ? input.upToCreatedAt.trim() : '';
  const partialFork = !analyze && upToCreatedAt !== '';
  const sourceText = analyze
    ? ''
    : partialFork
      ? ''
      : await resolveForkSourceText(parentChat.id, clientSourceText);
  let promptSourceText = sourceText;
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
    forkKind: analyze ? 'analyze' : undefined,
  });
  let copiedThroughSeq = 0;
  if (!analyze) {
    const copiedHistory = partialFork
      ? copyChatHistoryUntil(parentChat.id, chat.id, chat.cursorSessionId, upToCreatedAt)
      : copyChatHistory(parentChat.id, chat.id, chat.cursorSessionId);
    if (!copiedHistory.ok) {
      throw new Error(copiedHistory.error || input.copyFailedMessage || 'Failed to copy chat history');
    }
    copiedThroughSeq = Number(copiedHistory.headSeq) || 0;
    if (partialFork) {
      const cutText = formatChatHistoryEventsToText(copiedHistory.events || []);
      promptSourceText = cutText.length > 0 ? cutText : clientSourceText;
    }
  }
  appendRelatedChatHistoryLinks({
    parentChat,
    childChat: chat,
    reason: analyze ? 'analyze' : 'fork',
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
    }),
    copiedThroughSeq,
    partial: partialFork,
    analyze,
    parentChatId: parentChat.id,
  };
}
