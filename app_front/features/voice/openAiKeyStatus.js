import { configurationState } from '../../state/index.js';
/**
 * Cached "does the server have an OpenAI key" check, shared by the voice UI.
 * Both the read-aloud controls and the header voice mode button need it, and
 * neither should hit /api/settings on every refresh.
 */

import { getSettings } from '../../core/api/index.js';

/** @type {Promise<boolean>|null} */
let configuredPromise = null;

let configuredRevision = -1;

/**
 * Whether the server has an OpenAI key, so the paid engines are worth offering.
 *
 * @returns {Promise<boolean>}
 */
export function isOpenAiKeyConfigured() {
  const revision = configurationState.credentialRevision('openai').get();
  if (!configuredPromise || configuredRevision !== revision) {
    configuredRevision = revision;
    configuredPromise = getSettings()
      .then((settings) => settings?.openaiApiKeyEffective === true)
      .catch(() => false);
  }
  return configuredPromise;
}
