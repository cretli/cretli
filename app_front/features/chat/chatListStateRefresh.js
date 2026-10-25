/**
 * Coalesced chat-list / sidebar status updates. Refreshing every chat on the
 * 12s background-WS sync used to walk the whole sidebar O(n²) on the main thread.
 */

/**
 * @param {object[] | null | undefined} chats
 * @returns {Map<string, object>}
 */
export function buildChatByIdMap(chats) {
  const map = new Map();
  if (!Array.isArray(chats)) return map;
  for (const chat of chats) {
    if (!chat?.id) continue;
    map.set(chat.id, chat);
  }
  return map;
}

/**
 * @param {string} state
 * @param {string} tone
 * @param {string} label
 * @returns {string}
 */
export function chatListVisualKey(state, tone, label) {
  return `${String(state || '')}\0${String(tone || '')}\0${String(label || '')}`;
}

/**
 * Skip DOM writes when the row already shows this status.
 *
 * @param {string | null | undefined} previousKey
 * @param {string} nextKey
 * @returns {boolean}
 */
export function shouldSkipChatListItemWrite(previousKey, nextKey) {
  return previousKey === nextKey;
}

/**
 * A chat with no socket that is already marked disconnected needs no UI work.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function shouldSkipDisconnectedBackgroundRender(chat) {
  if (!chat) return true;
  if (chat.ws) return false;
  return chat._connectionStatus === 'disconnected';
}

/**
 * @param {() => void} run
 * @param {{
 *   raf?: (cb: FrameRequestCallback) => number,
 *   caf?: (id: number) => void,
 * }} [timers]
 * @returns {{ schedule: () => void, flush: () => void, isScheduled: () => boolean }}
 */
export function createRafDebouncer(run, timers = {}) {
  const raf = typeof timers.raf === 'function'
    ? timers.raf
    : typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(cb)
      : (cb) => setTimeout(cb, 0);
  const caf = typeof timers.caf === 'function'
    ? timers.caf
    : typeof cancelAnimationFrame === 'function'
      ? (id) => cancelAnimationFrame(id)
      : (id) => clearTimeout(id);
  let handle = 0;
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    handle = raf(() => {
      scheduled = false;
      run();
    });
  }
  function flush() {
    if (!scheduled) return;
    scheduled = false;
    caf(handle);
    run();
  }
  function isScheduled() {
    return scheduled;
  }
  return { schedule, flush, isScheduled };
}
