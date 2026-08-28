/**
 * Read-aloud controls for chat settings: mode, engine, voice, speed.
 */

import { getCurrentLang, t } from '../../i18n/index.js';
import { escapeHtml } from '../chat/chatHtmlUtils.js';
import { listBrowserVoices, primeBrowserSpeech, resetTtsEngineFailures } from './ttsEngine.js';
import { getChatSpeaker, VOICE_ERROR_EVENT, VOICE_SPEAKING_EVENT } from './chatSpeaker.js';
import { isOpenAiKeyConfigured } from './openAiKeyStatus.js';
import { isAzureSpeechConfigured } from './azureSpeechStatus.js';
import {
  AZURE_TTS_VOICES,
  DEFAULT_SPEECH_RATE,
  OPENAI_TTS_VOICES,
  READ_MODES,
  getAzureVoice,
  getBrowserVoiceName,
  getOpenAiVoice,
  getReadMode,
  getSpeechRate,
  getTtsEngineId,
  setAzureVoice,
  setBrowserVoiceName,
  setOpenAiVoice,
  setReadMode,
  setSpeechRate,
  setTtsEngineId,
} from './voicePrefs.js';
import '../../components/ui/cr-bar-select.js';
import '../../components/ui/cr-bar-button.js';

const SPEED_STEPS = [0.8, 1, 1.2, 1.5, 1.8];

/** Mode used when the toggle button switches reading back on. */
const DEFAULT_ON_MODE = 'final';

/** Identifies the sample playback, so only the Test button shows a stop state. */
const VOICE_TEST_TOKEN = 'voice-settings-test';

/**
 * Turns reading on or off. Returns the resulting mode.
 *
 * @returns {string}
 */
export function toggleReadAloud() {
  if (getReadMode() !== 'off') {
    setReadMode('off');
    getChatSpeaker().stop();
    return 'off';
  }
  setReadMode(DEFAULT_ON_MODE);
  // iOS only allows speech started from a user gesture; this click is that gesture.
  if (getTtsEngineId() === 'browser') primeBrowserSpeech();
  return DEFAULT_ON_MODE;
}

/**
 * @returns {{ root: HTMLElement, refresh: () => void }}
 */
export function createVoiceReadOptions() {
  const root = document.createElement('div');
  root.className = 'chat-settings-voice-read';
  root.innerHTML =
    '<label for="chat-settings-voice-mode">' + escapeHtml(t('voice.readAloud')) + '</label>' +
    '<cr-bar-select id="chat-settings-voice-mode" class="voice-mode-select"></cr-bar-select>' +
    '<label for="chat-settings-voice-engine">' + escapeHtml(t('voice.engine')) + '</label>' +
    '<cr-bar-select id="chat-settings-voice-engine" class="voice-engine-select"></cr-bar-select>' +
    '<label for="chat-settings-voice-name">' + escapeHtml(t('voice.voice')) + '</label>' +
    '<cr-bar-select id="chat-settings-voice-name" class="voice-name-select"></cr-bar-select>' +
    '<label for="chat-settings-voice-speed">' + escapeHtml(t('voice.speed')) + '</label>' +
    '<cr-bar-select id="chat-settings-voice-speed" class="voice-speed-select"></cr-bar-select>' +
    '<cr-bar-button class="voice-test-btn"></cr-bar-button>' +
    '<span class="voice-options-message" hidden></span>';

  const modeSelect = root.querySelector('.voice-mode-select');
  const engineSelect = root.querySelector('.voice-engine-select');
  const nameSelect = root.querySelector('.voice-name-select');
  const speedSelect = root.querySelector('.voice-speed-select');
  const testBtn = root.querySelector('.voice-test-btn');
  const messageEl = root.querySelector('.voice-options-message');
  let testing = false;

  /**
   * @param {string} text
   * @returns {void}
   */
  function showMessage(text) {
    messageEl.textContent = text;
    messageEl.hidden = !text;
  }

  function buildVoiceOptions() {
    const engineId = getTtsEngineId();
    if (engineId === 'openai') {
      return OPENAI_TTS_VOICES.map((voice) => ({ value: voice, label: voice }));
    }
    if (engineId === 'azure') {
      // The locale prefix is the point of this engine, so keep it in the label.
      return AZURE_TTS_VOICES.map((voice) => ({ value: voice, label: voice.replace('Neural', '') }));
    }
    const voices = listBrowserVoices(getCurrentLang());
    const options = [{ value: '', label: t('voice.systemVoice') }];
    for (const voice of voices) options.push({ value: voice.name, label: voice.name });
    return options;
  }

  /**
   * @returns {string}
   */
  function currentVoiceValue() {
    const engineId = getTtsEngineId();
    if (engineId === 'openai') return getOpenAiVoice();
    if (engineId === 'azure') return getAzureVoice(getCurrentLang());
    return getBrowserVoiceName();
  }

  /**
   * @param {string} label
   * @param {boolean} configured
   * @returns {string}
   */
  function labelWithKeyState(label, configured) {
    return configured ? label : `${label} (${t('voice.noKey')})`;
  }

  function syncTestButton() {
    testBtn.textContent = testing ? t('voice.testStop') : t('voice.test');
    testBtn.title = t('voice.testTitle');
  }

  function refresh() {
    syncTestButton();
    modeSelect.options = READ_MODES.map((mode) => ({ value: mode, label: t(`voice.mode.${mode}`) }));
    modeSelect.value = getReadMode();
    modeSelect.ariaLabel = t('voice.readAloud');

    engineSelect.value = getTtsEngineId();
    engineSelect.ariaLabel = t('voice.engine');
    speedSelect.options = SPEED_STEPS.map((step) => ({ value: String(step), label: `${step}×` }));
    speedSelect.value = String(getSpeechRate() || DEFAULT_SPEECH_RATE);
    speedSelect.ariaLabel = t('voice.speed');

    nameSelect.options = buildVoiceOptions();
    nameSelect.value = currentVoiceValue();
    nameSelect.ariaLabel = t('voice.voice');

    void Promise.all([isOpenAiKeyConfigured(), isAzureSpeechConfigured()]).then(
      ([openAiReady, azureReady]) => {
        engineSelect.options = [
          { value: 'browser', label: t('voice.engineBrowser') },
          { value: 'openai', label: labelWithKeyState(t('voice.engineOpenAi'), openAiReady) },
          { value: 'azure', label: labelWithKeyState(t('voice.engineAzure'), azureReady) },
        ];
        // A stored preference for an unconfigured engine would go silent.
        const engineId = getTtsEngineId();
        const missingKey =
          (engineId === 'openai' && !openAiReady) || (engineId === 'azure' && !azureReady);
        if (!missingKey) return;
        setTtsEngineId('browser');
        engineSelect.value = 'browser';
        nameSelect.options = buildVoiceOptions();
        nameSelect.value = getBrowserVoiceName();
        // Snapping back to Browser with no word said looks like a broken select.
        showMessage(t('voice.engineNeedsKey'));
      }
    );
  }

  modeSelect.addEventListener('cr-change', (event) => {
    const mode = event.detail?.value || 'off';
    setReadMode(mode);
    if (mode === 'off') getChatSpeaker().stop();
    else if (getTtsEngineId() === 'browser') primeBrowserSpeech();
    notifyChanged();
  });

  engineSelect.addEventListener('cr-change', (event) => {
    setTtsEngineId(event.detail?.value || 'browser');
    // An explicit pick deserves a fresh attempt, even after an earlier failure.
    resetTtsEngineFailures();
    showMessage('');
    getChatSpeaker().stop();
    refresh();
    notifyChanged();
  });

  nameSelect.addEventListener('cr-change', (event) => {
    const value = event.detail?.value || '';
    const engineId = getTtsEngineId();
    if (engineId === 'openai') setOpenAiVoice(value);
    else if (engineId === 'azure') setAzureVoice(value);
    else setBrowserVoiceName(value);
    resetTtsEngineFailures();
    showMessage('');
    getChatSpeaker().stop();
  });

  speedSelect.addEventListener('cr-change', (event) => {
    setSpeechRate(Number.parseFloat(event.detail?.value || '1'));
    getChatSpeaker().stop();
  });

  // Reading a sample right after switching the engine or voice is the only way
  // to tell "wrong setting" from "engine not answering" without waiting for the
  // next agent answer.
  testBtn.addEventListener('click', () => {
    showMessage('');
    // iOS only allows speech started from a user gesture; this click is that gesture.
    if (getTtsEngineId() === 'browser') primeBrowserSpeech();
    getChatSpeaker().toggleSpeakMarkdown(t('voice.testSample'), VOICE_TEST_TOKEN);
  });

  if (typeof window !== 'undefined') {
    window.addEventListener(VOICE_SPEAKING_EVENT, (event) => {
      const detail = event.detail || {};
      testing = detail.active === true && detail.token === VOICE_TEST_TOKEN;
      syncTestButton();
    });

    // Silent degradation is the confusing part: the user picks a paid voice and
    // hears the system one. Say what happened and show the engine actually in
    // use.
    window.addEventListener(VOICE_ERROR_EVENT, (event) => {
      const detail = event.detail || {};
      if (!detail.engineId || detail.engineId === 'browser') return;
      showMessage(`${t('voice.engineFallback')} ${String(detail.message || '').trim()}`.trim());
      if (detail.permanent !== true) return;
      setTtsEngineId('browser');
      refresh();
      notifyChanged();
    });
  }

  function notifyChanged() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('cr-voice-read-mode-changed', { detail: { mode: getReadMode() } }));
  }

  refresh();
  return { root, refresh };
}
