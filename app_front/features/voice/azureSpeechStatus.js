/**
 * Cached "does the server have Azure Speech credentials" check for the voice UI.
 * Azure needs a key *and* a region, so the server decides — the browser only
 * asks whether the engine is worth offering.
 */

import { getSettings } from '../../api.js';

/** @type {Promise<boolean>|null} */
let configuredPromise = null;

if (typeof window !== 'undefined') {
  window.addEventListener('cretli-azure-speech-changed', () => {
    configuredPromise = null;
  });
}

/**
 * @returns {Promise<boolean>}
 */
export function isAzureSpeechConfigured() {
  if (!configuredPromise) {
    configuredPromise = getSettings()
      .then((settings) => settings?.azureSpeechEffective === true)
      .catch(() => false);
  }
  return configuredPromise;
}
