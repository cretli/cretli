/**
 * Qwen Code fields of GET/PATCH /api/settings.
 */

import { getQwenApiKeyMetaForClient, normalizeQwenEndpoint, resolveQwenBaseUrl } from './qwen-api-key.js';
import { normalizeChatEnabledModels } from '../../lib/model-catalog.js';
import { patchClear, patchEnabledModels, patchTrimmedString } from '../../lib/agent-harness/harness-settings-patch.ts';

export { settingsSchema } from './qwen-settings-schema.js';

/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsDoc} SettingsDoc */
/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchBody} SettingsPatchBody */

/**
 * @param {SettingsDoc} settings
 */
export function readClientSettings(settings) {
  return {
    ...getQwenApiKeyMetaForClient(),
    qwenChatEnabledModels: normalizeChatEnabledModels(settings.qwenChatEnabledModels),
    qwenBin: typeof settings.qwenBin === 'string' ? settings.qwenBin : '',
    qwenBaseUrl: typeof settings.qwenBaseUrl === 'string' ? settings.qwenBaseUrl : '',
    qwenEndpoint: normalizeQwenEndpoint(settings.qwenEndpoint),
    qwenResolvedBaseUrl: resolveQwenBaseUrl(),
  };
}

/**
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @returns {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchResult}
 */
export function applySettingsPatch(body, settings) {
  let changed = false;
  if (patchTrimmedString(body, settings, 'qwenApiKey')) changed = true;
  if (patchClear(body, settings, 'clearQwenApiKey', 'qwenApiKey')) changed = true;
  if (patchTrimmedString(body, settings, 'qwenBin')) changed = true;
  if (patchTrimmedString(body, settings, 'qwenBaseUrl')) changed = true;
  if (body && typeof body.qwenEndpoint === 'string') {
    settings.qwenEndpoint = normalizeQwenEndpoint(body.qwenEndpoint);
    changed = true;
  }
  if (patchEnabledModels(body, settings, 'qwenChatEnabledModels')) changed = true;
  return { changed };
}
