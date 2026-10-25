/**
 * Per-row sidebar status patch notifications (todo stage 6.3).
 * `chat.js` dispatches after coalescing dirty ids; Lit row hosts subscribe by chat id.
 */

/** @typedef {{ dirty: Set<string>, all: boolean, chatById: Map<string, object>, getSidebarChatStateMeta?: (chat: object) => object }} SidebarChatRowStatusPatchEvent */

/** @type {Set<(event: SidebarChatRowStatusPatchEvent) => void>} */
const listeners = new Set();

/**
 * @param {(event: SidebarChatRowStatusPatchEvent) => void} listener
 * @returns {() => void}
 */
export function subscribeSidebarChatRowStatusPatch(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** @param {SidebarChatRowStatusPatchEvent} event */
export function dispatchSidebarChatRowStatusPatch(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (_) {
      /* advisory */
    }
  }
}

/** @returns {number} */
export function __getSidebarChatRowStatusPatchListenerCountForTest() {
  return listeners.size;
}
