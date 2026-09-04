/**
 * Azure Speech credentials for the voice layer: env first, then
 * data/config.json (`azureSpeechKey`, `azureSpeechRegion`). Neither value ever
 * leaves the server.
 *
 * Azure needs a region next to the key — it is part of the endpoint host — so
 * both must be present for the engine to count as configured.
 */

import { loadSettings } from '../persist/settings.js';

/** Subscription keys are 32-char hex today, but Azure has changed the shape before. */
const MIN_KEY_LENGTH = 32;

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isValidAzureSpeechKeyFormat(key) {
  const raw = String(key || '').trim();
  if (raw.length < MIN_KEY_LENGTH) return false;
  return /^[A-Za-z0-9_-]+$/.test(raw);
}

/**
 * Region ids are lowercase and alphanumeric, e.g. `westeurope`, `polandcentral`.
 *
 * @param {unknown} region
 * @returns {boolean}
 */
export function isValidAzureSpeechRegion(region) {
  const raw = String(region || '').trim().toLowerCase();
  return /^[a-z]{2,}[a-z0-9]*$/.test(raw) && raw.length <= 40;
}

export function getAzureSpeechKeyFromEnv() {
  return (process.env.AZURE_SPEECH_KEY || '').trim();
}

export function getAzureSpeechRegionFromEnv() {
  return (process.env.AZURE_SPEECH_REGION || '').trim().toLowerCase();
}

export function getAzureSpeechKeyFromSettings() {
  const key = loadSettings().azureSpeechKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

export function getAzureSpeechRegionFromSettings() {
  const region = loadSettings().azureSpeechRegion;
  return typeof region === 'string' && region.trim() ? region.trim().toLowerCase() : '';
}

/**
 * @returns {{ key: string, region: string }} Empty strings when unusable.
 */
export function getEffectiveAzureSpeechCredentials() {
  const envKey = getAzureSpeechKeyFromEnv();
  const envRegion = getAzureSpeechRegionFromEnv();
  // Env wins as a whole: a half-configured env must not silently borrow the
  // region from the settings file and talk to the wrong account.
  const key = envKey || getAzureSpeechKeyFromSettings();
  const region = envKey ? envRegion : getAzureSpeechRegionFromSettings();
  if (!isValidAzureSpeechKeyFormat(key) || !isValidAzureSpeechRegion(region)) {
    return { key: '', region: '' };
  }
  return { key, region };
}

/**
 * Client-safe metadata (never exposes the key).
 */
export function getAzureSpeechMetaForClient() {
  const envKey = getAzureSpeechKeyFromEnv();
  const settingsKey = getAzureSpeechKeyFromSettings();
  const region = envKey ? getAzureSpeechRegionFromEnv() : getAzureSpeechRegionFromSettings();
  const hasStoredKey = !!(envKey || settingsKey);
  const effective = !!getEffectiveAzureSpeechCredentials().key;
  return {
    azureSpeechEffective: effective,
    azureSpeechInvalidFormat: hasStoredKey && !effective,
    azureSpeechFromEnv: !!envKey,
    azureSpeechStoredInSettings: !!settingsKey,
    azureSpeechRegion: region,
  };
}
