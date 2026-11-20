/**
 * MiMo fields of GET/PATCH /api/settings.
 */

import { getMimoApiKeyMetaForClient, normalizeMimoBaseUrl } from './mimo-api-key.js';
import { normalizeChatEnabledModels } from '../../lib/model-catalog.js';
import {
  invalidSettings,
  patchClear,
  patchEnabledModels,
  patchTrimmedString,
} from '../../lib/agent-harness/harness-settings-patch.ts';

export { settingsSchema } from './mimo-settings-schema.js';

/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsDoc} SettingsDoc */
/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchBody} SettingsPatchBody */

/**
 * @param {SettingsDoc} settings
 */
export function readClientSettings(settings) {
  return {
    ...getMimoApiKeyMetaForClient(),
    mimoChatEnabledModels: normalizeChatEnabledModels(settings.mimoChatEnabledModels),
  };
}

/**
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @returns {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchResult}
 */
export function applySettingsPatch(body, settings) {
  let changed = false;
  if (patchTrimmedString(body, settings, 'mimoApiKey')) changed = true;
  if (patchClear(body, settings, 'clearMimoApiKey', 'mimoApiKey')) changed = true;
  if (body && typeof body.mimoBaseUrl === 'string') {
    const raw = body.mimoBaseUrl.trim();
    const normalized = normalizeMimoBaseUrl(raw);
    if (raw && !normalized) {
      return invalidSettings('Invalid MiMo base URL (must be an HTTPS URL ending with /v1).');
    }
    if (normalized) settings.mimoBaseUrl = normalized;
    else delete settings.mimoBaseUrl;
    changed = true;
  }
  if (patchEnabledModels(body, settings, 'mimoChatEnabledModels')) changed = true;
  return { changed };
}
