/**
 * Pure helpers for workspace drag when list children are Lit hosts (`display:contents`).
 */

import {
  collectWorkspaceHostsFromList,
  readWorkspaceKeyFromListNode,
  sidebarWorkspaceListHostOf,
} from './sidebarWorkspaceOrder.js';

export { collectWorkspaceHostsFromList, readWorkspaceKeyFromListNode, sidebarWorkspaceListHostOf };

/**
 * Workspace group header hit target → list child to move (host or legacy li).
 *
 * @param {Element | null | undefined} header
 * @returns {HTMLElement | null}
 */
export function resolveWorkspaceDragHostFromHeader(header) {
  if (!(header instanceof HTMLElement)) return null;
  const li = header.closest('.sidebar-workspace');
  if (!(li instanceof HTMLElement)) return null;
  return sidebarWorkspaceListHostOf(li);
}
