/**
 * Browser session visibility along the chat fork chain.
 *
 * A Browser session bound to a parent chat may be used by delegation/fork
 * children on the forkParentChatId chain (same depth cap as MCP owner lookup).
 */

import { loadChatsAsync } from '../persist/chats-persist.js';

/** Matches lib/mcp/builtin/browser-tools.js owner walk depth. */
export const MAX_BROWSER_CHAT_ANCESTRY_DEPTH = 4;

/**
 * @param {string} chatId
 * @param {any[]} [chats]
 * @returns {string[]}
 */
export function listBrowserFamilyChatIds(chatId, chats) {
  const ids = [];
  let current = String(chatId || '').trim();
  for (let depth = 0; current && depth <= MAX_BROWSER_CHAT_ANCESTRY_DEPTH; depth += 1) {
    ids.push(current);
    const row = chats.find((entry) => entry?.id === current);
    current = String(row?.forkParentChatId || '').trim();
  }
  return ids;
}

/**
 * @param {string} callingChatId
 * @param {string} boundChatId
 * @param {any[]} [chats]
 * @returns {boolean}
 */
export function isBrowserSessionVisibleToChat(callingChatId, boundChatId, chats) {
  const bound = String(boundChatId || '').trim();
  if (!bound) return true;
  return listBrowserFamilyChatIds(callingChatId, chats).includes(bound);
}

/**
 * @param {string} callingChatId
 * @param {string | null | undefined} sessionChatId
 * @param {any[]} [chats]
 * @returns {{ binding: 'own' | 'ancestor' | 'unbound', ancestorChatId: string | null } | null}
 */
export function classifyBrowserSessionBinding(callingChatId, sessionChatId, chats) {
  const bound = String(sessionChatId || '').trim();
  const caller = String(callingChatId || '').trim();
  if (!bound) return { binding: 'unbound', ancestorChatId: null };
  if (bound === caller) return { binding: 'own', ancestorChatId: null };
  if (listBrowserFamilyChatIds(caller, chats).includes(bound)) {
    return { binding: 'ancestor', ancestorChatId: bound };
  }
  return null;
}

/**
 * @param {{ resolveChatBinding: (chatId: string) => { browserSessionId?: string, chatId?: string } | null }} manager
 * @param {string} callingChatId
 * @param {any[]} [chats]
 * @returns {{ browserSessionId: string, chatId: string, fromChatId: string } | null}
 */
export function resolveChatBindingOnFamily(manager, callingChatId, chats) {
  for (const id of listBrowserFamilyChatIds(callingChatId, chats)) {
    const binding = manager.resolveChatBinding(id);
    if (binding?.browserSessionId) {
      return {
        browserSessionId: binding.browserSessionId,
        chatId: String(binding.chatId || id),
        fromChatId: id,
      };
    }
  }
  return null;
}

// Async entry points: read the chat list through the chats runtime, then apply the pure rules above.

/** @param {string} callingChatId @param {string} boundChatId @returns {Promise<boolean>} */
export async function isBrowserSessionVisibleToChatAsync(callingChatId, boundChatId) {
  if (!String(boundChatId || '').trim()) return true;
  return isBrowserSessionVisibleToChat(callingChatId, boundChatId, await loadChatsAsync());
}

/**
 * @param {string} callingChatId
 * @param {string | null | undefined} sessionChatId
 * @returns {Promise<ReturnType<typeof classifyBrowserSessionBinding>>}
 */
export async function classifyBrowserSessionBindingAsync(callingChatId, sessionChatId) {
  return classifyBrowserSessionBinding(callingChatId, sessionChatId, await loadChatsAsync());
}

/**
 * @param {Parameters<typeof resolveChatBindingOnFamily>[0]} manager
 * @param {string} callingChatId
 * @returns {Promise<ReturnType<typeof resolveChatBindingOnFamily>>}
 */
export async function resolveChatBindingOnFamilyAsync(manager, callingChatId) {
  return resolveChatBindingOnFamily(manager, callingChatId, await loadChatsAsync());
}
