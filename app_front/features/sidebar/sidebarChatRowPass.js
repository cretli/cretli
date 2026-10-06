/**
 * Render-pass registry for `<cr-sidebar-chat-row>` (stage 6.3 mount boundary).
 * Legacy sidebar HTML emits hosts only; row payload is registered for the same pass.
 *
 * Payloads survive `endSidebarChatRowPass()` so Lit 3.x async first updates still
 * resolve registration after the synchronous sidebar render pass ends.
 */

/** @typedef {object} SidebarChatRowRegistration
 * @property {object} chat
 * @property {string} activeChatId
 * @property {object} opts
 * @property {object} deps
 */

/** @type {Map<string, SidebarChatRowRegistration>} */
const payloadByChatId = new Map();

/** @type {Set<string> | null} */
let passChatIds = null;

export function beginSidebarChatRowPass() {
  passChatIds = new Set();
}

export function endSidebarChatRowPass() {
  if (passChatIds) {
    for (const id of payloadByChatId.keys()) {
      if (!passChatIds.has(id)) payloadByChatId.delete(id);
    }
  }
  passChatIds = null;
}

/**
 * @param {string} chatId
 * @param {SidebarChatRowRegistration} payload
 */
export function registerSidebarChatRow(chatId, payload) {
  const id = String(chatId || '').trim();
  if (!id || !passChatIds) return;
  payloadByChatId.set(id, payload);
  passChatIds.add(id);
}

/**
 * Register a row payload outside the sidebar render pass (archive virtual scroll).
 * Survives until the next `endSidebarChatRowPass()` unless the id is re-added to the pass.
 *
 * @param {string} chatId
 * @param {SidebarChatRowRegistration} payload
 */
export function registerSidebarChatRowDirect(chatId, payload) {
  const id = String(chatId || '').trim();
  if (!id || !payload) return;
  payloadByChatId.set(id, payload);
  if (passChatIds) passChatIds.add(id);
}

/**
 * @param {string} chatId
 * @returns {SidebarChatRowRegistration | null}
 */
export function getSidebarChatRowRegistration(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return payloadByChatId.get(id) || null;
}

/** @param {string} chatId */
export function clearSidebarChatRowRegistration(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  payloadByChatId.delete(id);
}

/** Test-only reset. */
export function __resetSidebarChatRowPassForTest() {
  payloadByChatId.clear();
  passChatIds = null;
}
