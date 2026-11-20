import { configurationState } from '../../state/index.js';
/**
 * Cached "does the server have a Gemini key" check for the voice-mode button.
 */

import { getSettings } from '../../core/api/index.js';

/** @type {Promise<boolean>|null} */
let configuredPromise = null;

let configuredRevision = -1;

/**
 * @returns {Promise<boolean>}
 */
export function isGeminiKeyConfigured() {
  const revision = configurationState.credentialRevision('gemini').get();
  if (!configuredPromise || configuredRevision !== revision) {
    configuredRevision = revision;
    configuredPromise = getSettings()
      .then((settings) => settings?.geminiApiKeyEffective === true)
      .catch(() => false);
  }
  return configuredPromise;
}
