/**
 * Browser session visibility along the chat fork chain.
 *
 * A Browser session bound to a parent chat may be used by delegation/fork
 * children on the forkParentChatId chain (same depth cap as MCP owner lookup).
 */

import { loadChats } from '../persist/chats-persist.js';

/** Matches lib/mcp/builtin/browser-tools.js owner walk depth. */
export const MAX_BROWSER_CHAT_ANCESTRY_DEPTH = 4;

/**
 * @param {string} chatId
 * @param {object[]} [chats]
 * @returns {string[]}
 */
export function listBrowserFamilyChatIds(chatId, chats = loadChats()) {
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
 * @param {object[]} [chats]
 * @returns {boolean}
 */
export function isBrowserSessionVisibleToChat(callingChatId, boundChatId, chats = loadChats()) {
  const bound = String(boundChatId || '').trim();
  if (!bound) return true;
  return listBrowserFamilyChatIds(callingChatId, chats).includes(bound);
}

/**
 * @param {string} callingChatId
 * @param {string | null | undefined} sessionChatId
 * @param {object[]} [chats]
 * @returns {{ binding: 'own' | 'ancestor' | 'unbound', ancestorChatId: string | null } | null}
 */
export function classifyBrowserSessionBinding(callingChatId, sessionChatId, chats = loadChats()) {
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
 * @param {object[]} [chats]
 * @returns {{ browserSessionId: string, chatId: string, fromChatId: string } | null}
 */
export function resolveChatBindingOnFamily(manager, callingChatId, chats = loadChats()) {
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
