/**
 * Reloads the sidebar after a server `chatsChanged` event (MCP archive,
 * CLI, another client). Debounced so a bulk archive is one GET, with a
 * max-wait ceiling so a steady frame stream cannot postpone it forever.
 * Frames that do not change the list itself (watcher state, one chat's
 * title) are handled without a `GET /api/chats` at all.
 */

const LIVE_SYNC_DEBOUNCE_MS = 150;

/** Upper bound on how long a coalesced reload may be deferred by new events. */
const LIVE_SYNC_MAX_WAIT_MS = 600;

/**
 * @param {{
 *   refresh: (query: { skipAutoSelect: boolean, includeArchived?: boolean }) => unknown,
 *   shouldIncludeArchived?: () => boolean,
 *   onTitleChanged?: (chatId: string | null) => unknown,
 *   onTitlePatched?: (chatId: string, title: string, titleSource: string) => boolean,
 *   onWatcherChanged?: () => unknown,
 *   onChatsChangedFrame?: (info: { reason?: string, chatId?: string | null }) => unknown,
 *   shouldSuppressChatsChanged?: (frame: { reason?: string, chatId?: string | null }) => boolean,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   nowFn?: () => number,
 *   debounceMs?: number,
 *   maxWaitMs?: number,
 * }} dependencies
 */
export function createChatListLiveSync({
  refresh,
  shouldIncludeArchived = () => false,
  onTitleChanged = () => {},
  // Applies one chat's new title to the local list. Return `true` when the row was found
  // and patched; anything else falls back to a full reload (unknown chat, list not loaded).
  onTitlePatched = () => false,
  onWatcherChanged = () => {},
  // Opt-in trace seam only: defaults to a no-op so the existing behaviour and
  // the chat-list-live-sync test are untouched. The caller wraps it in
  // `isUiFreezeTraceActive()`, so production does no work here.
  onChatsChangedFrame = () => {},
  shouldSuppressChatsChanged = () => false,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = () => Date.now(),
  debounceMs = LIVE_SYNC_DEBOUNCE_MS,
  maxWaitMs = LIVE_SYNC_MAX_WAIT_MS,
}) {
  let timerId = null;
  /** When the current coalescing window opened, or null while nothing is pending. */
  let windowStartedAt = null;

  function schedule() {
    const now = nowFn();
    if (windowStartedAt == null) windowStartedAt = now;
    // Trailing debounce, capped: the reload always lands within `maxWaitMs` of the first
    // event, so a bulk archive or a chatty watcher cycle cannot starve the list.
    const remaining = windowStartedAt + maxWaitMs - now;
    const wait = remaining <= 0 ? 0 : Math.min(debounceMs, remaining);
    if (timerId != null) clearTimeoutFn(timerId);
    timerId = setTimeoutFn(() => {
      timerId = null;
      windowStartedAt = null;
      const includeArchived = shouldIncludeArchived() === true;
      Promise.resolve()
        .then(() => refresh({ skipAutoSelect: true, includeArchived }))
        .catch(() => {});
    }, wait);
  }

  return {
    /**
     * @param {{
     *   reason?: string,
     *   chatId?: string | null,
     *   title?: string,
     *   titleSource?: string,
     * }} [msg] server `chatsChanged` frame
     */
    onChatsChanged(msg) {
      // Trace seam: hand the existing frame object straight through (no new
      // allocation). The wired observer guards on `isUiFreezeTraceActive()` at its
      // own callsite, so an inactive trace only pays a boolean check + no-op call.
      if (onChatsChangedFrame) {
        try {
          onChatsChangedFrame(msg || {});
        } catch (_) {}
      }
      const frame = msg || {};
      if (shouldSuppressChatsChanged(frame) === true) return;
      const reason = typeof frame.reason === 'string' ? frame.reason : '';
      const chatId = typeof frame.chatId === 'string' && frame.chatId ? frame.chatId : '';
      // Workspace watcher updates ride the same channel; panels that are not
      // part of the chat list (todo top bar, settings) refetch on this hook. The
      // watcher rewrites its own row, not the chat list, and a chat it creates or
      // pins broadcasts its own `create` frame from chats-persist.js, so the list
      // never needs a reload here.
      if (reason === 'workspace-watcher') {
        try {
          onWatcherChanged();
        } catch (_) {}
        return;
      }
      if (reason === 'title') {
        // A title change also reloads the list; the hook lets an open settings modal react
        // without clobbering text the user is typing.
        try {
          onTitleChanged(chatId || null);
        } catch (_) {}
        const title = typeof frame.title === 'string' && frame.title ? frame.title : '';
        const titleSource = typeof frame.titleSource === 'string' && frame.titleSource
          ? frame.titleSource
          : '';
        if (chatId && title && titleSource) {
          let patched = false;
          try {
            patched = onTitlePatched(chatId, title, titleSource) === true;
          } catch (_) {
            patched = false;
          }
          // One row patched in place: the whole list is already up to date.
          if (patched) return;
        }
        // No row content (older server) or a row this client does not have: reload as before.
        schedule();
        return;
      }
      // create / delete / nest / archive / unknown reason: refetch the whole list.
      schedule();
    },
    cancel() {
      windowStartedAt = null;
      if (timerId == null) return;
      clearTimeoutFn(timerId);
      timerId = null;
    },
  };
}
