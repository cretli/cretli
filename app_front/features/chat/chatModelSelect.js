import { AGENT_MODELS } from '../../config.js';
import '../../components/ui/cr-searchable-select.js';
import { t } from '../../i18n/index.js';
import {
  buildCatalogFromSdkStatusPayload,
  decodeModelValue,
  FALLBACK_AGENT_MODELS,
  filterCatalogByEnabled,
  getCatalogEntryLabel,
  mergeModelCatalogEntries,
  normalizeCatalogModelValue,
  normalizeChatEnabledModels,
  toLegacyModelOptions,
} from '../../../lib/model-catalog.js';
import { listHarnessUiIds, normalizeHarnessUiId, resolveHarnessUiMeta } from '../../core/harness/harnessUiRegistry.js';
import { sortModelOptionsByStrength } from '../../../lib/model-strength-sort.js';
import { setDynamicModelContextWindows } from '../../../lib/sdk/sdk-context-advisory.ts';
import { escapeHtml } from './chatHtmlUtils.js';

const MODEL_STATUS_SHORT_LABELS = {
  active: 'Pisze',
  running: 'Run',
  generating: 'Gen',
  grepping: 'Grep',
  thinking: 'Think',
  reading: 'Read',
  editing: 'Edit',
  question: 'Pyt',
  textarea: 'Tekst',
  awaiting: 'Czeka',
};

/** Preserve server-provided strength metadata through normalized provider catalogs. */
function readModelStrengthMetadata(row) {
  return {
    ...(Number.isFinite(row?.qualityTier) ? { qualityTier: row.qualityTier } : {}),
    ...(Number.isFinite(row?.strengthRank) ? { strengthRank: row.strengthRank } : {}),
  };
}

/**
 * @typedef {Object} ChatModelSelectDeps
 * @property {() => object[]} getChatsForCurrentWorkspace
 * @property {(chat: object) => { tone: string }} getTerminalStateMeta
 * @property {() => string|null} getActiveChatId
 * @property {() => object[]} getChats
 * @property {() => string} getSelectedModel
 * @property {(chat: object) => void} syncChatSdkModeUi
 */

/**
 * @param {ChatModelSelectDeps} deps
 */
export function createChatModelSelect(deps) {
  const {
    getChatsForCurrentWorkspace,
    getTerminalStateMeta,
    getActiveChatId,
    getChats,
    getSelectedModel,
    syncChatSdkModeUi,
  } = deps;

  /**
   * Picker catalog and enabled-model keys per harness, keyed by transport id.
   *
   * @type {Record<string, import('../../../lib/model-catalog.js').ModelCatalogEntry[]>}
   */
  const modelCatalogs = Object.fromEntries(listHarnessUiIds().map((id) => [id, []]));
  modelCatalogs.sdk = FALLBACK_AGENT_MODELS.slice();
  /** @type {Array<{ value: string, label: string }>} */
  let availableAgentModels = toLegacyModelOptions(modelCatalogs.sdk);
  /** @type {Record<string, string[]>} */
  const enabledModelKeys = Object.fromEntries(listHarnessUiIds().map((id) => [id, []]));
  /** @type {string} */
  let pickerHarness = 'sdk';

  /**
   * @param {unknown} harness
   * @returns {string}
   */
  function normalizeModelPickerHarness(harness) {
    return normalizeHarnessUiId(harness, 'sdk');
  }

  /**
   * @param {unknown} harness
   * @returns {{ catalog: import('../../../lib/model-catalog.js').ModelCatalogEntry[], keys: string[] }}
   */
  function getCatalogStateForHarness(harness) {
    const resolved = normalizeModelPickerHarness(harness);
    return { catalog: modelCatalogs[resolved], keys: enabledModelKeys[resolved] };
  }

  /**
   * @param {unknown} [harness]
   */
  function rebuildAvailableAgentModels(harness) {
    const resolvedHarness = normalizeModelPickerHarness(harness);
    pickerHarness = resolvedHarness;
    availableAgentModels = getModelOptionsForHarness(resolvedHarness);
  }

  /** Read a harness catalog without changing the active chat's model picker. */
  function getModelOptionsForHarness(resolvedHarness, { includeDisabled = false } = {}) {
    const { catalog, keys } = getCatalogStateForHarness(resolvedHarness);
    if (includeDisabled) return sortModelOptionsByStrength(catalog).map((row) => ({ ...row }));
    const filtered = resolvedHarness === 'claude' && keys.length > 0
      ? catalog.filter((row) => {
        const effort = Array.isArray(row.params)
          ? row.params.find((param) => param?.id === 'effort')?.value
          : '';
        return keys.includes(row.value)
          || (effort === 'medium' && keys.includes(row.modelId));
      })
      : filterCatalogByEnabled(catalog, keys);
    return toLegacyModelOptions(sortModelOptionsByStrength(filtered));
  }

  /**
   * @param {unknown} harness
   */
  function setModelPickerHarness(harness) {
    rebuildAvailableAgentModels(harness);
  }

  /**
   * Stores the enabled-model keys of a harness and refreshes the picker when it is the active one.
   *
   * @param {unknown} harness
   * @param {unknown} enabledKeys
   */
  function applyEnabledModels(harness, enabledKeys) {
    const id = normalizeModelPickerHarness(harness);
    enabledModelKeys[id] = resolveHarnessUiMeta(id).normalizeEnabledModels(enabledKeys);
    if (pickerHarness === id) rebuildAvailableAgentModels(id);
    refreshModelSelectLabels();
  }

  /**
   * @param {string} harness
   * @returns {boolean}
   */
  function isHarnessActiveInUi(harness) {
    const newModal = document.getElementById('chat-new-modal');
    const isNewChatOpen = !!(newModal && !newModal.hidden);
    if (isNewChatOpen) {
      const harnessSel = document.getElementById('chat-new-harness-select');
      return normalizeModelPickerHarness(harnessSel?.value) === harness;
    }
    const pendingBar = typeof document !== 'undefined'
      ? document.querySelector('cr-sdk-mode-bar')
      : null;
    const pendingHarness = String(pendingBar?.pendingHarness || '').trim();
    if (pendingHarness) {
      return normalizeModelPickerHarness(pendingHarness) === harness;
    }
    return pickerHarness === harness;
  }

  /**
   * Catalog row mappers keyed by `HarnessUiMeta.catalogShape`. Each returns the picker catalog for
   * a models payload, or null when the payload is unusable.
   *
   * @type {Record<string, (payload: any, meta: import('../../core/harness/harnessUiRegistry.js').HarnessUiMeta) => import('../../../lib/model-catalog.js').ModelCatalogEntry[] | null>}
   */
  const CATALOG_SHAPE_MAPPERS = {
    plain: (payload) => mapModelRows(payload, () => ({})),
    slashProvider: (payload) => mapModelRows(payload, (row) => ({ provider: readSlashProvider(row) })),
    scopedSlashProvider: (payload) => mapModelRows(payload, (row) => ({
      provider: readSlashProvider(row),
      contextWindowTokens: Number(row.contextWindowTokens) > 0 ? Number(row.contextWindowTokens) : null,
    })),
    fixedProvider: (payload, meta) => mapModelRows(
      payload,
      () => ({ provider: meta.catalogProvider }),
      () => meta.catalogGroup,
    ),
    claude: (payload) => mapClaudeCatalog(payload),
    codex: (payload) => mapCodexCatalog(payload),
  };

  /**
   * @param {{ id?: unknown }} row
   * @returns {string}
   */
  function readSlashProvider(row) {
    return String(row.id || '').includes('/') ? String(row.id).split('/')[0] : 'other';
  }

  /**
   * @param {any} payload
   * @param {(row: any) => object} extra
   * @param {(row: any) => string | undefined} [groupOf] Fixed group label; defaults to the model name.
   * @returns {import('../../../lib/model-catalog.js').ModelCatalogEntry[] | null}
   */
  function mapModelRows(payload, extra, groupOf = () => undefined) {
    if (!payload?.ok || !Array.isArray(payload.models)) return null;
    return payload.models.map((row) => ({
      ...readModelStrengthMetadata(row),
      value: row.id,
      label: row.name || row.id,
      modelId: row.id,
      group: groupOf(row) || row.name || row.id,
      ...extra(row),
    }));
  }

  /**
   * @param {any} payload
   * @returns {import('../../../lib/model-catalog.js').ModelCatalogEntry[] | null}
   */
  function mapClaudeCatalog(payload) {
    if (!payload?.ok || !Array.isArray(payload.models)) return null;
    const rows = Array.isArray(payload.catalog) && payload.catalog.length > 0
      ? payload.catalog
      : payload.models;
    return rows.map((row) => {
      const value = String(row?.value || row?.id || '').trim();
      if (!value) return null;
      const modelId = String(row?.modelId || row?.id || value).trim();
      const label = String(row?.label || row?.name || value).trim();
      const entry = { value, label, modelId, group: String(row?.group || modelId).trim(), ...readModelStrengthMetadata(row) };
      if (Array.isArray(row?.params) && row.params.length > 0) entry.params = row.params;
      if (row?.variantLabel) entry.variantLabel = String(row.variantLabel);
      if (row?.isDefault === true) entry.isDefault = true;
      return entry;
    }).filter(Boolean);
  }

  /**
   * @param {any} payload
   * @returns {import('../../../lib/model-catalog.js').ModelCatalogEntry[] | null}
   */
  function mapCodexCatalog(payload) {
    if (!payload?.ok) return null;
    const catalogRows = Array.isArray(payload.catalog) ? payload.catalog : [];
    const modelRows = Array.isArray(payload.models) ? payload.models : [];
    return catalogRows.length > 0
      ? catalogRows.map((row) => {
        const value = String(row?.value || row?.modelId || row?.id || '').trim();
        if (!value) return null;
        const label = String(row?.label || row?.name || value).trim();
        const modelId = String(row?.modelId || value).trim();
        const group = String(row?.group || label || modelId).trim();
        /** @type {import('../../../lib/model-catalog.js').ModelCatalogEntry} */
        const entry = { value, label, modelId, group };
        if (row?.variantLabel) entry.variantLabel = String(row.variantLabel);
        if (row?.isDefault === true) entry.isDefault = true;
        if (row?.provider) entry.provider = String(row.provider);
        if (row?.providerLabel) entry.providerLabel = String(row.providerLabel);
        if (Number.isFinite(row?.costTier)) entry.costTier = Number(row.costTier);
        if (Number.isFinite(row?.qualityTier)) entry.qualityTier = Number(row.qualityTier);
        if (Number.isFinite(row?.strengthRank)) entry.strengthRank = Number(row.strengthRank);
        if (Array.isArray(row?.params) && row.params.length > 0) entry.params = row.params;
        return entry;
      }).filter(Boolean)
      : modelRows.map((row) => {
        const id = String(row?.id || '').trim();
        if (!id) return null;
        return {
          value: id,
          label: String(row?.name || id).trim(),
          modelId: id,
          group: String(row?.name || id).trim(),
        };
      }).filter(Boolean);
  }

  /**
   * Applies a harness models payload (`GET …/models`) to the picker catalog.
   *
   * @param {unknown} harness
   * @param {unknown} payload
   * @returns {boolean} Whether the catalog changed.
   */
  function applyAvailableModels(harness, payload) {
    const id = normalizeModelPickerHarness(harness);
    const meta = resolveHarnessUiMeta(id);
    const mapper = CATALOG_SHAPE_MAPPERS[meta.catalogShape];
    const nextCatalog = mapper ? mapper(payload, meta) : null;
    if (!nextCatalog || nextCatalog.length === 0) return false;
    if (meta.scopedCatalogReload) setDynamicModelContextWindows(nextCatalog);
    if (Array.isArray(/** @type {any} */ (payload)?.chatEnabledModels)) {
      enabledModelKeys[id] = meta.normalizeEnabledModels(/** @type {any} */ (payload).chatEnabledModels);
    }
    const unchanged = JSON.stringify(modelCatalogs[id]) === JSON.stringify(nextCatalog);
    if (meta.scopedCatalogReload) {
      // Scoped catalogs refresh whenever their harness is the one on screen, changed or not.
      const hadCatalog = modelCatalogs[id].length > 0;
      if (!(unchanged && hadCatalog)) modelCatalogs[id] = nextCatalog;
      if (isHarnessActiveInUi(id)) {
        rebuildAvailableAgentModels(id);
        refreshModelSelectLabels();
      }
      return !(unchanged && hadCatalog);
    }
    if (unchanged && pickerHarness === id && availableAgentModels.length > 0) return false;
    modelCatalogs[id] = nextCatalog;
    if (pickerHarness === id) rebuildAvailableAgentModels(id);
    return true;
  }

  /**
   * @param {unknown} payload
   * @returns {boolean}
   */
  function applyAvailableModelsFromSdkStatus(payload) {
    let nextCatalog = buildCatalogFromSdkStatusPayload(payload);
    for (const row of AGENT_MODELS) {
      nextCatalog = mergeModelCatalogEntries(nextCatalog, [{
        value: row.value,
        label: row.label,
        modelId: row.value,
        group: row.label,
      }]);
    }
    if (nextCatalog.length === 0) return false;
    setDynamicModelContextWindows(nextCatalog);
    if (Array.isArray(payload?.chatEnabledModels)) {
      enabledModelKeys.sdk = normalizeChatEnabledModels(payload.chatEnabledModels);
    }
    const prevSig = JSON.stringify(modelCatalogs.sdk);
    const nextSig = JSON.stringify(nextCatalog);
    if (prevSig === nextSig && pickerHarness === 'sdk' && availableAgentModels.length > 0) return false;
    modelCatalogs.sdk = nextCatalog;
    if (pickerHarness === 'sdk') rebuildAvailableAgentModels('sdk');
    return true;
  }

  function getModelActivityMap() {
    const map = new Map();
    const list = getChatsForCurrentWorkspace();
    for (const chat of list) {
      const model = chat?.model || 'auto';
      if (!map.has(model)) map.set(model, { total: 0, states: {} });
      const row = map.get(model);
      row.total += 1;
      const tone = getTerminalStateMeta(chat).tone;
      if (MODEL_STATUS_SHORT_LABELS[tone]) {
        row.states[tone] = (row.states[tone] || 0) + 1;
      }
    }
    return map;
  }

  /**
   * @param {string} baseLabel
   * @param {{ total?: number, states?: Record<string, number> }|undefined} stats
   */
  function formatModelOptionLabel(baseLabel, stats) {
    if (!stats || !stats.total) return baseLabel;
    const parts = Object.keys(stats.states)
      .map((tone) => ({ tone, count: stats.states[tone] || 0 }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 2)
      .map((x) => x.count + ' ' + (MODEL_STATUS_SHORT_LABELS[x.tone] || x.tone));
    if (parts.length === 0) return baseLabel + ' (' + stats.total + ')';
    return baseLabel + ' (' + stats.total + '; ' + parts.join(', ') + ')';
  }

  /**
   * @param {HTMLSelectElement|null|undefined} selectEl
   * @param {string} [selectedValue]
   * @param {{ includeMissing?: boolean }} [options]
   */
  function renderModelSelectOptions(selectEl, selectedValue, options = {}) {
    if (!selectEl) return;
    const activity = getModelActivityMap();
    const desiredValue = selectedValue || selectEl.value || 'auto';
    const models = availableAgentModels.slice();
    let resolvedDesired = desiredValue;
    if (resolvedDesired && !models.some((m) => m.value === resolvedDesired) && pickerHarness === 'codex') {
      const mapped = findCodexDefaultVariantValue(resolvedDesired);
      if (mapped) resolvedDesired = mapped;
    }
    if (
      options.includeMissing !== false
      && resolvedDesired
      && !models.some((m) => m.value === resolvedDesired)
    ) {
      models.push({ value: resolvedDesired, label: resolvedDesired });
    }
    selectEl.innerHTML = models.map((m) => {
      const label = formatModelOptionLabel(m.label, activity.get(m.value));
      return '<option value="' + escapeHtml(m.value) + '">' + escapeHtml(label) + '</option>';
    }).join('');
    selectEl.value = resolvedDesired;
  }

  /**
   * @param {string} value
   * @param {string} [harness]
   */
  function getModelLabelByValue(value, harness = '') {
    const preferredCatalog = getCatalogStateForHarness(harness || pickerHarness).catalog;
    return getCatalogEntryLabel(preferredCatalog, value)
      || Object.values(modelCatalogs).reduce(
        (found, catalog) => found || getCatalogEntryLabel(catalog, value),
        '',
      );
  }

  /** @param {HTMLSelectElement|null|undefined} selectEl */
  function getSelectCurrentLabel(selectEl) {
    if (!selectEl) return '';
    const selectedOption = selectEl.selectedOptions && selectEl.selectedOptions[0];
    const label = selectedOption?.textContent || '';
    const trimmed = label.trim();
    if (trimmed) return trimmed;
    return (selectEl.value || '').trim();
  }

  /**
   * @param {HTMLSelectElement|null|undefined} selectEl
   * @returns {Array<{ value: string, label: string }>}
   */
  function readSelectOptions(selectEl) {
    if (!selectEl) return [];
    return Array.from(selectEl.options || []).map((opt) => ({
      value: String(opt.value || ''),
      label: String(opt.textContent || opt.label || opt.value || ''),
    }));
  }

  /**
   * @param {HTMLSelectElement|null|undefined} selectEl
   * @param {{
   *   controlKey: string,
   *   ariaLabel: string,
   *   searchPlaceholder?: string,
   *   emptyLabel?: string,
   *   searchThreshold?: number,
   *   resolvePlaceholder: (el: HTMLSelectElement) => string
   * }} config
   */
  function ensureSearchableSelectBridge(selectEl, config) {
    if (!selectEl) return null;
    if (selectEl[config.controlKey]) return selectEl[config.controlKey];
    const controlEl = document.createElement('cr-searchable-select');
    controlEl.className = 'chat-settings-searchable-select';
    controlEl.size = 'lg';
    controlEl.ariaLabel = config.ariaLabel;
    controlEl.searchPlaceholder = config.searchPlaceholder || t('common.searchDropdownPlaceholder');
    controlEl.emptyLabel = config.emptyLabel || t('common.searchDropdownEmpty');
    controlEl.searchThreshold = Number.isFinite(config.searchThreshold) ? config.searchThreshold : 10;
    const syncFromSelect = () => {
      controlEl.options = readSelectOptions(selectEl);
      controlEl.value = String(selectEl.value || '');
      controlEl.placeholder = config.resolvePlaceholder(selectEl) || '—';
      controlEl.refreshOptions?.();
    };
    const onControlChange = (event) => {
      const nextValue = String(event?.detail?.value || '');
      if (selectEl.value === nextValue) return;
      selectEl.value = nextValue;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const onSelectChange = () => {
      controlEl.value = String(selectEl.value || '');
      controlEl.placeholder = config.resolvePlaceholder(selectEl) || '—';
      controlEl.refreshOptions?.();
    };
    controlEl.addEventListener('cr-change', onControlChange);
    selectEl.addEventListener('change', onSelectChange);
    selectEl.classList.add('chat-settings-select-hidden');
    selectEl.insertAdjacentElement('afterend', controlEl);
    syncFromSelect();
    const bridge = {
      refresh: () => {
        syncFromSelect();
      },
      refreshItems: () => {
        syncFromSelect();
      },
      close: () => {
        controlEl.closeDropdown?.();
      },
      isOpen: () => controlEl.isDropdownOpen?.() === true,
      destroy: () => {
        controlEl.removeEventListener('cr-change', onControlChange);
        selectEl.removeEventListener('change', onSelectChange);
        controlEl.remove();
        selectEl.classList.remove('chat-settings-select-hidden');
        delete selectEl[config.controlKey];
        delete selectEl._floatingDropdownApi;
      },
    };
    selectEl[config.controlKey] = bridge;
    selectEl._floatingDropdownApi = {
      close: () => bridge.close(),
      isOpen: () => bridge.isOpen(),
    };
    return bridge;
  }

  /** @param {HTMLSelectElement|null|undefined} selectEl */
  function ensureFloatingModelSelect(selectEl) {
    if (!selectEl) return null;
    return ensureSearchableSelectBridge(selectEl, {
      controlKey: '_floatingModelControl',
      ariaLabel: 'Model',
      searchThreshold: 8,
      resolvePlaceholder: (el) => {
        const value = String(el.value || 'auto');
        return getModelLabelByValue(value) || getSelectCurrentLabel(el) || '—';
      },
    });
  }

  /** @param {HTMLSelectElement|null|undefined} selectEl */
  function ensureFloatingFolderSelect(selectEl) {
    if (!selectEl) return null;
    return ensureSearchableSelectBridge(selectEl, {
      controlKey: '_floatingFolderControl',
      ariaLabel: t('workspace.folder'),
      searchThreshold: 10,
      resolvePlaceholder: (el) => getSelectCurrentLabel(el) || '—',
    });
  }

  /**
   * @returns {'sdk' | 'openrouter' | 'opencode'}
   */
  function resolveCurrentPickerHarness() {
    const newModal = document.getElementById('chat-new-modal');
    const isNewChatOpen = !!(newModal && !newModal.hidden);
    if (isNewChatOpen) {
      const harnessSel = document.getElementById('chat-new-harness-select');
      return normalizeModelPickerHarness(harnessSel?.value);
    }
    const activeChatId = getActiveChatId();
    const activeChat = activeChatId ? getChats().find((c) => c.id === activeChatId) : null;
    if (activeChat) {
      return normalizeModelPickerHarness(activeChat.agentTransport);
    }
    return pickerHarness;
  }

  /**
   * When the last-used OpenCode model is zai/x but the catalog kept zai-coding-plan/x
   * (or the reverse), pick the sibling so new chats follow Settings → Z.AI provider.
   *
   * @param {Array<{ value: string }>} models
   * @param {string} currentValue
   * @returns {string}
   */
  function findCatalogSiblingModel(models, currentValue) {
    const raw = String(currentValue || '').trim();
    const slashIndex = raw.indexOf('/');
    if (slashIndex <= 0) return '';
    const modelId = raw.slice(slashIndex + 1);
    if (!modelId) return '';
    const match = models.find((row) => {
      const id = String(row?.value || '');
      const i = id.indexOf('/');
      return i > 0 && id.slice(i + 1) === modelId;
    });
    return match?.value || '';
  }

  /**
   * Bare Codex model ids (legacy chats) map to the documented default effort variant.
   *
   * @param {string} currentValue
   * @returns {string}
   */
  function findCodexDefaultVariantValue(currentValue) {
    const raw = String(currentValue || '').trim();
    if (!raw) return '';
    const hit = modelCatalogs.codex.find((row) => row.modelId === raw && row.isDefault);
    return hit?.value || '';
  }

  /**
   * Map a saved SDK favorite onto a current catalog row.
   *
   * @param {string} storedValue
   * @returns {string}
   */
  function resolveSdkPresetModel(storedValue) {
    const normalized = normalizeCatalogModelValue(storedValue);
    const catalog = modelCatalogs.sdk;
    if (catalog.some((row) => normalizeCatalogModelValue(row.value) === normalized)) {
      return normalized;
    }
    const decoded = decodeModelValue(normalized);
    const modelId = normalizeCatalogModelValue(decoded.modelId);
    if (!modelId || modelId.toLowerCase() === 'auto') return normalized;
    const siblings = catalog.filter((row) => normalizeCatalogModelValue(row.modelId) === modelId);
    if (siblings.length === 0) return normalized;
    const defaultRow = siblings.find((row) => row.isDefault === true);
    return normalizeCatalogModelValue(defaultRow?.value || siblings[0]?.value) || normalized;
  }

  /**
   * Updates the new-chat model picker for the selected harness (sync, uses cached catalog).
   * @param {'sdk' | 'openrouter' | 'opencode'} harness
   * @param {{ forceCloseDropdown?: boolean }} [options]
   */
  function refreshNewChatModelPicker(harness, options = {}) {
    const resolvedHarness = normalizeModelPickerHarness(harness);
    setModelPickerHarness(resolvedHarness);
    const newModelSel = document.getElementById('chat-new-model-select');
    if (!newModelSel) return;
    const models = availableAgentModels.slice();
    let nextValue = String(newModelSel.value || '').trim();
    if (!models.some((row) => row.value === nextValue)) {
      const sibling = findCatalogSiblingModel(models, nextValue);
      const codexDefault = resolvedHarness === 'codex'
        ? findCodexDefaultVariantValue(nextValue)
        : '';
      if (sibling) {
        nextValue = sibling;
      } else if (codexDefault) {
        nextValue = codexDefault;
      } else if (resolvedHarness === 'sdk' && models.some((row) => row.value === 'auto')) {
        nextValue = 'auto';
      } else {
        nextValue = models[0]?.value || '';
      }
    }
    const dropdownWasOpen = !options.forceCloseDropdown && newModelSel._floatingModelControl?.isOpen?.() === true;
    renderModelSelectOptions(newModelSel, nextValue || 'auto', { includeMissing: false });
    newModelSel._floatingModelControl?.refresh?.();
    if (dropdownWasOpen) {
      newModelSel._floatingModelControl?.refreshItems?.();
      return;
    }
    newModelSel._floatingModelControl?.close?.();
  }

  function refreshModelSelectLabels() {
    const newModal = document.getElementById('chat-new-modal');
    const isNewChatOpen = !!(newModal && !newModal.hidden);
    const pendingBar = typeof document !== 'undefined'
      ? document.querySelector('cr-sdk-mode-bar')
      : null;
    const pendingHarness = String(pendingBar?.pendingHarness || '').trim();
    if (pendingHarness) {
      setModelPickerHarness(normalizeModelPickerHarness(pendingHarness));
    } else {
      setModelPickerHarness(resolveCurrentPickerHarness());
    }
    const newModelSel = document.getElementById('chat-new-model-select');
    if (newModelSel) {
      if (isNewChatOpen) {
        const harnessSel = document.getElementById('chat-new-harness-select');
        refreshNewChatModelPicker(normalizeModelPickerHarness(harnessSel?.value));
      } else {
        renderModelSelectOptions(newModelSel, newModelSel.value || getSelectedModel() || 'auto');
        newModelSel._floatingModelControl?.refresh?.();
      }
    }
    if (isNewChatOpen) return;
    const activeChatId = getActiveChatId();
    const activeChat = activeChatId ? getChats().find((c) => c.id === activeChatId) : null;
    if (!activeChat) return;
    syncChatSdkModeUi(activeChat);
  }

  function getAvailableAgentModels() {
    return availableAgentModels.slice();
  }

  function getSdkModeBarModelOptions() {
    return availableAgentModels.map((model) => ({
      value: model.value,
      label: model.label,
    }));
  }

  /**
   * Whether a model value is in the enabled list for its harness.
   * An empty enabled list means every model is enabled.
   *
   * @param {unknown} harness
   * @param {unknown} modelValue
   * @returns {boolean}
   */
  function isModelEnabled(harness, modelValue) {
    const { keys } = getCatalogStateForHarness(harness);
    const enabled = normalizeChatEnabledModels(keys);
    if (enabled.length === 0) return true;
    const value = normalizeCatalogModelValue(modelValue);
    if (!value) return false;
    if (normalizeModelPickerHarness(harness) === 'sdk') {
      return enabled.includes(value);
    }
    if (normalizeModelPickerHarness(harness) === 'claude') {
      const entry = getCatalogStateForHarness(harness).catalog.find((row) => row.value === value);
      const effort = Array.isArray(entry?.params)
        ? entry.params.find((param) => param?.id === 'effort')?.value
        : '';
      return enabled.includes(value)
        || Boolean(effort === 'medium' && entry?.modelId && enabled.includes(entry.modelId));
    }
    return enabled.includes(value);
  }

  return {
    applyEnabledModels,
    setModelPickerHarness,
    refreshNewChatModelPicker,
    applyAvailableModelsFromSdkStatus,
    applyAvailableModels,
    refreshModelSelectLabels,
    ensureFloatingModelSelect,
    ensureFloatingFolderSelect,
    getModelLabelByValue,
    resolveSdkPresetModel,
    getAvailableAgentModels,
    getModelOptionsForHarness,
    renderModelSelectOptions,
    getSdkModeBarModelOptions,
    isModelEnabled,
  };
}
