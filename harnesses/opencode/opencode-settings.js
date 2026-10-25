/**
 * OpenCode fields of GET/PATCH /api/settings: its Zen key plus the Z.AI and
 * MiMo provider keys OpenCode runs with, the binary and instance limits.
 */

import { getOpenCodeApiKeyMetaForClient, isValidOpenCodeApiKeyFormat } from './opencode-api-key.js';
import {
  getOpenCodeZaiApiKeyMetaForClient,
  isValidOpenCodeZaiApiKeyFormat,
  normalizeOpenCodeZaiProvider,
} from './opencode-zai-api-key.js';
import {
  getOpenCodeMimoApiKeyMetaForClient,
  normalizeOpenCodeMimoBaseUrl,
  OPENCODE_MIMO_MODEL_IDS,
  OPENCODE_MIMO_PROVIDER_ID,
} from './opencode-mimo-api-key.js';
import { normalizeChatEnabledModels } from '../../lib/model-catalog.js';
import {
  invalidSettings,
  patchClear,
  patchEnabledModels,
  patchTrimmedString,
} from '../../lib/agent-harness/harness-settings-patch.ts';

export { settingsSchema } from './opencode-settings-schema.js';

/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsDoc} SettingsDoc */
/** @typedef {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchBody} SettingsPatchBody */

/** Keys whose saved change restarts every OpenCode server instance. */
const RUNTIME_STRING_KEYS = ['opencodeApiKey', 'opencodeZaiApiKey', 'opencodeMimoApiKey', 'opencodeMimoBaseUrl', 'opencodeZaiProvider'];
const RUNTIME_CLEAR_FLAGS = ['clearOpenCodeApiKey', 'clearOpenCodeZaiApiKey', 'clearOpenCodeMimoApiKey'];

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteOrUndefined(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

/**
 * Opt-in positive integer: empty/0/invalid deletes the setting (default applies).
 *
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @param {string} key
 * @returns {boolean}
 */
function patchPositiveInt(body, settings, key) {
  if (!body || typeof body[key] === 'undefined') return false;
  const parsed = Number.parseInt(String(body[key]), 10);
  if (Number.isFinite(parsed) && parsed > 0) settings[key] = parsed;
  else delete settings[key];
  return true;
}

/**
 * @param {SettingsDoc} settings
 */
export function readClientSettings(settings) {
  return {
    ...getOpenCodeApiKeyMetaForClient(),
    ...getOpenCodeZaiApiKeyMetaForClient(),
    ...getOpenCodeMimoApiKeyMetaForClient(),
    opencodeChatEnabledModels: normalizeChatEnabledModels(settings.opencodeChatEnabledModels),
    opencodeBin: typeof settings.opencodeBin === 'string' ? settings.opencodeBin : '',
    opencodePortBase: finiteOrUndefined(settings.opencodePortBase),
    opencodeMaxInstances: finiteOrUndefined(settings.opencodeMaxInstances),
    opencodeDelegationIdleMs: finiteOrUndefined(settings.opencodeDelegationIdleMs),
  };
}

/**
 * Must run after the OpenRouter patch: a Zen key pasted into the OpenRouter
 * field earlier in the same patch is removed from there.
 *
 * @param {SettingsPatchBody} body
 * @param {SettingsDoc} settings
 * @returns {import('../../lib/agent-harness/harness-settings-patch.ts').SettingsPatchResult}
 */
export function applySettingsPatch(body, settings) {
  let changed = false;
  if (body && typeof body.opencodeApiKey === 'string') {
    const raw = body.opencodeApiKey.trim();
    if (raw) {
      if (!isValidOpenCodeApiKeyFormat(raw)) {
        return invalidSettings('Invalid OpenCode API key format — use your OpenCode Zen key (opencode.ai/zen).');
      }
      settings.opencodeApiKey = raw;
      const misfiled = typeof settings.openrouterApiKey === 'string' ? settings.openrouterApiKey.trim() : '';
      if (misfiled && misfiled === raw) {
        delete settings.openrouterApiKey;
      }
    } else {
      delete settings.opencodeApiKey;
    }
    changed = true;
  }
  if (patchClear(body, settings, 'clearOpenCodeApiKey', 'opencodeApiKey')) changed = true;
  if (body && typeof body.opencodeZaiApiKey === 'string') {
    const raw = body.opencodeZaiApiKey.trim();
    if (raw) {
      if (!isValidOpenCodeZaiApiKeyFormat(raw)) {
        return invalidSettings('Invalid Z.AI API key format — paste a Z.AI key (not an OpenCode Zen or OpenRouter sk- key).');
      }
      settings.opencodeZaiApiKey = raw;
    } else {
      delete settings.opencodeZaiApiKey;
    }
    changed = true;
  }
  if (patchClear(body, settings, 'clearOpenCodeZaiApiKey', 'opencodeZaiApiKey')) changed = true;
  if (body && typeof body.opencodeMimoApiKey === 'string') {
    const raw = body.opencodeMimoApiKey.trim();
    if (raw) {
      settings.opencodeMimoApiKey = raw;
      const enabledModels = normalizeChatEnabledModels(settings.opencodeChatEnabledModels);
      if (enabledModels.length > 0) {
        const next = [...enabledModels];
        for (const modelId of OPENCODE_MIMO_MODEL_IDS) {
          const value = `${OPENCODE_MIMO_PROVIDER_ID}/${modelId}`;
          if (!next.includes(value)) next.push(value);
        }
        settings.opencodeChatEnabledModels = next;
      }
    } else delete settings.opencodeMimoApiKey;
    changed = true;
  }
  if (patchClear(body, settings, 'clearOpenCodeMimoApiKey', 'opencodeMimoApiKey')) changed = true;
  if (body && typeof body.opencodeMimoBaseUrl === 'string') {
    const raw = body.opencodeMimoBaseUrl.trim();
    if (raw) {
      const normalized = normalizeOpenCodeMimoBaseUrl(raw);
      if (!normalized) {
        return invalidSettings('MiMo Base URL must be a valid HTTPS URL without credentials, query, or fragment.');
      }
      settings.opencodeMimoBaseUrl = normalized;
    } else {
      delete settings.opencodeMimoBaseUrl;
    }
    changed = true;
  }
  if (body && typeof body.opencodeZaiProvider === 'string') {
    settings.opencodeZaiProvider = normalizeOpenCodeZaiProvider(body.opencodeZaiProvider);
    changed = true;
  }
  if (patchEnabledModels(body, settings, 'opencodeChatEnabledModels')) changed = true;
  if (patchTrimmedString(body, settings, 'opencodeBin')) changed = true;
  if (patchPositiveInt(body, settings, 'opencodePortBase')) changed = true;
  // Opt-in cap: empty/0/invalid clears it and restores the unlimited default.
  if (patchPositiveInt(body, settings, 'opencodeMaxInstances')) changed = true;
  // Opt-in: empty/0/invalid keeps the shared 90 s idle window.
  if (patchPositiveInt(body, settings, 'opencodeDelegationIdleMs')) changed = true;
  return { changed };
}

/**
 * @param {SettingsPatchBody} body
 * @returns {boolean}
 */
export function requiresRuntimeReset(body) {
  if (!body) return false;
  return RUNTIME_STRING_KEYS.some((key) => typeof body[key] === 'string')
    || RUNTIME_CLEAR_FLAGS.some((flag) => body[flag] === true);
}
