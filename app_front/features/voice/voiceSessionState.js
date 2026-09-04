/**
 * Live status of the realtime voice session, shared between the voice panel and
 * the header button. The panel is a lazy chunk and can be hidden while the
 * conversation keeps running, so the status cannot live inside it.
 */

/** Fired on window whenever the voice session status changes. */
export const VOICE_SESSION_EVENT = 'cr-voice-session-status';

/** @type {'idle'|'connecting'|'live'|'closing'|'error'} */
let sessionStatus = 'idle';
let sessionUsd = 0;

/**
 * @returns {string}
 */
export function getVoiceSessionStatus() {
  return sessionStatus;
}

/**
 * @returns {boolean}
 */
export function isVoiceSessionActive() {
  return sessionStatus === 'connecting' || sessionStatus === 'live';
}

/**
 * Estimated Live-session cost in USD, updated as usage arrives.
 *
 * @returns {number}
 */
export function getVoiceSessionUsd() {
  return sessionUsd;
}

/**
 * @param {number} usd
 * @returns {void}
 */
export function setVoiceSessionUsd(usd) {
  const next = Number(usd);
  sessionUsd = Number.isFinite(next) && next > 0 ? next : 0;
}

/**
 * @param {string} status
 * @returns {void}
 */
export function setVoiceSessionStatus(status) {
  const next = /** @type {typeof sessionStatus} */ (status || 'idle');
  if (next === sessionStatus) return;
  sessionStatus = next;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(VOICE_SESSION_EVENT, { detail: { status: next } }));
}
