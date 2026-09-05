/**
 * Whether a proposed executor model is allowed for a server-started delegation.
 */

import { hasChatRunAdapter } from './chat-run-service.js';
import { isHarnessEnabled } from './harness-enabled.js';
import {
  normalizeCatalogModelValue,
  normalizeChatEnabledModels,
} from './model-catalog.js';
import { loadSettings } from './persist/settings.js';

const ENABLED_MODEL_KEYS = Object.freeze({
  sdk: 'chatEnabledModels',
  openrouter: 'openrouterChatEnabledModels',
  opencode: 'opencodeChatEnabledModels',
  codebuddy: 'codebuddyChatEnabledModels',
  deepseek: 'deepseekChatEnabledModels',
  qwen: 'qwenChatEnabledModels',
  codex: 'codexChatEnabledModels',
});

/**
 * @param {{
 *   transport?: string,
 *   model?: string,
 *   settings?: object,
 * }} input
 * @returns {boolean}
 */
export function isDelegationModelAvailable(input = {}) {
  const transport = String(input.transport || '').trim();
  if (!hasChatRunAdapter(transport)) return false;
  const model = normalizeCatalogModelValue(input.model);
  if (!model) return false;
  const settings = input.settings && typeof input.settings === 'object'
    ? input.settings
    : loadSettings();
  if (!isHarnessEnabled(transport, settings.enabledHarnesses)) return false;
  const enabledKey = ENABLED_MODEL_KEYS[transport];
  const enabled = normalizeChatEnabledModels(enabledKey ? settings[enabledKey] : []);
  if (enabled.length === 0) return true;
  return enabled.includes(model);
}
