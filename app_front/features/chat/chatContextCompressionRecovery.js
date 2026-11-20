import { SUMMARY_FORK_TIMEOUT_MS } from '../../config.js';
import { t } from '../../i18n/index.js';

/** Max wait for context compression before force-unblocking the chat. */
export const CONTEXT_COMPRESSION_WATCHDOG_MS = SUMMARY_FORK_TIMEOUT_MS + 30000;

/**
 * @typedef {{
 *   setAgentState?: (chat: object, state: string) => void,
 *   ensureChatConnection?: (chat: object) => void,
 *   syncBackgroundChatConnections?: () => void,
 *   forceReconnectChat?: (chat: object) => void,
 *   appLogger?: { log?: (...args: unknown[]) => void },
 * }} ChatContextCompressionRecoveryDeps
 */

/** @type {ChatContextCompressionRecoveryDeps | null} */
let deps = null;

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const watchdogTimers = new Map();

/**
 * @param {ChatContextCompressionRecoveryDeps} dependencies
 */
export function initChatContextCompressionRecovery(dependencies) {
  deps = dependencies;
}

/**
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isPendingContextCompressionChat(chat) {
  if (!chat?.id) return false;
  return chat._contextCompressionRunning === true || chat._autoContextCompressionPending === true;
}

/**
 * @param {object | null | undefined} chat
 */
export function clearContextCompressionFlags(chat) {
  if (!chat) return;
  chat._contextCompressionRunning = false;
  chat._autoContextCompressionPending = false;
}

/**
 * @param {object | null | undefined} chat
 */
export function disarmContextCompressionWatchdog(chat) {
  if (!chat?.id) return;
  const timerId = watchdogTimers.get(chat.id);
  if (!timerId) return;
  clearTimeout(timerId);
  watchdogTimers.delete(chat.id);
}

/**
 * @param {object | null | undefined} chat
 */
export function armContextCompressionWatchdog(chat) {
  if (!chat?.id || !deps) return;
  disarmContextCompressionWatchdog(chat);
  const chatId = chat.id;
  const timerId = setTimeout(() => {
    watchdogTimers.delete(chatId);
    if (chat._contextCompressionRunning !== true) return;
    recoverChatAfterCompressionFailure(chat, 'compression_watchdog_timeout');
  }, CONTEXT_COMPRESSION_WATCHDOG_MS);
  watchdogTimers.set(chatId, timerId);
}

/**
 * Resets client-side transport state after summary/compression failure so the chat accepts prompts again.
 *
 * @param {object | null | undefined} chat
 * @param {string} reason
 */
export function recoverChatAfterCompressionFailure(chat, reason) {
  if (!chat || !deps) return;
  clearContextCompressionFlags(chat);
  disarmContextCompressionWatchdog(chat);
  chat._sdkServerBusy = false;
  chat._sdkServerQueuedCount = 0;
  if (typeof deps.setAgentState === 'function') {
    deps.setAgentState(chat, 'idle');
  }
  if (typeof deps.syncBackgroundChatConnections === 'function') {
    deps.syncBackgroundChatConnections();
  }
  if (typeof deps.forceReconnectChat === 'function') {
    deps.forceReconnectChat(chat);
  } else if (typeof deps.ensureChatConnection === 'function') {
    deps.ensureChatConnection(chat);
  }
  deps.appLogger?.log?.('chat-compression-recovery', reason, { chatId: chat.id });
  chat._sdkRichView?.appendMetaNotice?.(t('chatUi.compressionRecoveryNotice'));
}
