/**
 * Z.AI SDK fields of GET/PATCH /api/settings.
 */

import { getZaiSdkApiKeyMetaForClient, normalizeZaiSdkProvider } from './zai-api-key.js';
import { normalizeChatEnabledModels } from '../../lib/model-catalog.js';
import { invalidSettings, patchClear, patchEnabledModels } from '../../lib/agent-harness/harness-settings-patch.ts';

export { settingsSchema } from './zai-settings-schema.js';

/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsDoc} SettingsDoc */
/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchBody} SettingsPatchBody */

/**
 * @param {SettingsDoc} settings
 */
export function readClientSettings(settings) {
  return {
    ...getZaiSdkApiKeyMetaForClient(),
    zaiChatEnabledModels: normalizeChatEnabledModels(settings.zaiChatEnabledModels),
  };
}

/**
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @returns {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchResult}
 */
export function applySettingsPatch(body, settings) {
  let changed = false;
  if (body && typeof body.zaiApiKey === 'string') {
    const raw = body.zaiApiKey.trim();
    if (raw && (raw.length < 16 || raw.startsWith('sk-'))) {
      return invalidSettings('Invalid Z.AI SDK API key format.');
    }
    if (raw) settings.zaiApiKey = raw;
    else delete settings.zaiApiKey;
    changed = true;
  }
  if (patchClear(body, settings, 'clearZaiApiKey', 'zaiApiKey')) changed = true;
  if (body && typeof body.zaiProvider === 'string') {
    settings.zaiProvider = normalizeZaiSdkProvider(body.zaiProvider);
    changed = true;
  }
  if (patchEnabledModels(body, settings, 'zaiChatEnabledModels')) changed = true;
  return { changed };
}
