/**
 * Front-end composition root for harness UI metadata
 * (docs/ts-migration-and-core-harnesses-plan.md, B2). Labels, Settings tabs,
 * first-run fields, model-refresh events and the other per-transport facts the
 * chat UI used to encode as `if (transport === 'qwen')` ladders live here, so
 * the rest of the front end reads them through the lookups below and never
 * names a non-core harness itself.
 *
 * Entry order is the order of the mode-bar harness picker. Core harnesses are
 * `claude`, `sdk` (Cursor) and `codex`; every transport of
 * `lib/agent-transport.js` has an entry (tests/harness-ui-registry.test.js).
 */

import { normalizeChatEnabledModels } from '../../../lib/model-catalog.js';

/**
 * @typedef {Object} HarnessFirstRunKeyKind
 * @property {string} value
 * @property {string} labelKey i18n key of the option label.
 * @property {string} keyField Settings field that stores the key.
 * @property {string | null} provider Value saved to `providerField`; null saves no provider.
 */

/**
 * @typedef {Object} HarnessFirstRunKeyKinds
 * @property {string} defaultKind
 * @property {string} providerField Settings field that stores the chosen provider.
 * @property {readonly HarnessFirstRunKeyKind[]} kinds
 */

/**
 * @typedef {Object} HarnessUiMeta
 * @property {string} id Transport id.
 * @property {boolean} core Claude, Cursor SDK and Codex.
 * @property {string} label Display label (chat header, launch label).
 * @property {string} barLabel Label in the mode-bar harness picker.
 * @property {string} launchLabel Prefix of the session launch label.
 * @property {boolean} modeBarNormalized False when the mode bar does not recognise the id and
 *   falls back (kept as it was: `mimo` is listed in the picker but not normalized).
 * @property {string} settingsLabelKey i18n key of the Settings harness label.
 * @property {string} settingsTab Settings tab id of the harness.
 * @property {string | null} statusMissingKey i18n key shown when the backend is unavailable;
 *   null when the harness only reports "needs key".
 * @property {string} firstRunKeyField Settings field that stores the API key from the first-run dialog.
 * @property {string} firstRunHintKey i18n key of the first-run hint.
 * @property {'always' | 'unlessFalse' | 'whenTrue'} firstRunAvailability When the first-run dialog offers it,
 *   based on `status[id].available`.
 * @property {number} firstRunRank Position in the first-run dialog.
 * @property {Record<string, string> | undefined} firstRunPayload Extra Settings fields saved with the first-run key.
 * @property {HarnessFirstRunKeyKinds | undefined} firstRunKeyKinds Credential flavours the first-run dialog lets the user choose from.
 * @property {string} modelsChangedEvent Window event fired after the model Settings panel saves.
 * @property {string} enabledModelsSettingsKey Settings / event-detail field with the enabled chat models.
 * @property {(keys: unknown) => string[]} normalizeEnabledModels
 * @property {string} newChatErrorKey i18n key of the new-chat readiness error.
 * @property {string | null} contextTransportLabelKey i18n key of the context-details transport label;
 *   null falls back to the raw transport id.
 * @property {string | null} modelsApiMethod Method of the `api` module that loads the model catalog;
 *   null when the harness has a dedicated loader.
 * @property {boolean} scopedCatalogReload Catalog depends on chat scope and is reloaded by a dedicated loader.
 * @property {boolean} catalogConfirmedReadiness Readiness is only trusted once the catalog lists models.
 * @property {boolean} refreshStatusOnModelsChanged Re-run the new-chat status check after a models change.
 * @property {boolean} resyncPickersOnModelsChanged Rebuild the combined pickers after a models change.
 * @property {boolean} modelsChangedCarriesCatalog The models-changed event may carry the refreshed catalog.
 * @property {'plain' | 'slashProvider' | 'fixedProvider' | 'scopedSlashProvider' | 'sdk' | 'claude' | 'codex'} catalogShape
 *   How `GET …/models` rows map onto picker catalog entries (chatModelSelect.js).
 * @property {string} [catalogGroup] Fixed picker group for `fixedProvider` catalogs.
 * @property {string} [catalogProvider] Fixed provider for `fixedProvider` catalogs.
 */

const NO_FLAGS = {
  modeBarNormalized: true,
  scopedCatalogReload: false,
  catalogConfirmedReadiness: false,
  refreshStatusOnModelsChanged: false,
  resyncPickersOnModelsChanged: false,
  modelsChangedCarriesCatalog: false,
  catalogGroup: undefined,
  catalogProvider: undefined,
  firstRunPayload: undefined,
  firstRunKeyKinds: undefined,
  normalizeEnabledModels: normalizeChatEnabledModels,
};

/**
 * Favorite-id normalizers contributed by optional harness plugins (their panel
 * module exports `normalizeEnabledModels`), set when the plugin is activated.
 *
 * @type {Map<string, (keys: unknown) => string[]>}
 */
const ENABLED_MODELS_NORMALIZER_OVERRIDES = new Map();

/**
 * @param {string} id
 * @param {(keys: unknown) => string[]} normalize
 */
export function registerHarnessEnabledModelsNormalizer(id, normalize) {
  ENABLED_MODELS_NORMALIZER_OVERRIDES.set(id, normalize);
}

/**
 * @param {Partial<HarnessUiMeta> & { id: string }} entry
 * @returns {Readonly<HarnessUiMeta>}
 */
function define(entry) {
  const meta = /** @type {HarnessUiMeta} */ ({ ...NO_FLAGS, ...entry });
  if (!entry.normalizeEnabledModels) {
    meta.normalizeEnabledModels = (keys) => (ENABLED_MODELS_NORMALIZER_OVERRIDES.get(entry.id) || normalizeChatEnabledModels)(keys);
  }
  return Object.freeze(meta);
}

/** @type {readonly Readonly<HarnessUiMeta>[]} */
const ENTRIES = Object.freeze([
  define({
    id: 'sdk', core: true, label: 'SDK', barLabel: 'Cursor SDK', launchLabel: '@cursor/sdk',
    settingsLabelKey: 'settings.harnessSdk', settingsTab: 'harness-sdk',
    statusMissingKey: 'settings.harnessStatusSdkMissing',
    firstRunKeyField: 'cursorApiKey', firstRunHintKey: 'firstRun.hintSdk', firstRunAvailability: 'unlessFalse', firstRunRank: 2,
    modelsChangedEvent: 'cretli-chat-models-changed', enabledModelsSettingsKey: 'chatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorSdk', contextTransportLabelKey: 'chat.contextDetailsTransportSdk',
    modelsApiMethod: null, catalogShape: 'sdk',
  }),
  define({
    id: 'openrouter', core: false, label: 'OpenRouter', barLabel: 'OpenRouter', launchLabel: 'OpenRouter',
    settingsLabelKey: 'settings.harnessOpenRouter', settingsTab: 'harness-openrouter',
    statusMissingKey: null,
    firstRunKeyField: 'openrouterApiKey', firstRunHintKey: 'firstRun.hintOpenRouter', firstRunAvailability: 'always', firstRunRank: 0,
    modelsChangedEvent: 'cretli-openrouter-models-changed', enabledModelsSettingsKey: 'openrouterChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorOpenrouter', contextTransportLabelKey: 'chat.contextDetailsTransportOpenrouter',
    modelsApiMethod: 'getOpenRouterModels', catalogShape: 'slashProvider',
  }),
  define({
    id: 'opencode', core: false, label: 'OpenCode', barLabel: 'OpenCode', launchLabel: 'OpenCode',
    settingsLabelKey: 'settings.harnessOpenCode', settingsTab: 'harness-opencode',
    statusMissingKey: null,
    firstRunKeyField: 'opencodeApiKey', firstRunHintKey: 'firstRun.hintOpenCode', firstRunAvailability: 'always', firstRunRank: 1,
    modelsChangedEvent: 'cretli-opencode-models-changed', enabledModelsSettingsKey: 'opencodeChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorOpencode', contextTransportLabelKey: 'chat.contextDetailsTransportOpencode',
    modelsApiMethod: null, catalogShape: 'scopedSlashProvider',
    scopedCatalogReload: true, catalogConfirmedReadiness: true, resyncPickersOnModelsChanged: true,
    firstRunKeyKinds: {
      defaultKind: 'zai-coding-plan',
      providerField: 'opencodeZaiProvider',
      kinds: [
        { value: 'zai-coding-plan', labelKey: 'firstRun.opencodeKeyKindCodingPlan', keyField: 'opencodeZaiApiKey', provider: 'zai-coding-plan' },
        { value: 'zai', labelKey: 'firstRun.opencodeKeyKindApi', keyField: 'opencodeZaiApiKey', provider: 'zai' },
        { value: 'zen', labelKey: 'firstRun.opencodeKeyKindZen', keyField: 'opencodeApiKey', provider: null },
      ],
    },
  }),
  define({
    id: 'codebuddy', core: false, label: 'CodeBuddy', barLabel: 'CodeBuddy', launchLabel: 'CodeBuddy',
    settingsLabelKey: 'settings.harnessCodeBuddy', settingsTab: 'harness-codebuddy',
    statusMissingKey: 'settings.harnessStatusCodeBuddyMissing',
    firstRunKeyField: 'codebuddyApiKey', firstRunHintKey: 'firstRun.hintCodeBuddy', firstRunAvailability: 'whenTrue', firstRunRank: 3,
    modelsChangedEvent: 'cretli-codebuddy-models-changed', enabledModelsSettingsKey: 'codebuddyChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorCodeBuddy', contextTransportLabelKey: 'chat.contextDetailsTransportCodeBuddy',
    modelsApiMethod: 'getCodeBuddyModels', catalogShape: 'plain',
  }),
  define({
    id: 'deepseek', core: false, label: 'DeepSeek', barLabel: 'DeepSeek', launchLabel: 'DeepSeek',
    settingsLabelKey: 'settings.harnessDeepSeek', settingsTab: 'harness-deepseek',
    statusMissingKey: 'settings.harnessStatusDeepSeekMissing',
    firstRunKeyField: 'deepseekApiKey', firstRunHintKey: 'firstRun.hintDeepSeek', firstRunAvailability: 'whenTrue', firstRunRank: 4,
    modelsChangedEvent: 'cretli-deepseek-models-changed', enabledModelsSettingsKey: 'deepseekChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorDeepSeek', contextTransportLabelKey: 'chat.contextDetailsTransportDeepSeek',
    modelsApiMethod: 'getDeepSeekModels', catalogShape: 'plain',
  }),
  define({
    id: 'mistral', core: false, label: 'Mistral', barLabel: 'Mistral', launchLabel: 'Mistral',
    settingsLabelKey: 'settings.harnessMistral', settingsTab: 'harness-mistral',
    statusMissingKey: 'settings.harnessStatusMistralMissing',
    firstRunKeyField: 'mistralApiKey', firstRunHintKey: 'firstRun.hintMistral', firstRunAvailability: 'whenTrue', firstRunRank: 5,
    modelsChangedEvent: 'cretli-mistral-models-changed', enabledModelsSettingsKey: 'mistralChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorMistral', contextTransportLabelKey: 'chat.contextDetailsTransportMistral',
    modelsApiMethod: 'getMistralModels', catalogShape: 'plain',
  }),
  define({
    id: 'zai', core: false, label: 'Z.AI SDK', barLabel: 'Z.AI SDK', launchLabel: 'Z.AI SDK',
    settingsLabelKey: 'settings.harnessZai', settingsTab: 'harness-zai',
    statusMissingKey: 'settings.harnessStatusZaiMissing',
    firstRunKeyField: 'zaiApiKey', firstRunHintKey: 'firstRun.hintZai', firstRunAvailability: 'whenTrue', firstRunRank: 6,
    modelsChangedEvent: 'cretli-zai-models-changed', enabledModelsSettingsKey: 'zaiChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorZai', contextTransportLabelKey: null,
    modelsApiMethod: 'getZaiModels', catalogShape: 'fixedProvider', catalogGroup: 'Z.AI', catalogProvider: 'zai',
    refreshStatusOnModelsChanged: true,
    firstRunPayload: { zaiProvider: 'zai-coding-plan' },
  }),
  define({
    id: 'mimo', core: false, label: 'MiMo', barLabel: 'MiMo', launchLabel: 'MiMo',
    modeBarNormalized: false,
    settingsLabelKey: 'settings.harnessMimo', settingsTab: 'harness-mimo',
    statusMissingKey: 'settings.harnessStatusMimoMissing',
    firstRunKeyField: 'mimoApiKey', firstRunHintKey: 'firstRun.hintMimo', firstRunAvailability: 'whenTrue', firstRunRank: 7,
    modelsChangedEvent: 'cretli-mimo-models-changed', enabledModelsSettingsKey: 'mimoChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorMimo', contextTransportLabelKey: null,
    modelsApiMethod: 'getMimoModels', catalogShape: 'fixedProvider', catalogGroup: 'MiMo', catalogProvider: 'mimo',
    refreshStatusOnModelsChanged: true,
  }),
  define({
    id: 'qwen', core: false, label: 'Qwen', barLabel: 'Qwen', launchLabel: 'Qwen',
    settingsLabelKey: 'settings.harnessQwen', settingsTab: 'harness-qwen',
    statusMissingKey: 'settings.harnessStatusQwenMissing',
    firstRunKeyField: 'qwenApiKey', firstRunHintKey: 'firstRun.hintQwen', firstRunAvailability: 'whenTrue', firstRunRank: 8,
    modelsChangedEvent: 'cretli-qwen-models-changed', enabledModelsSettingsKey: 'qwenChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorQwen', contextTransportLabelKey: 'chat.contextDetailsTransportQwen',
    modelsApiMethod: 'getQwenModels', catalogShape: 'plain',
  }),
  define({
    id: 'codex', core: true, label: 'Codex', barLabel: 'Codex', launchLabel: 'Codex',
    settingsLabelKey: 'settings.harnessCodex', settingsTab: 'harness-codex',
    statusMissingKey: 'settings.harnessStatusCodexMissing',
    firstRunKeyField: 'codexApiKey', firstRunHintKey: 'firstRun.hintCodex', firstRunAvailability: 'whenTrue', firstRunRank: 10,
    modelsChangedEvent: 'cretli-codex-models-changed', enabledModelsSettingsKey: 'codexChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorCodex', contextTransportLabelKey: 'chat.contextDetailsTransportCodex',
    modelsApiMethod: 'getCodexModels', catalogShape: 'codex', modelsChangedCarriesCatalog: true,
  }),
  define({
    id: 'claude', core: true, label: 'Claude', barLabel: 'Claude', launchLabel: 'Claude',
    settingsLabelKey: 'settings.harnessClaude', settingsTab: 'harness-claude',
    statusMissingKey: 'settings.harnessStatusClaudeMissing',
    firstRunKeyField: 'claudeApiKey', firstRunHintKey: 'firstRun.hintClaude', firstRunAvailability: 'whenTrue', firstRunRank: 9,
    modelsChangedEvent: 'cretli-claude-models-changed', enabledModelsSettingsKey: 'claudeChatEnabledModels',
    newChatErrorKey: 'chat.harnessErrorClaude', contextTransportLabelKey: 'chat.contextDetailsTransportClaude',
    modelsApiMethod: 'getClaudeModels', catalogShape: 'claude',
  }),
]);

/** @type {ReadonlyMap<string, Readonly<HarnessUiMeta>>} */
const BY_ID = new Map(ENTRIES.map((entry) => [entry.id, entry]));

/**
 * @returns {readonly Readonly<HarnessUiMeta>[]} Every transport, in mode-bar picker order.
 */
export function listHarnessUiMeta() {
  return ENTRIES;
}

/**
 * @returns {string[]}
 */
export function listHarnessUiIds() {
  return ENTRIES.map((entry) => entry.id);
}

/**
 * @param {unknown} id
 * @returns {Readonly<HarnessUiMeta> | null}
 */
export function getHarnessUiMeta(id) {
  return typeof id === 'string' ? BY_ID.get(id) || null : null;
}

/**
 * Like `getHarnessUiMeta`, but an unknown id resolves to the Cursor SDK entry (the app-wide default).
 *
 * @param {unknown} id
 * @returns {Readonly<HarnessUiMeta>}
 */
export function resolveHarnessUiMeta(id) {
  return getHarnessUiMeta(id) || /** @type {Readonly<HarnessUiMeta>} */ (BY_ID.get('sdk'));
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isKnownHarnessUiId(id) {
  return getHarnessUiMeta(id) !== null;
}

/**
 * Trims and lower-cases `value`; returns it when it is a known transport id, else `fallback`.
 *
 * @template {string} F
 * @param {unknown} value
 * @param {F} fallback
 * @returns {string | F}
 */
export function normalizeHarnessUiId(value, fallback) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BY_ID.has(raw) ? raw : fallback;
}

/**
 * Harnesses offered by the first-run dialog, in dialog order.
 *
 * @returns {Readonly<HarnessUiMeta>[]}
 */
export function listFirstRunHarnessMeta() {
  return ENTRIES.slice().sort((a, b) => a.firstRunRank - b.firstRunRank);
}
