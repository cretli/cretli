import { configurationState, subscribe } from '../../state/index.js';
/**
 * Header button that opens voice mode (realtime talk with the agent).
 * Voice mode drives the whole app, not a single chat, so it sits next to the
 * connection indicator instead of the chat send bar options row.
 */

import { t } from '../../i18n/index.js';
import { isOpenAiKeyConfigured } from './openAiKeyStatus.js';
import { isGeminiKeyConfigured } from './geminiKeyStatus.js';
import { voiceSessionStatus, isVoiceSessionActive } from './voiceSessionState.js';
import { isBrowserSpeechAvailable } from './browserSpeechInput.js';
import { browserVoiceState } from './browserVoiceState.js';
import { initCarModeButton } from '../car/carModeButton.js';

const BUTTON_ID = 'header-voice-mode-btn';

/**
 * @param {HTMLButtonElement} button
 * @returns {void}
 */
function syncButton(button) {
  const browserActive = browserVoiceState.get().active;
  const active = isVoiceSessionActive() || browserActive;
  button.classList.toggle('is-live', active);
  button.setAttribute('aria-label', t('voice.realtimeOpen'));
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  if (browserActive) {
    button.disabled = false;
    button.title = t('voice.browser.stopTitle');
    return;
  }
  // A live session must stay reachable even when its panel is hidden.
  if (active) {
    button.disabled = false;
    button.title = t('voice.realtimeLiveTitle');
    return;
  }
  void Promise.all([isOpenAiKeyConfigured(), isGeminiKeyConfigured()]).then(
    ([openAiReady, geminiReady]) => {
      const configured = openAiReady || geminiReady;
      // Without a provider key the browser's own speech recognition takes over.
      const browserReady = !configured && isBrowserSpeechAvailable();
      button.disabled = !configured && !browserReady && !isVoiceSessionActive();
      button.title = configured
        ? t('voice.realtimeTitle')
        : browserReady ? t('voice.browser.title') : t('voice.noKey');
    }
  );
}

/**
 * @param {HTMLButtonElement} button
 * @returns {Promise<void>}
 */
async function startBrowserVoice(button) {
  try {
    const [{ getBrowserVoiceMode }, { ensureVoiceListenBar }] = await Promise.all([
      import('./browserVoiceMode.js'),
      import('./cr-voice-listen-bar.js'),
    ]);
    ensureVoiceListenBar();
    getBrowserVoiceMode().toggle();
  } catch (error) {
    button.title = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Wires the header voice mode button (once after DOM is ready).
 *
 * @returns {void}
 */
export function initVoiceModeButton() {
  // The car view button sits next to this one and shares its boot hook.
  initCarModeButton();
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById(BUTTON_ID));
  if (!button) return;
  syncButton(button);
  button.addEventListener('click', async () => {
    if (browserVoiceState.get().active) {
      const { getBrowserVoiceMode } = await import('./browserVoiceMode.js');
      getBrowserVoiceMode().stop();
      return;
    }
    const [openAiReady, geminiReady] = await Promise.all([isOpenAiKeyConfigured(), isGeminiKeyConfigured()]);
    if (!openAiReady && !geminiReady && !isVoiceSessionActive()) {
      await startBrowserVoice(button);
      return;
    }
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
  subscribe(voiceSessionStatus, () => syncButton(button));
  subscribe(browserVoiceState, () => syncButton(button));
  window.addEventListener('cr-lang-changed', () => syncButton(button));
  configurationState.onCredentialsChanged('openai', () => syncButton(button));
  configurationState.onCredentialsChanged('gemini', () => syncButton(button));
}
