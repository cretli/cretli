/**
 * Mistral API key resolution: env first, then data/config.json (mistralApiKey).
 */

import { loadSettings } from '../../lib/persist/settings.js';

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
  return getEffectiveMistralApiCredential().key;
}

/**
 * @returns {{ key: string, billingSource: 'vibe_code'|'api'|'none' }}
 */
export function getEffectiveMistralApiCredential() {
  const settings = loadSettings();
  const requestedMode = settings.mistralBillingMode === 'api' ? 'api' : (settings.mistralBillingMode === 'vibe_code' ? 'vibe_code' : 'auto');
  const vibeEnv = (process.env.MISTRAL_VIBE_API_KEY || '').trim();
  const fromEnv = getMistralApiKeyFromEnv();
  const vibeSettings = typeof settings.mistralVibeApiKey === 'string' ? settings.mistralVibeApiKey.trim() : '';
  const apiSettings = getMistralApiKeyFromSettings();
  const vibeKey = vibeEnv || vibeSettings;
  const apiKey = fromEnv || apiSettings;
  const selected = requestedMode === 'auto'
    ? (isValidMistralApiKeyFormat(vibeKey) ? 'vibe_code' : 'api')
    : requestedMode;
  const key = selected === 'vibe_code' ? vibeKey : apiKey;
  return { key: isValidMistralApiKeyFormat(key) ? key : '', billingSource: key && isValidMistralApiKeyFormat(key) ? selected : 'none' };
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
  const vibeEnvRaw = (process.env.MISTRAL_VIBE_API_KEY || '').trim();
  const vibeSettingsRaw = loadSettings().mistralVibeApiKey;
  const hasVibeSettingsKey = typeof vibeSettingsRaw === 'string' && !!vibeSettingsRaw.trim();
  const hasStoredKey = !!(envRaw || settingsRaw || vibeEnvRaw || hasVibeSettingsKey);
  const credential = getEffectiveMistralApiCredential();
  const effective = !!credential.key;
  return {
    mistralApiKeyEffective: effective,
    mistralApiKeyInvalidFormat: hasStoredKey && !effective,
    mistralApiKeyFromEnv: !!envRaw,
    mistralApiKeyStoredInSettings: !!settingsRaw,
    mistralVibeApiKeyFromEnv: !!vibeEnvRaw,
    mistralVibeApiKeyStoredInSettings: hasVibeSettingsKey,
    mistralVibeApiKeySelected: credential.billingSource === 'vibe_code',
    mistralStudioApiKeySelected: credential.billingSource === 'api',
  };
}
