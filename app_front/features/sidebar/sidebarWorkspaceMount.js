/**
 * Mount boundary helpers for `<cr-sidebar-workspace>` (stage 6.4).
 */

import { getSidebarWorkspaceRegistration } from './sidebarWorkspacePass.js';
import { hydrateSidebarChatRowHosts } from './sidebarChatRowMount.js';

/** @type {WeakMap<Element, import('./sidebarWorkspaceModel.js').SidebarWorkspaceRegistration>} */
const hostPayload = new WeakMap();

/**
 * @param {Element} host
 * @returns {import('./sidebarWorkspaceModel.js').SidebarWorkspaceRegistration | null}
 */
export function readSidebarWorkspacePayloadFromHost(host) {
  if (!host) return null;
  const key = String(host.getAttribute?.('sidebar-key') || '').trim();
  if (key) {
    const reg = getSidebarWorkspaceRegistration(key);
    if (reg) return reg;
  }
  return hostPayload.get(host) || null;
}

/**
 * @param {Element} host
 */
export function stashSidebarWorkspacePayloadOnHost(host) {
  if (!host) return;
  const key = String(host.getAttribute?.('sidebar-key') || '').trim();
  if (!key) return;
  const reg = getSidebarWorkspaceRegistration(key);
  if (reg) hostPayload.set(host, reg);
}

/**
 * @param {Element} host
 */
export function clearSidebarWorkspacePayloadFromHost(host) {
  if (host) hostPayload.delete(host);
}

/**
 * @param {Element} host
 */
export function requestSidebarWorkspaceUpdate(host) {
  if (!host) return;
  stashSidebarWorkspacePayloadOnHost(host);
  if (typeof customElements !== 'undefined' && typeof customElements.upgrade === 'function') {
    customElements.upgrade(host);
  }
  if (typeof host.requestUpdate === 'function') {
    host.requestUpdate();
  }
}

/**
 * @param {ParentNode | null | undefined} root
 */
export function hydrateSidebarWorkspaceHosts(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const hosts = root.querySelectorAll('cr-sidebar-workspace');
  hosts.forEach((host) => {
    requestSidebarWorkspaceUpdate(host);
    hydrateSidebarChatRowHosts(host);
  });
  hydrateSidebarChatRowHosts(root);
}

/**
 * Create a workspace host element for reconcile (no innerHTML template parse).
 *
 * @param {string} sidebarKey
 * @returns {HTMLElement | null}
 */
export function createSidebarWorkspaceHostElement(sidebarKey) {
  const key = String(sidebarKey || '').trim();
  if (!key || typeof document === 'undefined') return null;
  const host = document.createElement('cr-sidebar-workspace');
  host.setAttribute('sidebar-key', key);
  requestSidebarWorkspaceUpdate(host);
  return host;
}

/**
 * Wait until Lit workspace/row/group hosts under `root` finish their update cycle.
 *
 * @param {ParentNode | null | undefined} root
 */
export async function waitForSidebarLitHostsCommit(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  /** @type {Promise<unknown>[]} */
  const waits = [];
  const withUpdateComplete = root.querySelectorAll(
    'cr-sidebar-workspace, cr-sidebar-chat-row, cr-sidebar-subchat-group, cr-sidebar-archive-group',
  );
  withUpdateComplete.forEach((el) => {
    if (el && typeof el.updateComplete !== 'undefined') {
      waits.push(el.updateComplete);
    }
  });
  if (waits.length) await Promise.all(waits);
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
