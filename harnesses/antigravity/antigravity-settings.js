import { normalizeChatEnabledModels } from '../../lib/model-catalog.js';
import { patchTrimmedString, patchEnabledModels } from '../../lib/agent-harness/harness-settings-patch.ts';
export { settingsSchema } from './antigravity-settings-schema.js';

export function readClientSettings(settings) {
  return { antigravityBin: settings.antigravityBin || '', antigravityChatEnabledModels: normalizeChatEnabledModels(settings.antigravityChatEnabledModels) };
}

export function applySettingsPatch(body, settings) {
  const binChanged = patchTrimmedString(body, settings, 'antigravityBin');
  const modelsChanged = patchEnabledModels(body, settings, 'antigravityChatEnabledModels');
  return { changed: binChanged || modelsChanged };
}
