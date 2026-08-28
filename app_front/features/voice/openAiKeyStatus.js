/**
 * Cached "does the server have an OpenAI key" check, shared by the voice UI.
 * Both the read-aloud controls and the header voice mode button need it, and
 * neither should hit /api/settings on every refresh.
 */

import { getSettings } from '../../api.js';

/** @type {Promise<boolean>|null} */
let configuredPromise = null;

if (typeof window !== 'undefined') {
  window.addEventListener('cretli-openai-key-changed', () => {
    configuredPromise = null;
  });
}

/**
 * Whether the server has an OpenAI key, so the paid engines are worth offering.
 *
 * @returns {Promise<boolean>}
 */
export function isOpenAiKeyConfigured() {
  if (!configuredPromise) {
    configuredPromise = getSettings()
      .then((settings) => settings?.openaiApiKeyEffective === true)
      .catch(() => false);
  }
  return configuredPromise;
}
