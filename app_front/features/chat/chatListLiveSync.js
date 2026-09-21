/**
 * Reloads the sidebar after a server `chatsChanged` event (MCP archive,
 * CLI, another client). Debounced so a bulk archive is one GET.
 */

const LIVE_SYNC_DEBOUNCE_MS = 150;

/**
 * @param {{
 *   refresh: (query: { skipAutoSelect: boolean, includeArchived?: boolean }) => unknown,
 *   shouldIncludeArchived?: () => boolean,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   debounceMs?: number,
 * }} dependencies
 */
export function createChatListLiveSync({
  refresh,
  shouldIncludeArchived = () => false,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  debounceMs = LIVE_SYNC_DEBOUNCE_MS,
}) {
  let timerId = null;

  function schedule() {
    if (timerId != null) clearTimeoutFn(timerId);
    timerId = setTimeoutFn(() => {
      timerId = null;
      const includeArchived = shouldIncludeArchived() === true;
      Promise.resolve()
        .then(() => refresh({ skipAutoSelect: true, includeArchived }))
        .catch(() => {});
    }, debounceMs);
  }

  return {
    onChatsChanged() {
      schedule();
    },
    cancel() {
      if (timerId == null) return;
      clearTimeoutFn(timerId);
      timerId = null;
    },
  };
}
