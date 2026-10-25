/**
 * OpenRouter client fields of GET/PATCH /api/settings: API key, site URL and app
 * title. Core (registered unconditionally by lib/agent-harness/core-settings-modules.ts),
 * so the key stays settable when the OpenRouter chat plugin is disabled. Chat model
 * favorites live in the chat plugin.
 */

import { getOpenRouterApiKeyMetaForClient, isValidOpenRouterApiKeyFormat } from './openrouter-api-key.ts';
import { invalidSettings, patchTrimmedString } from '../../agent-harness/harness-settings-patch.ts';

export { settingsSchema } from './openrouter-settings-schema.ts';

import type { SettingsDoc, SettingsPatchBody, SettingsPatchResult } from '../../agent-harness/harness-settings-patch.ts';

export function readClientSettings(_settings: SettingsDoc) {
  return { ...getOpenRouterApiKeyMetaForClient() };
}

export function applySettingsPatch(body: SettingsPatchBody, settings: SettingsDoc): SettingsPatchResult {
  let changed = false;
  if (body && body.clearOpenrouterApiKey === true) {
    if (settings.openrouterApiKey !== undefined) {
      delete settings.openrouterApiKey;
      changed = true;
    }
  }
  if (body && typeof body.openrouterApiKey === 'string') {
    const raw = body.openrouterApiKey.trim();
    if (raw) {
      if (!isValidOpenRouterApiKeyFormat(raw)) {
        return invalidSettings('Invalid OpenRouter API key — it must start with sk-or-v1- (create one at openrouter.ai/keys).');
      }
      settings.openrouterApiKey = raw;
      changed = true;
    }
  }
  if (patchTrimmedString(body, settings, 'openrouterSiteUrl')) changed = true;
  if (patchTrimmedString(body, settings, 'openrouterAppTitle')) changed = true;
  return { changed };
}
