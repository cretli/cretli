/**
 * Artificial Analysis API key resolution: env first, then data/config.json
 * (`artificialAnalysisApiKey`), same shape as the other provider keys.
 *
 * The key is only ever sent server-side in the `x-api-key` header of one
 * operator-triggered request. It is never logged and never part of a client
 * payload or snapshot.
 */

import { loadSettings } from './persist/settings.js';

export const ARTIFICIAL_ANALYSIS_API_KEY_ENV = 'ARTIFICIAL_ANALYSIS_API_KEY';

/**
 * @param {{ env?: Record<string, string | undefined>, settings?: Record<string, any> | null }} [input]
 * @returns {string} Trimmed key or an empty string.
 */
export function getArtificialAnalysisApiKey(input = {}) {
  const env = input.env || process.env;
  const fromEnv = String(env[ARTIFICIAL_ANALYSIS_API_KEY_ENV] || '').trim();
  if (fromEnv) return fromEnv;
  const settings = input.settings === undefined ? loadSettings() : input.settings;
  const fromSettings = settings && typeof settings.artificialAnalysisApiKey === 'string'
    ? settings.artificialAnalysisApiKey.trim()
    : '';
  return fromSettings;
}

/**
 * Client-safe metadata (never the key).
 *
 * @param {{ env?: Record<string, string | undefined>, settings?: Record<string, any> | null }} [input]
 * @returns {{ configured: boolean, saved: boolean, source: string }}
 */
export function getArtificialAnalysisApiKeyMeta(input = {}) {
  const settings = input.settings === undefined ? loadSettings() : input.settings;
  const saved = Boolean(String(settings?.artificialAnalysisApiKey || '').trim());
  const fromEnv = Boolean(String((input.env || process.env)[ARTIFICIAL_ANALYSIS_API_KEY_ENV] || '').trim());
  return { configured: fromEnv || saved, saved, source: fromEnv ? 'environment' : saved ? 'settings' : 'none' };
}
