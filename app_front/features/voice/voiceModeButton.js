/**
 * Header button that opens voice mode (realtime talk with the agent).
 * Voice mode drives the whole app, not a single chat, so it sits next to the
 * connection indicator instead of the chat send bar options row.
 */

import { t } from '../../i18n/index.js';
import { isOpenAiKeyConfigured } from './openAiKeyStatus.js';
import { isGeminiKeyConfigured } from './geminiKeyStatus.js';
import { VOICE_SESSION_EVENT, isVoiceSessionActive } from './voiceSessionState.js';

const BUTTON_ID = 'header-voice-mode-btn';

/**
 * @param {HTMLButtonElement} button
 * @returns {void}
 */
function syncButton(button) {
  const active = isVoiceSessionActive();
  button.classList.toggle('is-live', active);
  button.setAttribute('aria-label', t('voice.realtimeOpen'));
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  // A live session must stay reachable even when its panel is hidden.
  if (active) {
    button.disabled = false;
    button.title = t('voice.realtimeLiveTitle');
    return;
  }
  void Promise.all([isOpenAiKeyConfigured(), isGeminiKeyConfigured()]).then(
    ([openAiReady, geminiReady]) => {
      const configured = openAiReady || geminiReady;
      button.disabled = !configured && !isVoiceSessionActive();
      button.title = configured ? t('voice.realtimeTitle') : t('voice.noKey');
    }
  );
}

/**
 * Wires the header voice mode button (once after DOM is ready).
 *
 * @returns {void}
 */
export function initVoiceModeButton() {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById(BUTTON_ID));
  if (!button) return;
  syncButton(button);
  button.addEventListener('click', async () => {
    // The panel pulls in WebRTC and the tool layer; load it only when asked for.
    try {
      const module = await import('../../components/chat/cr-voice-panel.js');
      module.openVoiceModePanel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      button.title = message;
      button.setAttribute('aria-label', message);
    }
  });
  if (typeof window === 'undefined') return;
  window.addEventListener(VOICE_SESSION_EVENT, () => syncButton(button));
  window.addEventListener('cr-lang-changed', () => syncButton(button));
  window.addEventListener('cretli-openai-key-changed', () => syncButton(button));
  window.addEventListener('cretli-gemini-key-changed', () => syncButton(button));
}
