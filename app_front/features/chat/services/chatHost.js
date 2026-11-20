/**
 * Late-bound bridge to chat.js internals for modules split out of it. chat.js
 * registers its remaining functions/constants once at the end of its module
 * evaluation; callers only read members inside functions, never at import time.
 */
export const chatHost = {};

/** @param {Record<string, any>} members */
export function registerChatHost(members) {
  Object.assign(chatHost, members);
}
