/**
 * CodeBuddy fields of GET/PATCH /api/settings. Key and binary changes drop the
 * cached model list, which depends on both.
 */

import { getCodeBuddyApiKeyMetaForClient } from './codebuddy-api-key.js';
import {
  invalidateCodeBuddyModelsCache,
  isNativeCodeBuddyModel,
  resolveCodeBuddyEnabledModels,
} from './codebuddy-models.js';
import { normalizeChatEnabledModels } from '../../lib/model-catalog.js';
import { patchClear, patchEnabledModels, patchTrimmedString } from '../../lib/agent-harness/harness-settings-patch.ts';

export { settingsSchema } from './codebuddy-settings-schema.js';

/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsDoc} SettingsDoc */
/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchBody} SettingsPatchBody */

/**
 * @param {SettingsDoc} settings
 */
export function readClientSettings(settings) {
  return {
    ...getCodeBuddyApiKeyMetaForClient(),
    codebuddyChatEnabledModels: resolveCodeBuddyEnabledModels(normalizeChatEnabledModels(settings.codebuddyChatEnabledModels)),
    codebuddyBin: typeof settings.codebuddyBin === 'string' ? settings.codebuddyBin : '',
  };
}

/**
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @returns {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchResult}
 */
export function applySettingsPatch(body, settings) {
  let changed = false;
  for (const applied of [
    patchTrimmedString(body, settings, 'codebuddyApiKey'),
    patchClear(body, settings, 'clearCodeBuddyApiKey', 'codebuddyApiKey'),
    patchTrimmedString(body, settings, 'codebuddyBin'),
  ]) {
    if (!applied) continue;
    changed = true;
    invalidateCodeBuddyModelsCache();
  }
  // Only native CodeBuddy model ids are kept as favorites.
  if (patchEnabledModels(body, settings, 'codebuddyChatEnabledModels',
    (raw) => normalizeChatEnabledModels(raw).filter(isNativeCodeBuddyModel))) changed = true;
  return { changed };
}
