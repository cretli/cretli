/**
 * Per-chat "no spoken version" hint of the read-aloud button (`agent` read mode).
 *
 * The speaker reports `{ chatId, turn, missing }`; a send bar only reacts for its own
 * chat, and the click reads the full answer of exactly the turn that was flagged.
 */

import { VOICE_REPLY_MISSING_EVENT, getChatSpeaker } from './chatSpeaker.js';

/**
 * @param {{
 *   getChatId: () => string,
 *   onChange: () => void,
 *   speaker?: ReturnType<typeof getChatSpeaker>,
 *   target?: { addEventListener: Function } | null,
 * }} options
 * @returns {{ isMissing: () => boolean, clear: () => void, handleClick: () => boolean }}
 */
export function createVoiceReplyHint({ getChatId, onChange, speaker, target = typeof window === 'undefined' ? null : window }) {
  /** @type {{ chatId: string, turn: string } | null} */
  let flagged = null;

  target?.addEventListener(VOICE_REPLY_MISSING_EVENT, (event) => {
    const detail = /** @type {any} */ (event).detail || {};
    const chatId = String(getChatId() || '');
    if (!chatId || detail.chatId !== chatId) return;
    if (detail.missing === false) {
      if (flagged && (!detail.turn || flagged.turn === detail.turn)) flagged = null;
      else return;
    } else {
      flagged = { chatId, turn: String(detail.turn || '') };
    }
    onChange();
  });

  return {
    isMissing: () => flagged !== null && flagged.chatId === String(getChatId() || ''),
    clear() {
      flagged = null;
    },
    /** @returns {boolean} true when the click was consumed by the hint */
    handleClick() {
      if (!flagged || flagged.chatId !== String(getChatId() || '')) return false;
      const { chatId, turn } = flagged;
      flagged = null;
      (speaker || getChatSpeaker()).speakMissingTurnAnswer(chatId, turn, 'voice-reply-missing');
      onChange();
      return true;
    },
  };
}
