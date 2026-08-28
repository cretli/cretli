/**
 * Gemini API key resolution for the Live voice mode: env first, then
 * data/config.json (`geminiApiKey`). The key never leaves the server.
 */

import { loadSettings } from '../persist/settings.js';

/** Legacy standard keys (`AIza…`) and 2026 AI Studio auth keys (`AQ.…`). */
const GEMINI_KEY_PREFIXES = ['AIza', 'AQ.'];
const GEMINI_KEY_MIN_SUFFIX_LENGTH = 20;

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isValidGeminiApiKeyFormat(key) {
  const raw = String(key || '').trim();
  const prefix = GEMINI_KEY_PREFIXES.find((item) => raw.startsWith(item));
  if (!prefix) return false;
  return raw.length >= prefix.length + GEMINI_KEY_MIN_SUFFIX_LENGTH;
}

export function getGeminiApiKeyFromEnv() {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

export function getGeminiApiKeyFromSettings() {
  const key = loadSettings().geminiApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {string}
 */
export function getEffectiveGeminiApiKey() {
  const fromEnv = getGeminiApiKeyFromEnv();
  if (fromEnv) return isValidGeminiApiKeyFormat(fromEnv) ? fromEnv : '';
  const fromSettings = getGeminiApiKeyFromSettings();
  return isValidGeminiApiKeyFormat(fromSettings) ? fromSettings : '';
}

export function getGeminiApiKeyMetaForClient() {
  const envRaw = getGeminiApiKeyFromEnv();
  const settingsRaw = getGeminiApiKeyFromSettings();
  const hasStoredKey = !!(envRaw || settingsRaw);
  const effective = !!getEffectiveGeminiApiKey();
  return {
    geminiApiKeyEffective: effective,
    geminiApiKeyInvalidFormat: hasStoredKey && !effective,
    geminiApiKeyFromEnv: !!envRaw,
    geminiApiKeyStoredInSettings: !!settingsRaw,
  };
}
