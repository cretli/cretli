/**
 * Debounced live fan-out for a server-side `todo.review` snapshot change
 * (`docs/todo-review-contract.md` §10.4, U7).
 *
 * The durable snapshot writer (`lib/todo-review-sync-hooks.js`) reports
 * `changed: true` only when the decision key actually moved. This module turns
 * that into one identifier-only frame on the existing chat-list channel:
 *
 *   - a burst of writes for the same `(workspace, todo)` coalesces into one
 *     frame per debounce window;
 *   - no frame is scheduled when the snapshot is unchanged (the writer returns
 *     `changed: false`) or when nobody is subscribed, so tests and headless
 *     runs schedule no timer;
 *   - the frame never carries report content, only `workspaceFolder` + `todoId`.
 *
 * Emission is fire-and-forget: a failed broadcast must never break a
 * delegation transition (`lib/chat-list-updates.js` already guards send).
 */

import { broadcastTodoReviewChanged, hasChatListSubscribers } from './chat-list-updates.js';

/** Coalescing window; short enough to feel live, long enough to merge a burst. */
const DEFAULT_DEBOUNCE_MS = 50;

/** @type {Map<string, { workspaceFolder: string, todoId: string }>} */
const pending = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;
let debounceMs = DEFAULT_DEBOUNCE_MS;

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Override the debounce window (tests / deployment knob). A negative or
 * non-finite value is ignored.
 *
 * @param {number} ms
 * @returns {void}
 */
export function setTodoReviewLiveDebounceMs(ms) {
  const value = Number(ms);
  if (Number.isFinite(value) && value >= 0) debounceMs = Math.floor(value);
}

/**
 * @param {string} workspaceFolder
 * @param {string} todoId
 * @returns {string}
 */
function pendingKey(workspaceFolder, todoId) {
  return `${workspaceFolder}\u0000${todoId}`;
}

/**
 * Schedule a todo-review refresh frame for one logical workspace + leaf.
 * Returns `true` when a frame was scheduled, `false` when there was nothing to
 * announce (no subscribers) or the target was incomplete.
 *
 * @param {{ workspaceFolder?: string, todoId?: string, reason?: string }} input
 * @returns {boolean}
 */
export function emitTodoReviewChanged(input = {}) {
  const workspaceFolder = asText(input.workspaceFolder);
  const todoId = asText(input.todoId);
  if (!workspaceFolder || !todoId) return false;
  if (!hasChatListSubscribers()) return false;
  pending.set(pendingKey(workspaceFolder, todoId), { workspaceFolder, todoId });
  if (timer) return true;
  timer = setTimeout(() => {
    timer = null;
    flushTodoReviewLiveChanges();
  }, debounceMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return true;
}

/**
 * Emit every coalesced change now.
 *
 * @returns {number} number of frames emitted
 */
export function flushTodoReviewLiveChanges() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const targets = [...pending.values()];
  pending.clear();
  for (const target of targets) {
    broadcastTodoReviewChanged({
      reason: 'review',
      workspaceFolder: target.workspaceFolder,
      todoId: target.todoId,
    });
  }
  return targets.length;
}

/**
 * Drop every coalesced change without emitting (tests / shutdown isolation).
 *
 * @returns {number} number of dropped targets
 */
export function clearTodoReviewLiveChanges() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const count = pending.size;
  pending.clear();
  return count;
}

/**
 * @returns {number}
 */
export function pendingTodoReviewLiveChangeCount() {
  return pending.size;
}
