/**
 * Whether a proposed executor model is allowed for a server-started delegation.
 * Short ids (grok-4.6) resolve to an enabled variant; effort hints pick High/Medium.
 */

import { hasChatRunAdapter } from './chat-run-service.js';
import { readEnvAlias } from './env-alias.js';
import { isHarnessEnabled } from './harness-enabled.js';
import { getDisabledOptionalHarness } from './agent-harness/disabled-optional-harness.ts';
import {
  decodeModelValue,
  normalizeCatalogModelValue,
  normalizeChatEnabledModels,
} from './model-catalog.js';
import { getBuiltinHarnessBackend } from './agent-harness/builtin-harness-backends.ts';
import { loadSettings } from './persist/settings.js';
import { getHarnessUsageLimit } from './harness-usage-limits.js';
import { sameCanonicalModel } from './model-identity.js';
import {
  EFFORT_LEVELS,
  EFFORT_LEVEL_ALIASES,
  EFFORT_PARAM_KEYS,
  normalizeEffortParam,
} from './model-effort.js';

const ENABLED_MODEL_KEYS = Object.freeze({
  sdk: 'chatEnabledModels',
  openrouter: 'openrouterChatEnabledModels',
  mistral: 'mistralChatEnabledModels',
  zai: 'zaiChatEnabledModels',
  mimo: 'mimoChatEnabledModels',
  opencode: 'opencodeChatEnabledModels',
  codebuddy: 'codebuddyChatEnabledModels',
  deepseek: 'deepseekChatEnabledModels',
  qwen: 'qwenChatEnabledModels',
  codex: 'codexChatEnabledModels',
  claude: 'claudeChatEnabledModels',
});

/** Effort words accepted in a free-form `model` hint (`grok-4.6 high`). */
// Free-text effort tokens: canonical levels (minus `none`) plus aliases such as extra-high.
const EFFORT_VALUES = Object.freeze([
  ...EFFORT_LEVELS.filter((level) => level !== 'none'),
  ...Object.keys(EFFORT_LEVEL_ALIASES),
]);

export { EFFORT_LEVELS, normalizeEffortParam };

/**
 * Empty Settings favorites: default `deny` matches model_pick (unset = no
 * models). `CRETLI_DELEGATION_EMPTY_FAVORITES=all` restores the pre-migration
 * start behavior (any requested id when the list is empty).
 *
 * @returns {'deny' | 'all'}
 */
export function readDelegationEmptyFavoritesPolicy(env = process.env) {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_EMPTY_FAVORITES',
    defaultValue: 'deny',
    env,
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
 * @param {Record<string, any>} [settings]
 * @param {string} transport
 * @returns {string[]}
 */
function enabledModelIds(settings, transport) {
  const enabledKey = ENABLED_MODEL_KEYS[transport];
  const scoped = settings.delegationRoleFavorites?.[transport];
  const roleIds = scoped && typeof scoped === 'object'
    ? Object.values(scoped).flatMap((value) => normalizeChatEnabledModels(value))
    : [];
  const ids = normalizeChatEnabledModels([...(enabledKey ? normalizeChatEnabledModels(settings[enabledKey]) : []), ...roleIds]);
  // Plugin harnesses clean their favorites through their backend descriptor.
  const backend = getBuiltinHarnessBackend(transport);
  return backend?.normalizeEnabledModels ? backend.normalizeEnabledModels(ids) : ids;
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
  const effortFromParams = normalizeEffortParam(decoded.params).level;
  if (decoded.params && decoded.params.length > 0) {
    return {
      requested,
      modelId: decoded.modelId,
      effort: effortFromParams === 'none' ? '' : effortFromParams,
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
    effort: effortToken ? normalizeEffortParam([{ id: 'effort', value: effortToken }]).level : '',
    params: [],
  };
}

/**
 * Model-id equality shared by model_list, the start gate and the error message:
 * Claude moving aliases (`sonnet`) equal the numbered id they resolve to.
 * Defined in `model-identity.js` so reviewer matching and the session-resume
 * gate share one rule; re-exported here for existing callers.
 */
export { sameCanonicalModel };

/**
 * @param {string} enabledId
 * @param {{ modelId: string, params: import('./model-catalog.js').ModelParameterValue[] }} parsed
 * @returns {boolean}
 */
function isEnabledVariantOfRequest(enabledId, parsed, transport) {
  const decoded = decodeModelValue(enabledId);
  if (!sameCanonicalModel(transport, decoded.modelId, parsed.modelId)) return false;
  if (!Array.isArray(parsed.params) || parsed.params.length === 0) return true;
  // Effort is compared by normalized level, so `reasoning_effort=high` and
  // `effort=high` are the same request.
  const requestedEffort = normalizeEffortParam(parsed.params).level;
  if (requestedEffort !== 'none'
    && normalizeEffortParam(decoded.params).level !== requestedEffort) return false;
  const byId = new Map(
    (decoded.params || []).map((row) => [String(row.id).trim(), String(row.value).trim()]),
  );
  const effortKeys = EFFORT_PARAM_KEYS;
  return parsed.params
    .filter((row) => requestedEffort === 'none' || !effortKeys.includes(String(row.id).trim().toLowerCase()))
    .every((row) => byId.get(row.id) === row.value);
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
  return resolveDelegationModelDetailed(input).model;
}

/**
 * Same resolution as {@link resolveDelegationModel} but explains a refusal.
 * A requested effort that no enabled variant offers is `effort_unavailable`
 * with the efforts that are available; it never falls back to another level.
 *
 * @param {{ transport?: string, model?: string, settings?: Record<string, any>, env?: Record<string, string | undefined> }} [input]
 * @returns {{
 *   model: string,
 *   code: '' | 'effort_unavailable',
 *   requestedEffort: string,
 *   availableEfforts: string[],
 * }}
 */
export function resolveDelegationModelDetailed(input = {}) {
  const found = (model) => ({ model, code: '', requestedEffort: '', availableEfforts: [] });
  const transport = String(input.transport || '').trim();
  if (!hasChatRunAdapter(transport)) return found('');
  const parsed = parseModelRequest(input.model);
  if (!parsed.requested || !parsed.modelId) return found('');
  const settings = input.settings && typeof input.settings === 'object'
    ? input.settings
    : loadSettings();
  if (!isHarnessEnabled(transport, settings.enabledHarnesses) || getDisabledOptionalHarness(transport)) return found('');
  const enabled = enabledModelIds(settings, transport);
  if (!hasConfiguredDelegationFavorites(enabled)) {
    if (readDelegationEmptyFavoritesPolicy(input.env || process.env) === 'all') return found(parsed.requested);
    return found('');
  }
  if (enabled.includes(parsed.requested)) return found(parsed.requested);
  const matched = enabled.filter((id) => isEnabledVariantOfRequest(id, parsed, transport));
  const levelOf = (id) => normalizeEffortParam(decodeModelValue(id).params).level;
  if (matched.length > 0) {
    const byEffort = parsed.effort ? matched.find((id) => levelOf(id) === parsed.effort) : '';
    if (!parsed.effort || byEffort) return found(byEffort || matched[0]);
  }
  const sameModel = enabled.filter((id) => (
    sameCanonicalModel(transport, decodeModelValue(id).modelId, parsed.modelId)
  ));
  if (sameModel.length === 0) return found('');
  const availableEfforts = [...new Set(sameModel.map(levelOf).filter((level) => level !== 'none'))];
  // A model with no effort variants at all has no level to downgrade from.
  if (parsed.effort && availableEfforts.length > 0) {
    const byEffort = sameModel.find((id) => levelOf(id) === parsed.effort);
    if (byEffort) return found(byEffort);
    return { model: '', code: 'effort_unavailable', requestedEffort: parsed.effort, availableEfforts };
  }
  return found(sameModel[0]);
}

/**
 * Compare what a caller asked for with what actually runs, by effort level.
 *
 * @param {string} requested
 * @param {string} resolved
 * @returns {{ requested_model: string, resolved_model: string, model_downgraded: boolean, model_upgraded: boolean }}
 */
export function describeModelResolution(requested, resolved) {
  const rank = (value) => EFFORT_LEVELS.indexOf(
    normalizeEffortParam(decodeModelValue(normalizeCatalogModelValue(value)).params).level,
  );
  const wanted = rank(requested);
  const actual = rank(resolved);
  const requestedModel = String(requested || '').trim();
  const resolvedModel = String(resolved || '').trim();
  return {
    requested_model: requestedModel,
    resolved_model: resolvedModel,
    model_downgraded: wanted > actual && actual >= 0,
    model_upgraded: actual > wanted && wanted >= 0,
  };
}

/**
 * @param {{ requestedEffort?: string, availableEfforts?: string[] }} detail
 * @returns {string}
 */
export function describeEffortUnavailable(detail = {}) {
  const available = Array.isArray(detail.availableEfforts) ? detail.availableEfforts : [];
  return `effort_unavailable: effort=${detail.requestedEffort || '?'} is not enabled for this model; `
    + `available efforts: ${available.join(', ') || 'none'}. `
    + 'Pick one of those or add the variant to Settings favorites; it is never lowered silently.';
}

const ENABLED_MODEL_PREVIEW_LIMIT = 8;

/**
 * Settings-enabled (favorite) model ids for one harness.
 * @param {{ transport?: string, settings?: Record<string, any> }} [input]
 * @returns {string[]}
 */
export function listEnabledDelegationModels(input = {}) {
  const transport = String(input.transport || '').trim();
  if (!hasChatRunAdapter(transport)) return [];
  const settings = input.settings && typeof input.settings === 'object'
    ? input.settings
    : loadSettings();
  if (!isHarnessEnabled(transport, settings.enabledHarnesses) || getDisabledOptionalHarness(transport)) return [];
  return enabledModelIds(settings, transport);
}

/**
 * @param {{ transport?: string, settings?: Record<string, any> }} [input]
 * @returns {string}
 */
export function describeUnavailableDelegationModel(input = {}) {
  const transport = String(input.transport || '').trim();
  const enabled = listEnabledDelegationModels(input);
  if (!hasConfiguredDelegationFavorites(enabled) && readDelegationEmptyFavoritesPolicy(input.env || process.env) === 'deny') {
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
