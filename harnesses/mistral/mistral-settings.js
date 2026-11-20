/**
 * Mistral fields of GET/PATCH /api/settings. Credential, billing and endpoint
 * changes drop the cached model list, which depends on all of them.
 */

import { getMistralApiKeyMetaForClient } from './mistral-api-key.js';
import { invalidateMistralModelsCache } from './mistral-models.js';
import { normalizeChatEnabledModels } from '../../lib/model-catalog.js';
import { patchClear, patchEnabledModels, patchTrimmedString } from '../../lib/agent-harness/harness-settings-patch.ts';

export { settingsSchema } from './mistral-settings-schema.js';

/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsDoc} SettingsDoc */
/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchBody} SettingsPatchBody */

const BILLING_MODES = ['auto', 'vibe_code', 'api'];

/**
 * @param {SettingsDoc} settings
 */
export function readClientSettings(settings) {
  return {
    ...getMistralApiKeyMetaForClient(),
    mistralChatEnabledModels: normalizeChatEnabledModels(settings.mistralChatEnabledModels),
    mistralBaseUrl: typeof settings.mistralBaseUrl === 'string' ? settings.mistralBaseUrl : '',
    mistralBillingMode: BILLING_MODES.includes(settings.mistralBillingMode) ? settings.mistralBillingMode : 'auto',
  };
}

/**
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @returns {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchResult}
 */
export function applySettingsPatch(body, settings) {
  let changed = false;
  const billingMode = () => {
    if (!body || !BILLING_MODES.includes(body.mistralBillingMode)) return false;
    settings.mistralBillingMode = body.mistralBillingMode;
    return true;
  };
  for (const applied of [
    patchTrimmedString(body, settings, 'mistralApiKey'),
    patchTrimmedString(body, settings, 'mistralVibeApiKey'),
    billingMode(),
    patchClear(body, settings, 'clearMistralVibeApiKey', 'mistralVibeApiKey'),
    patchClear(body, settings, 'clearMistralApiKey', 'mistralApiKey'),
    patchTrimmedString(body, settings, 'mistralBaseUrl'),
  ]) {
    if (!applied) continue;
    changed = true;
    invalidateMistralModelsCache();
  }
  if (patchEnabledModels(body, settings, 'mistralChatEnabledModels')) changed = true;
  return { changed };
}
