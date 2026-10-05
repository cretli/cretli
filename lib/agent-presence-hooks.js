/**
 * Tiny registry so persist / rooms can mark presence dirty without import cycles.
 */

/** @type {((chatIds?: string[]) => void) | null} */
let dirtyHandler = null;

/** @type {((chatIds?: string[]) => void) | null} */
let watcherNudgeHandler = null;

/** @type {Map<string, { activityKey: string, activityArg: string }>} */
const activityByChatId = new Map();

/**
 * @param {(chatIds?: string[]) => void} handler
 * @returns {void}
 */
export function setAgentPresenceDirtyHandler(handler) {
  dirtyHandler = typeof handler === 'function' ? handler : null;
}

/**
 * Optional side channel for workspace watcher autopilot nudges on chat run changes.
 *
 * @param {(chatIds?: string[]) => void} handler
 * @returns {void}
 */
export function registerWorkspaceWatcherPresenceNudge(handler) {
  watcherNudgeHandler = typeof handler === 'function' ? handler : null;
}

/**
 * @param {string[] | undefined} chatIds
 * @returns {void}
 */
export function markAgentPresenceDirty(chatIds) {
  if (typeof dirtyHandler === 'function') dirtyHandler(chatIds);
  if (typeof watcherNudgeHandler === 'function') watcherNudgeHandler(chatIds);
}

/**
 * @param {string} chatId
 * @param {{ activityKey: string, activityArg?: string } | null | undefined} activity
 * @returns {void}
 */
export function setChatPresenceActivity(chatId, activity) {
  const id = String(chatId || '').trim();
  if (!id) return;
  const key = typeof activity?.activityKey === 'string' ? activity.activityKey.trim() : '';
  if (!key) {
    activityByChatId.delete(id);
    return;
  }
  activityByChatId.set(id, {
    activityKey: key,
    activityArg: typeof activity.activityArg === 'string' ? activity.activityArg : '',
  });
}

/**
 * @param {string} chatId
 * @returns {void}
 */
export function clearChatPresenceActivity(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  activityByChatId.delete(id);
}

/**
 * @param {string} chatId
 * @returns {{ activityKey: string, activityArg: string } | null}
 */
export function getChatPresenceActivity(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return activityByChatId.get(id) || null;
}

/**
 * Tests only.
 * @returns {void}
 */
export function __resetAgentPresenceHooksForTest() {
  dirtyHandler = null;
  watcherNudgeHandler = null;
  activityByChatId.clear();
}
