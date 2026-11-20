/**
 * Live status of the realtime voice session, shared between the voice panel and
 * the header button. The panel is a lazy chunk and can be hidden while the
 * conversation keeps running, so the status cannot live inside it.
 */

import { signal } from '@lit-labs/signals';

/** @type {import('@lit-labs/signals').Signal.State<'idle'|'connecting'|'live'|'closing'|'error'>} */
export const voiceSessionStatus = signal('idle');
let sessionUsd = 0;

/**
 * @returns {string}
 */
export function getVoiceSessionStatus() {
  return voiceSessionStatus.get();
}

/**
 * @returns {boolean}
 */
export function isVoiceSessionActive() {
  return ['connecting', 'live'].includes(voiceSessionStatus.get());
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
  const next = /** @type {ReturnType<typeof voiceSessionStatus.get>} */ (status || 'idle');
  voiceSessionStatus.set(next);
}
