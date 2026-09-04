/**
 * CodeBuddy API key: env first, then data/config.json (codebuddyApiKey).
 */

import { loadSettings } from '../persist/settings.js';
import { ensureCodeBuddyHomeDir } from './codebuddy-cli.js';

/**
 * @returns {string}
 */
export function getCodeBuddyApiKeyFromEnv() {
  return (process.env.CODEBUDDY_API_KEY || '').trim();
}

/**
 * @returns {string}
 */
export function getCodeBuddyApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.codebuddyApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {string}
 */
export function getEffectiveCodeBuddyApiKey() {
  const fromEnv = getCodeBuddyApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getCodeBuddyApiKeyFromSettings();
}

/**
 * Client-safe metadata (never exposes the key).
 * @returns {{
 *   codebuddyApiKeyEffective: boolean,
 *   codebuddyApiKeyFromEnv: boolean,
 *   codebuddyApiKeyStoredInSettings: boolean,
 * }}
 */
export function getCodeBuddyApiKeyMetaForClient() {
  const fromEnv = !!getCodeBuddyApiKeyFromEnv();
  const fromSettings = !!getCodeBuddyApiKeyFromSettings();
  return {
    codebuddyApiKeyEffective: !!getEffectiveCodeBuddyApiKey(),
    codebuddyApiKeyFromEnv: fromEnv,
    codebuddyApiKeyStoredInSettings: fromSettings,
  };
}

/**
 * Env passed into the CodeBuddy CLI / SDK process.
 * @returns {Record<string, string>}
 */
export function buildCodeBuddyProcessEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  const apiKey = getEffectiveCodeBuddyApiKey();
  if (apiKey) env.CODEBUDDY_API_KEY = apiKey;
  const edition = (process.env.CODEBUDDY_INTERNET_ENVIRONMENT || '').trim();
  if (edition) env.CODEBUDDY_INTERNET_ENVIRONMENT = edition;
  env.HOME = ensureCodeBuddyHomeDir();
  return env;
}
