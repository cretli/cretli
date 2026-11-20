/**
 * DeepSeek Harness fields of GET/PATCH /api/settings.
 */

import { getDeepSeekApiKeyMetaForClient } from './deepseek-api-key.js';
import { normalizeDeepSeekChatEnabledModels } from './deepseek-model-ids.js';
import { patchClear, patchEnabledModels, patchTrimmedString } from '../../lib/agent-harness/harness-settings-patch.ts';

export { settingsSchema } from './deepseek-settings-schema.js';

/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsDoc} SettingsDoc */
/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchBody} SettingsPatchBody */

/**
 * @param {SettingsDoc} settings
 */
export function readClientSettings(settings) {
  return {
    ...getDeepSeekApiKeyMetaForClient(),
    deepseekChatEnabledModels: normalizeDeepSeekChatEnabledModels(settings.deepseekChatEnabledModels),
    deepseekBin: typeof settings.deepseekBin === 'string' ? settings.deepseekBin : '',
  };
}

/**
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @returns {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchResult}
 */
export function applySettingsPatch(body, settings) {
  let changed = false;
  if (patchTrimmedString(body, settings, 'deepseekApiKey')) changed = true;
  if (patchClear(body, settings, 'clearDeepSeekApiKey', 'deepseekApiKey')) changed = true;
  if (patchTrimmedString(body, settings, 'deepseekBin')) changed = true;
  if (patchEnabledModels(body, settings, 'deepseekChatEnabledModels', normalizeDeepSeekChatEnabledModels)) changed = true;
  return { changed };
}
