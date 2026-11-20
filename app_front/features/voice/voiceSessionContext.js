/**
 * Current voice live session id — shared between the panel and tool executor.
 */

/** @type {string} */
let activeVoiceSessionId = '';

/**
 * @returns {string}
 */
export function getActiveVoiceSessionId() {
  return activeVoiceSessionId;
}

/**
 * @param {string} sessionId
 * @returns {void}
 */
export function setActiveVoiceSessionId(sessionId) {
  activeVoiceSessionId = String(sessionId || '').trim();
}

/**
 * @returns {void}
 */
export function clearActiveVoiceSessionId() {
  activeVoiceSessionId = '';
}
