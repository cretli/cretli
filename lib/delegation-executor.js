/**
 * Whether a proposed executor model is allowed for a server-started delegation.
 * Short ids (grok-4.6) resolve to an enabled variant; effort hints pick High/Medium.
 */

import { hasChatRunAdapter } from './chat-run-service.js';
import { readEnvAlias } from './env-alias.js';
import { isHarnessEnabled } from './harness-enabled.js';
import {
  decodeModelValue,
  normalizeCatalogModelValue,
  normalizeChatEnabledModels,
} from './model-catalog.js';
import { normalizeDeepSeekChatEnabledModels } from './deepseek/deepseek-model-ids.js';
import { resolveCodeBuddyEnabledModels } from './codebuddy/codebuddy-models.js';
import { loadSettings } from './persist/settings.js';
import { getHarnessUsageLimit } from './harness-usage-limits.js';

const ENABLED_MODEL_KEYS = Object.freeze({
  sdk: 'chatEnabledModels',
  openrouter: 'openrouterChatEnabledModels',
  mistral: 'mistralChatEnabledModels',
  opencode: 'opencodeChatEnabledModels',
  codebuddy: 'codebuddyChatEnabledModels',
  deepseek: 'deepseekChatEnabledModels',
  qwen: 'qwenChatEnabledModels',
  codex: 'codexChatEnabledModels',
  claude: 'claudeChatEnabledModels',
});

const EFFORT_VALUES = Object.freeze(['low', 'medium', 'high']);

/**
 * Empty Settings favorites: default `deny` matches model_pick (unset = no
 * models). `CRETLI_DELEGATION_EMPTY_FAVORITES=all` restores the pre-migration
 * start behavior (any requested id when the list is empty).
 *
 * @returns {'deny' | 'all'}
 */
export function readDelegationEmptyFavoritesPolicy() {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_EMPTY_FAVORITES',
    defaultValue: 'deny',
  });
  return String(raw).trim().toLowerCase() === 'all' ? 'all' : 'deny';
}

/**
 * @param {string[]} enabled
 * @returns {boolean}
 */
export function hasConfiguredDelegationFavorites(enabled) {
  return Array.isArray(enabled) && enabled.length > 0;
}

/**
 * Empty favorites under the default deny policy: catalog ids are not
 * start-eligible. Do not treat model_list without enabled_only as a start list.
 *
 * @param {string} [harness]
 * @returns {string}
 */
export function describeEmptyDelegationFavorites(harness) {
  const id = String(harness || '').trim() || 'harness';
  return `No Settings favorites for ${id}. model_list("${id}", enabled_only=true) is empty until you add a favorite in Settings; catalog rows without that flag are not start-eligible. Do not edit settings files. Legacy: CRETLI_DELEGATION_EMPTY_FAVORITES=all.`;
}

/**
 * @param {object} [settings]
 * @param {string} transport
 * @returns {string[]}
 */
function enabledModelIds(settings, transport) {
  const enabledKey = ENABLED_MODEL_KEYS[transport];
  const ids = normalizeChatEnabledModels(enabledKey ? settings[enabledKey] : []);
  if (transport === 'deepseek') return normalizeDeepSeekChatEnabledModels(ids);
  if (transport === 'codebuddy') return resolveCodeBuddyEnabledModels(ids);
  return ids;
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
  if (!hasConfiguredDelegationFavorites(enabled)) {
    if (readDelegationEmptyFavoritesPolicy() === 'all') return parsed.requested;
    return '';
  }
  if (enabled.includes(parsed.requested)) return parsed.requested;
  const matched = enabled.filter((id) => isEnabledVariantOfRequest(id, parsed));
  const sameModel = matched.length > 0
    ? matched
    : enabled.filter((id) => decodeModelValue(id).modelId.toLowerCase() === parsed.modelId.toLowerCase());
  if (sameModel.length === 0) return '';
  if (parsed.effort) {
    const byEffort = sameModel.filter((id) => (
      readParamValue(decodeModelValue(id).params, 'effort') === parsed.effort
    ));
    if (byEffort.length > 0) return byEffort[0];
  }
  return sameModel[0];
}

const ENABLED_MODEL_PREVIEW_LIMIT = 8;

/**
 * Settings-enabled (favorite) model ids for one harness.
 * @param {{ transport?: string, settings?: object }} [input]
 * @returns {string[]}
 */
export function listEnabledDelegationModels(input = {}) {
  const transport = String(input.transport || '').trim();
  if (!hasChatRunAdapter(transport)) return [];
  const settings = input.settings && typeof input.settings === 'object'
    ? input.settings
    : loadSettings();
  if (!isHarnessEnabled(transport, settings.enabledHarnesses)) return [];
  return enabledModelIds(settings, transport);
}

/**
 * @param {{ transport?: string, settings?: object }} [input]
 * @returns {string}
 */
export function describeUnavailableDelegationModel(input = {}) {
  const transport = String(input.transport || '').trim();
  const enabled = listEnabledDelegationModels(input);
  if (!hasConfiguredDelegationFavorites(enabled) && readDelegationEmptyFavoritesPolicy() === 'deny') {
    return describeEmptyDelegationFavorites(transport);
  }
  const preview = enabled.slice(0, ENABLED_MODEL_PREVIEW_LIMIT);
  const more = enabled.length > ENABLED_MODEL_PREVIEW_LIMIT ? ` (${enabled.length} total)` : '';
  const list = preview.length > 0 ? ` Enabled: ${preview.join(', ')}${more}.` : '';
  const harness = transport || 'harness';
  return `That model is not in this harness favorites.${list} Call model_list("${harness}", enabled_only=true).`;
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
  if (getHarnessUsageLimit({ harness: input.transport, model: input.model })) return false;
  return resolveDelegationModel(input) !== '';
}
