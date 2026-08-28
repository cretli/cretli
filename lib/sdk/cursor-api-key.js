/**
 * Cursor API key for @cursor/sdk: env first, then data/config.json (cursorApiKey field).
 */

import { loadSettings } from '../persist/settings.js';

export function getCursorApiKeyFromEnv() {
  return (process.env.CURSOR_API_KEY || '').trim();
}

export function getCursorApiKeyFromSettings() {
  const s = loadSettings();
  const k = s.cursorApiKey;
  return typeof k === 'string' && k.trim() ? k.trim() : '';
}

export function getEffectiveCursorApiKey() {
  const env = getCursorApiKeyFromEnv();
  if (env) {
    return env;
  }
  return getCursorApiKeyFromSettings();
}

/**
 * Metadata for the UI, without exposing the key itself.
 */
export function getCursorApiKeyMetaForClient() {
  const fromEnv = !!getCursorApiKeyFromEnv();
  const fromSettings = !!getCursorApiKeyFromSettings();
  const effective = !!getEffectiveCursorApiKey();
  return {
    cursorApiKeyEffective: effective,
    cursorApiKeyFromEnv: fromEnv,
    cursorApiKeyStoredInSettings: fromSettings,
  };
}
