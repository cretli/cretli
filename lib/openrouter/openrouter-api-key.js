/**
 * OpenRouter API key resolution: env first, then data/config.json (openrouterApiKey).
 */

import { loadSettings } from '../persist/settings.js';

/** @type {string} */
export const OPENROUTER_API_KEY_PREFIX = 'sk-or-v1-';

/**
 * OpenRouter keys must use the sk-or-v1- prefix; other sk-* values are rejected by the API
 * with "Missing Authentication header" instead of a clear invalid-key message.
 *
 * @param {unknown} key
 * @returns {boolean}
 */
export function isValidOpenRouterApiKeyFormat(key) {
  const raw = String(key || '').trim();
  if (!raw.startsWith(OPENROUTER_API_KEY_PREFIX)) return false;
  return raw.length >= OPENROUTER_API_KEY_PREFIX.length + 8;
}

export function getOpenRouterApiKeyFromEnv() {
  return (process.env.OPENROUTER_API_KEY || '').trim();
}

export function getOpenRouterApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.openrouterApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {string} Valid OpenRouter key or empty string.
 */
export function getEffectiveOpenRouterApiKey() {
  const fromEnv = getOpenRouterApiKeyFromEnv();
  if (fromEnv) {
    return isValidOpenRouterApiKeyFormat(fromEnv) ? fromEnv : '';
  }
  const fromSettings = getOpenRouterApiKeyFromSettings();
  return isValidOpenRouterApiKeyFormat(fromSettings) ? fromSettings : '';
}

/**
 * @returns {string}
 */
export function getRawOpenRouterApiKeyCandidate() {
  const fromEnv = getOpenRouterApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getOpenRouterApiKeyFromSettings();
}

/**
 * Client-safe metadata (never exposes the key).
 */
export function getOpenRouterApiKeyMetaForClient() {
  const envRaw = getOpenRouterApiKeyFromEnv();
  const settingsRaw = getOpenRouterApiKeyFromSettings();
  const hasStoredKey = !!(envRaw || settingsRaw);
  const effective = !!getEffectiveOpenRouterApiKey();
  return {
    openrouterApiKeyEffective: effective,
    openrouterApiKeyInvalidFormat: hasStoredKey && !effective,
    openrouterApiKeyFromEnv: !!envRaw,
    openrouterApiKeyStoredInSettings: !!settingsRaw,
  };
}

/**
 * Optional HTTP headers recommended by OpenRouter.
 */
export function getOpenRouterRequestHeaders() {
  const settings = loadSettings();
  const headers = {
    Authorization: `Bearer ${getEffectiveOpenRouterApiKey()}`,
    'Content-Type': 'application/json',
  };
  const siteUrl =
    (process.env.OPENROUTER_SITE_URL || settings.openrouterSiteUrl || '').trim();
  const appTitle =
    (process.env.OPENROUTER_APP_TITLE || settings.openrouterAppTitle || 'Cretli').trim();
  if (siteUrl) headers['HTTP-Referer'] = siteUrl;
  if (appTitle) headers['X-OpenRouter-Title'] = appTitle;
  return headers;
}
