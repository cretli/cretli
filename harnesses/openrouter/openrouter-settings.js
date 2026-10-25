/**
 * Chat-specific OpenRouter fields of GET/PATCH /api/settings (favorite models).
 * The API key, site URL and app title are core: lib/providers/openrouter/openrouter-settings.ts.
 */

import { normalizeChatEnabledModels } from '../../lib/model-catalog.js';
import { patchEnabledModels } from '../../lib/agent-harness/harness-settings-patch.ts';

/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsDoc} SettingsDoc */
/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchBody} SettingsPatchBody */

/**
 * @param {SettingsDoc} settings
 */
export function readClientSettings(settings) {
  return {
    openrouterChatEnabledModels: normalizeChatEnabledModels(settings.openrouterChatEnabledModels),
  };
}

/**
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @returns {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchResult}
 */
export function applySettingsPatch(body, settings) {
  return { changed: patchEnabledModels(body, settings, 'openrouterChatEnabledModels') };
}
