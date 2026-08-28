/**
 * Cached "does the server have a Gemini key" check for the voice-mode button.
 */

import { getSettings } from '../../api.js';

/** @type {Promise<boolean>|null} */
let configuredPromise = null;

if (typeof window !== 'undefined') {
  window.addEventListener('cretli-gemini-key-changed', () => {
    configuredPromise = null;
  });
}

/**
 * @returns {Promise<boolean>}
 */
export function isGeminiKeyConfigured() {
  if (!configuredPromise) {
    configuredPromise = getSettings()
      .then((settings) => settings?.geminiApiKeyEffective === true)
      .catch(() => false);
  }
  return configuredPromise;
}
