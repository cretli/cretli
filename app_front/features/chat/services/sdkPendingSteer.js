/**
 * Steers sent from this client that the server has not acknowledged yet.
 *
 * A steer is echoed as a queued block (it may still revert to a follow-up).
 * Once the server injects it, the queued block must be promoted in place;
 * otherwise the injected user event renders a second copy of the message.
 *
 * `source` tells what happens when the server refuses the steer:
 * - `queue`  — steered from a queued block; the server keeps or re-queues it.
 * - `direct` — steered from the composer; a refused steer is not queued, so
 *   the client drops the queued echo and gives the text back to the user.
 */

const STEER_TRANSPORTS = new Set(['sdk', 'claude', 'codex']);

/**
 * Whether this chat's transport can steer at all (independent of a turn running).
 *
 * @param {any} chat
 * @returns {boolean}
 */
export function isSdkSteerCapable(chat) {
  return STEER_TRANSPORTS.has(String(chat?.agentTransport || '')) && chat?._sdkSteerSupported === true;
}

/**
 * Whether the running turn of this chat accepts a steer right now.
 *
 * @param {any} chat
 * @returns {boolean}
 */
export function canSteerSdkChat(chat) {
  return isSdkSteerCapable(chat) && chat._sdkServerBusy === true;
}

/**
 * @param {any} chat
 * @param {unknown} text
 * @param {'direct' | 'queue'} [source]
 */
export function rememberPendingSdkSteer(chat, text, source = 'direct') {
  const raw = text == null ? '' : String(text).trim();
  if (!chat || !raw) return;
  if (!Array.isArray(chat._sdkPendingSteers)) chat._sdkPendingSteers = [];
  chat._sdkPendingSteers.push({ text: raw, source: source === 'queue' ? 'queue' : 'direct' });
}

/**
 * Removes one pending steer with this text.
 *
 * @param {any} chat
 * @param {unknown} text
 * @returns {{ text: string, source: 'direct' | 'queue' } | null} the removed entry
 */
export function consumePendingSdkSteer(chat, text) {
  const raw = text == null ? '' : String(text).trim();
  const list = chat?._sdkPendingSteers;
  if (!raw || !Array.isArray(list)) return null;
  const idx = list.findIndex((entry) => entry?.text === raw);
  if (idx === -1) return null;
  return list.splice(idx, 1)[0];
}

/**
 * @param {any} chat
 * @param {string} raw
 */
function dropOptimisticQueued(chat, raw) {
  const queued = chat._sdkOptimisticSentQueued;
  if (!Array.isArray(queued)) return;
  const idx = queued.indexOf(raw);
  if (idx !== -1) queued.splice(idx, 1);
}

/**
 * Promotes the queued echo of a delivered steer to a sent user block.
 *
 * @param {any} chat
 * @param {unknown} text
 * @returns {boolean} true when the text was a pending steer
 */
export function settleDeliveredSdkSteer(chat, text) {
  const entry = consumePendingSdkSteer(chat, text);
  if (!entry) return false;
  dropOptimisticQueued(chat, entry.text);
  chat._sdkRichView?.promoteQueuedPrompt?.(entry.text);
  return true;
}

/**
 * A refused steer. Queue-sourced steers stay queued on the server; a direct
 * steer is gone, so its queued echo is removed and the text is returned.
 *
 * @param {any} chat
 * @param {unknown} text
 * @returns {string} text to give back to the user ('' when nothing to restore)
 */
export function settleRefusedSdkSteer(chat, text) {
  const entry = consumePendingSdkSteer(chat, text);
  if (!entry || entry.source !== 'direct') return '';
  dropOptimisticQueued(chat, entry.text);
  chat._sdkRichView?.removeQueuedPrompt?.(entry.text);
  return entry.text;
}
