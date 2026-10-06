/**
 * Common setter and batched publisher for `chat._pendingRemoteHistory`.
 *
 * All writers go through `setChatPendingRemoteHistoryFlag`:
 * - the history revision poll (`chatHistorySyncPoll.js`),
 * - the push inbox (`pushInbox.js`),
 * - the history convergence run (`chatHistoryConvergenceRun.js`).
 *
 * The setter updates the chat model immediately and records the value the flag
 * had *before* the first change of the current publish window. The publisher
 * compares the current value with that baseline and emits only the net
 * difference, so:
 * - a `true -> false` round trip inside one batch emits nothing,
 * - a poll that changes nothing emits nothing (also on an identical next poll),
 * - hundreds of real changes are coalesced into one UI notification per
 *   synchronous batch or animation frame.
 *
 * `undefined` and `false` are equivalent: only `=== true` means pending.
 *
 * The publisher is registered once by `initChatHistorySyncPoll` from its
 * `onPendingHistoryChange` dependency, so the poll, push inbox and convergence
 * paths share one notification path. The module is DOM-free so it unit-tests
 * under `node`; the animation frame is only an optional scheduler.
 */

import { getUiFreezeCounters, measureFreezeSpan } from '../../lib/uiFreezeCounters.js';

/**
 * @typedef {object} PendingRemoteHistoryPublishMeta
 * @property {string[]} ids chats whose net flag changed
 * @property {string[]} addedIds chats that turned pending
 * @property {string[]} removedIds chats that stopped being pending
 */

/**
 * @typedef {(changedChats: object[], meta: PendingRemoteHistoryPublishMeta) => void} PendingRemoteHistoryPublisher
 */

/** @type {PendingRemoteHistoryPublisher | null} */
let publisher = null;

/** Chats touched since the last publish. @type {Set<string>} */
const dirtyIds = new Set();
/** Chat object captured for each dirty id. @type {Map<string, object>} */
const dirtyChats = new Map();
/** Value before the first change in the current window. @type {Map<string, boolean>} */
const baselineById = new Map();

/** Explicit batch depth opened by `beginPendingRemoteHistoryBatch`. */
let batchDepth = 0;
/** A frame/timeout publish is already armed. */
let publishScheduled = false;
/** @type {ReturnType<typeof setTimeout> | number | null} */
let publishHandle = null;
/** True when `publishHandle` is a requestAnimationFrame id. */
let publishHandleIsFrame = false;

/**
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
function readPending(chat) {
  return chat?._pendingRemoteHistory === true;
}

function cancelScheduledPublish() {
  if (publishHandle == null) {
    publishScheduled = false;
    return;
  }
  if (publishHandleIsFrame && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(/** @type {number} */ (publishHandle));
  } else {
    clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (publishHandle));
  }
  publishHandle = null;
  publishHandleIsFrame = false;
  publishScheduled = false;
}

/**
 * Arms one coalesced publish. While an explicit batch is open the flush is
 * deferred to `endPendingRemoteHistoryBatch` / `flushPendingRemoteHistoryPublish`,
 * so a long synchronous pass produces exactly one notification.
 */
function schedulePublish() {
  if (publishScheduled || batchDepth > 0) return;
  publishScheduled = true;
  if (typeof requestAnimationFrame === 'function') {
    publishHandleIsFrame = true;
    publishHandle = requestAnimationFrame(() => {
      publishHandle = null;
      publishHandleIsFrame = false;
      publishScheduled = false;
      publishPendingRemoteHistoryNow();
    });
    return;
  }
  publishHandleIsFrame = false;
  publishHandle = setTimeout(() => {
    publishHandle = null;
    publishScheduled = false;
    publishPendingRemoteHistoryNow();
  }, 0);
}

/**
 * @param {object[]} changedChats
 * @param {PendingRemoteHistoryPublishMeta} meta
 */
function notifyPublisher(changedChats, meta) {
  if (changedChats.length === 0 || typeof publisher !== 'function') return;
  const counters = getUiFreezeCounters();
  if (counters) counters.bump('ui.pendingRefreshes');
  // Task 0.1: time the synchronous UI apply the pending change triggers.
  measureFreezeSpan('history.poll.apply', { changed: changedChats.length }, () => {
    publisher(changedChats, meta);
  });
}

/**
 * Publishes the net difference of the current window and clears it. Safe to
 * call at any time; a batch stays open, only the window is drained.
 */
function publishPendingRemoteHistoryNow() {
  cancelScheduledPublish();
  if (dirtyIds.size === 0) return;
  /** @type {object[]} */
  const changedChats = [];
  /** @type {string[]} */
  const ids = [];
  /** @type {string[]} */
  const addedIds = [];
  /** @type {string[]} */
  const removedIds = [];
  for (const id of dirtyIds) {
    const chat = dirtyChats.get(id);
    const before = baselineById.get(id) === true;
    const after = readPending(chat);
    if (before === after) continue;
    changedChats.push(chat);
    ids.push(id);
    if (after) addedIds.push(id);
    else removedIds.push(id);
  }
  dirtyIds.clear();
  dirtyChats.clear();
  baselineById.clear();
  notifyPublisher(changedChats, { ids, addedIds, removedIds });
}

/**
 * @param {object} chat
 * @param {boolean} previous value before this change
 * @param {string} id
 */
function markPendingDirty(chat, previous, id) {
  if (!id) {
    // No stable id: skip coalescing and publish this single object now.
    const pending = readPending(chat);
    notifyPublisher([chat], {
      ids: [],
      addedIds: pending ? ['(no-id)'] : [],
      removedIds: pending ? [] : ['(no-id)'],
    });
    return;
  }
  if (!baselineById.has(id)) baselineById.set(id, previous === true);
  dirtyIds.add(id);
  dirtyChats.set(id, chat);
  schedulePublish();
}

/**
 * Registers the UI publisher. Called once by `initChatHistorySyncPoll`; passing
 * a non-function clears it (tests, stopped poll).
 *
 * @param {PendingRemoteHistoryPublisher | null | undefined} fn
 */
export function configureChatPendingRemoteHistoryPublisher(fn) {
  publisher = typeof fn === 'function' ? fn : null;
}

/**
 * Sets `_pendingRemoteHistory` and counts a flip only on true/false transitions.
 * The model is updated synchronously; the UI notification is coalesced.
 *
 * @param {object | null | undefined} chat
 * @param {boolean} pending
 * @returns {boolean} true when the flag changed
 */
export function setChatPendingRemoteHistoryFlag(chat, pending) {
  if (!chat) return false;
  const next = pending === true;
  const previous = readPending(chat);
  if (previous === next) return false;
  chat._pendingRemoteHistory = next;
  getUiFreezeCounters()?.recordPendingFlip(next);
  markPendingDirty(chat, previous, String(chat.id || '').trim());
  return true;
}

/**
 * Opens a synchronous batch. While open, publishes are deferred so a whole
 * poll pass collapses into one notification.
 */
export function beginPendingRemoteHistoryBatch() {
  batchDepth += 1;
}

/**
 * Closes the innermost batch. The outermost close flushes the net difference.
 */
export function endPendingRemoteHistoryBatch() {
  if (batchDepth > 0) batchDepth -= 1;
  if (batchDepth === 0) publishPendingRemoteHistoryNow();
}

/**
 * Publishes the pending net difference immediately. Used before a long history
 * fetch so the badge is not delayed by the fetch.
 */
export function flushPendingRemoteHistoryPublish() {
  publishPendingRemoteHistoryNow();
}

/**
 * Test seam: drops the registered publisher, the open window and any armed flush.
 */
export function __resetChatPendingRemoteHistoryForTest() {
  cancelScheduledPublish();
  dirtyIds.clear();
  dirtyChats.clear();
  baselineById.clear();
  batchDepth = 0;
  publisher = null;
}
