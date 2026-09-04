/**
 * DeepSeek API key: env first, then data/config.json (deepseekApiKey).
 */

import { loadSettings } from '../persist/settings.js';

/**
 * @returns {string}
 */
export function getDeepSeekApiKeyFromEnv() {
  return (process.env.DEEPSEEK_API_KEY || '').trim();
}

/**
 * @returns {string}
 */
export function getDeepSeekApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.deepseekApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {string}
 */
export function getEffectiveDeepSeekApiKey() {
  const fromEnv = getDeepSeekApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getDeepSeekApiKeyFromSettings();
}

/**
 * Client-safe metadata (never exposes the key).
 * @returns {{
 *   deepseekApiKeyEffective: boolean,
 *   deepseekApiKeyFromEnv: boolean,
 *   deepseekApiKeyStoredInSettings: boolean,
 * }}
 */
export function getDeepSeekApiKeyMetaForClient() {
  const fromEnv = !!getDeepSeekApiKeyFromEnv();
  const fromSettings = !!getDeepSeekApiKeyFromSettings();
  return {
    deepseekApiKeyEffective: !!getEffectiveDeepSeekApiKey(),
    deepseekApiKeyFromEnv: fromEnv,
    deepseekApiKeyStoredInSettings: fromSettings,
  };
}

/**
 * Env overlay for the DeepSeek Harness child process.
 * @returns {Record<string, string>}
 */
export function buildDeepSeekProcessEnv() {
  /** @type {Record<string, string>} */
  const env = { ...process.env };
  const apiKey = getEffectiveDeepSeekApiKey();
  if (apiKey) env.DEEPSEEK_API_KEY = apiKey;
  return env;
}
