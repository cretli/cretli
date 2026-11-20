/**
 * Refreshes the chat list after the page becomes visible again (mobile PWA
 * resume). The resume path in chatTransport only reconnects the active chat,
 * so chats created elsewhere while the page was hidden (another device,
 * widget, agent run) stayed invisible until the next explicit action that
 * reloads the list.
 */

const RESUME_SYNC_DEFER_MS = 1200;

/**
 * State machine for the resume refresh. Tests can inject timer fakes.
 *
 * @param {{
 *   refresh: (query: { skipAutoSelect: boolean }) => unknown,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   deferMs?: number,
 * }} dependencies
 */
export function createChatListResumeSync({
  refresh,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  deferMs = RESUME_SYNC_DEFER_MS,
}) {
  let armed = false;
  let timerId = null;

  function trigger() {
    if (!armed) return;
    armed = false;
    if (timerId != null) clearTimeoutFn(timerId);
    timerId = setTimeoutFn(() => {
      timerId = null;
      Promise.resolve()
        .then(() => refresh({ skipAutoSelect: true }))
        .catch(() => {});
    }, deferMs);
  }

  return {
    onHidden() {
      armed = true;
    },
    onVisible() {
      trigger();
    },
    onPageshow(persisted) {
      if (!persisted) return;
      armed = true;
      trigger();
    },
    cancel() {
      if (timerId != null) clearTimeoutFn(timerId);
      timerId = null;
      armed = false;
    },
  };
}

/**
 * @param {{
 *   refresh: (query: { skipAutoSelect: boolean }) => unknown,
 *   deferMs?: number,
 * }} dependencies
 */
export function initChatListResumeSync(dependencies) {
  const sync = createChatListResumeSync(dependencies);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) sync.onHidden();
      else sync.onVisible();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', (event) => sync.onPageshow(event?.persisted === true));
  }
  return sync;
}
