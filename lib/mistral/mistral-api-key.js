/**
 * Mistral API key resolution: env first, then data/config.json (mistralApiKey).
 */

import { loadSettings } from '../persist/settings.js';

/** Mistral keys have no fixed prefix, so validation is intentionally soft. */
const MIN_MISTRAL_API_KEY_LENGTH = 16;

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isValidMistralApiKeyFormat(key) {
  const raw = String(key || '').trim();
  if (raw.length < MIN_MISTRAL_API_KEY_LENGTH) return false;
  return !/\s/.test(raw);
}

/**
 * @returns {string}
 */
export function getMistralApiKeyFromEnv() {
  return (process.env.MISTRAL_API_KEY || '').trim();
}

/**
 * @returns {string}
 */
export function getMistralApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.mistralApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {string} Valid Mistral key or empty string.
 */
export function getEffectiveMistralApiKey() {
  const fromEnv = getMistralApiKeyFromEnv();
  if (fromEnv) return isValidMistralApiKeyFormat(fromEnv) ? fromEnv : '';
  const fromSettings = getMistralApiKeyFromSettings();
  return isValidMistralApiKeyFormat(fromSettings) ? fromSettings : '';
}

/**
 * @returns {string} Optional custom API base URL (env, then settings).
 */
export function getMistralServerUrl() {
  const fromEnv = (process.env.MISTRAL_BASE_URL || '').trim();
  if (fromEnv) return fromEnv;
  const fromSettings = loadSettings().mistralBaseUrl;
  return typeof fromSettings === 'string' ? fromSettings.trim() : '';
}

/**
 * Client-safe metadata (never exposes the key).
 */
export function getMistralApiKeyMetaForClient() {
  const envRaw = getMistralApiKeyFromEnv();
  const settingsRaw = getMistralApiKeyFromSettings();
  const hasStoredKey = !!(envRaw || settingsRaw);
  const effective = !!getEffectiveMistralApiKey();
  return {
    mistralApiKeyEffective: effective,
    mistralApiKeyInvalidFormat: hasStoredKey && !effective,
    mistralApiKeyFromEnv: !!envRaw,
    mistralApiKeyStoredInSettings: !!settingsRaw,
  };
}
