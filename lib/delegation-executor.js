/**
 * Whether a proposed executor model is allowed for a server-started delegation.
 * Short ids (grok-4.6) resolve to an enabled variant; effort hints pick High/Medium.
 */

import { hasChatRunAdapter } from './chat-run-service.js';
import { isHarnessEnabled } from './harness-enabled.js';
import {
  decodeModelValue,
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

const EFFORT_VALUES = Object.freeze(['low', 'medium', 'high']);

/**
 * @param {object} [settings]
 * @param {string} transport
 * @returns {string[]}
 */
function enabledModelIds(settings, transport) {
  const enabledKey = ENABLED_MODEL_KEYS[transport];
  return normalizeChatEnabledModels(enabledKey ? settings[enabledKey] : []);
}

/**
 * @param {import('./model-catalog.js').ModelParameterValue[] | undefined} params
 * @param {string} id
 * @returns {string}
 */
function readParamValue(params, id) {
  if (!Array.isArray(params)) return '';
  const hit = params.find((row) => String(row?.id || '').trim() === id);
  return String(hit?.value || '').trim().toLowerCase();
}

/**
 * @param {unknown} raw
 * @returns {{ requested: string, modelId: string, effort: string, params: import('./model-catalog.js').ModelParameterValue[] }}
 */
function parseModelRequest(raw) {
  const requested = normalizeCatalogModelValue(raw);
  if (!requested) {
    return { requested: '', modelId: '', effort: '', params: [] };
  }
  const decoded = decodeModelValue(requested);
  const effortFromParams = readParamValue(decoded.params, 'effort');
  if (decoded.params && decoded.params.length > 0) {
    return {
      requested,
      modelId: decoded.modelId,
      effort: EFFORT_VALUES.includes(effortFromParams) ? effortFromParams : '',
      params: decoded.params,
    };
  }
  const tokens = requested.split(/[\s,_+/]+/).filter(Boolean);
  const effortToken = tokens.find((token) => EFFORT_VALUES.includes(token.toLowerCase()));
  const modelTokens = tokens.filter((token) => !EFFORT_VALUES.includes(token.toLowerCase()));
  const modelRaw = modelTokens.join('-');
  const modelId = decodeModelValue(modelRaw).modelId || modelRaw;
  return {
    requested,
    modelId,
    effort: effortToken ? effortToken.toLowerCase() : '',
    params: [],
  };
}

/**
 * @param {string} enabledId
 * @param {{ modelId: string, params: import('./model-catalog.js').ModelParameterValue[] }} parsed
 * @returns {boolean}
 */
function isEnabledVariantOfRequest(enabledId, parsed) {
  const decoded = decodeModelValue(enabledId);
  if (decoded.modelId.toLowerCase() !== parsed.modelId.toLowerCase()) return false;
  if (!Array.isArray(parsed.params) || parsed.params.length === 0) return true;
  const byId = new Map(
    (decoded.params || []).map((row) => [String(row.id).trim(), String(row.value).trim()]),
  );
  return parsed.params.every((row) => byId.get(row.id) === row.value);
}

/**
 * Map a short or partial model id onto an enabled catalog value.
 * Never invents an id outside the harness enabled-model list.
 *
 * @param {{
 *   transport?: string,
 *   model?: string,
 *   settings?: object,
 * }} input
 * @returns {string}
 */
export function resolveDelegationModel(input = {}) {
  const transport = String(input.transport || '').trim();
  if (!hasChatRunAdapter(transport)) return '';
  const parsed = parseModelRequest(input.model);
  if (!parsed.requested || !parsed.modelId) return '';
  const settings = input.settings && typeof input.settings === 'object'
    ? input.settings
    : loadSettings();
  if (!isHarnessEnabled(transport, settings.enabledHarnesses)) return '';
  const enabled = enabledModelIds(settings, transport);
  if (enabled.length === 0) return parsed.requested;
  if (enabled.includes(parsed.requested)) return parsed.requested;
  const matched = enabled.filter((id) => isEnabledVariantOfRequest(id, parsed));
  if (matched.length === 0) return '';
  if (parsed.effort) {
    const byEffort = matched.filter((id) => (
      readParamValue(decodeModelValue(id).params, 'effort') === parsed.effort
    ));
    if (byEffort.length > 0) return byEffort[0];
  }
  return matched[0];
}

/**
 * @param {{
 *   transport?: string,
 *   model?: string,
 *   settings?: object,
 * }} input
 * @returns {boolean}
 */
export function isDelegationModelAvailable(input = {}) {
  return resolveDelegationModel(input) !== '';
}
