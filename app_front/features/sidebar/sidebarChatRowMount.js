/**
 * Mount boundary helpers for `<cr-sidebar-chat-row>` inside workspace lists (stage 6.3).
 */

import { getSidebarChatRowRegistration } from './sidebarChatRowPass.js';

/** @type {WeakMap<Element, import('./sidebarChatRowPass.js').SidebarChatRowRegistration>} */
const hostPayload = new WeakMap();

/**
 * @param {Element} host
 * @returns {import('./sidebarChatRowPass.js').SidebarChatRowRegistration | null}
 */
export function readSidebarChatRowPayloadFromHost(host) {
  if (!host) return null;
  const id = String(host.getAttribute?.('chat-id') || '').trim();
  if (id) {
    const reg = getSidebarChatRowRegistration(id);
    if (reg) return reg;
  }
  return hostPayload.get(host) || null;
}

/**
 * @param {Element} host
 */
export function stashSidebarChatRowPayloadOnHost(host) {
  if (!host) return;
  const id = String(host.getAttribute?.('chat-id') || '').trim();
  if (!id) return;
  const reg = getSidebarChatRowRegistration(id);
  if (reg) hostPayload.set(host, reg);
}

/**
 * @param {Element} host
 */
export function clearSidebarChatRowPayloadFromHost(host) {
  if (host) hostPayload.delete(host);
}

/**
 * Nudge mounted `<cr-sidebar-chat-row>` hosts to render the inner `<li>` contract.
 *
 * @param {ParentNode | null | undefined} root
 */
export function hydrateSidebarChatRowHosts(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const hosts = root.querySelectorAll('cr-sidebar-chat-row');
  hosts.forEach((host) => {
    stashSidebarChatRowPayloadOnHost(host);
    if (typeof customElements !== 'undefined' && typeof customElements.upgrade === 'function') {
      customElements.upgrade(host);
    }
    if (host && typeof host.requestUpdate === 'function') {
      host.requestUpdate();
    }
  });
}
