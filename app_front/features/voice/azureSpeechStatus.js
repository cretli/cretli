import { configurationState } from '../../state/index.js';
/**
 * Cached "does the server have Azure Speech credentials" check for the voice UI.
 * Azure needs a key *and* a region, so the server decides — the browser only
 * asks whether the engine is worth offering.
 */

import { getSettings } from '../../core/api/index.js';

/** @type {Promise<boolean>|null} */
let configuredPromise = null;

let configuredRevision = -1;

/**
 * @returns {Promise<boolean>}
 */
export function isAzureSpeechConfigured() {
  const revision = configurationState.credentialRevision('azure').get();
  if (!configuredPromise || configuredRevision !== revision) {
    configuredRevision = revision;
    configuredPromise = getSettings()
      .then((settings) => settings?.azureSpeechEffective === true)
      .catch(() => false);
  }
  return configuredPromise;
}
