/**
 * Real dependencies of the reading settings (`app_settings` tts_engine / tts_voice / read_rate): the same
 * preference store the voice panel's TTS controls write.
 */

import { getCurrentLang } from '../../i18n/index.js';
import { listBrowserVoices } from './ttsEngine.js';
import {
  AZURE_TTS_VOICES,
  DEFAULT_SPEECH_RATE,
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  OPENAI_TTS_VOICES,
  getAzureVoice,
  getBrowserVoiceName,
  getOpenAiVoice,
  getSpeechRate,
  getTtsEngineId,
  setAzureVoice,
  setBrowserVoiceName,
  setOpenAiVoice,
  setSpeechRate,
  setTtsEngineId,
} from './voicePrefs.js';

/**
 * @returns {import('./voiceReadSettingsTools.js').ReadSettingsDeps}
 */
export function buildReadSettingsDeps() {
  return {
    getEngine: () => getTtsEngineId(),
    setEngine: (engine) => setTtsEngineId(engine),
    listVoices(engine) {
      if (engine === 'openai') return [...OPENAI_TTS_VOICES];
      if (engine === 'azure') return [...AZURE_TTS_VOICES];
      return listBrowserVoices().map((voice) => voice.name);
    },
    getVoice(engine) {
      if (engine === 'openai') return getOpenAiVoice();
      if (engine === 'azure') return getAzureVoice(getCurrentLang());
      return getBrowserVoiceName();
    },
    setVoice(engine, voice) {
      if (engine === 'openai') setOpenAiVoice(voice);
      else if (engine === 'azure') setAzureVoice(voice);
      else setBrowserVoiceName(voice);
    },
    getRate: () => getSpeechRate(),
    setRate: (rate) => setSpeechRate(rate),
    rateRange: { min: MIN_SPEECH_RATE, max: MAX_SPEECH_RATE, normal: DEFAULT_SPEECH_RATE },
  };
}
