import { AGENT_MODELS } from '../../config.js';
import '../../components/ui/cr-searchable-select.js';
import { t } from '../../i18n/index.js';
import {
  buildCatalogFromSdkStatusPayload,
  FALLBACK_AGENT_MODELS,
  filterCatalogByEnabled,
  getCatalogEntryLabel,
  mergeModelCatalogEntries,
  normalizeChatEnabledModels,
  toLegacyModelOptions,
} from '../../../lib/model-catalog.js';
import { setDynamicModelContextWindows } from '../../../lib/sdk/sdk-context-advisory.js';
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

  /** @type {import('../../../lib/model-catalog.js').ModelCatalogEntry[]} */
  let sdkModelCatalog = FALLBACK_AGENT_MODELS.slice();
  /** @type {import('../../../lib/model-catalog.js').ModelCatalogEntry[]} */
  let openrouterModelCatalog = [];
  /** @type {import('../../../lib/model-catalog.js').ModelCatalogEntry[]} */
  let opencodeModelCatalog = [];
  /** @type {Array<{ value: string, label: string }>} */
  let availableAgentModels = toLegacyModelOptions(sdkModelCatalog);
  /** @type {string[]} */
  let sdkEnabledModelKeys = [];
  /** @type {string[]} */
  let openrouterEnabledModelKeys = [];
  /** @type {string[]} */
  let opencodeEnabledModelKeys = [];
  /** @type {'sdk' | 'openrouter' | 'opencode'} */
  let pickerHarness = 'sdk';

  /**
   * @param {unknown} harness
   * @returns {'sdk' | 'openrouter' | 'opencode'}
   */
  function normalizeModelPickerHarness(harness) {
    const raw = typeof harness === 'string' ? harness.trim().toLowerCase() : '';
    if (raw === 'openrouter') return 'openrouter';
    if (raw === 'opencode') return 'opencode';
    return 'sdk';
  }

  /**
   * @param {'sdk' | 'openrouter' | 'opencode'} harness
   * @returns {{ catalog: import('../../../lib/model-catalog.js').ModelCatalogEntry[], keys: string[] }}
   */
  function getCatalogStateForHarness(harness) {
    const resolved = normalizeModelPickerHarness(harness);
    if (resolved === 'openrouter') {
      return { catalog: openrouterModelCatalog, keys: openrouterEnabledModelKeys };
    }
    if (resolved === 'opencode') {
      return { catalog: opencodeModelCatalog, keys: opencodeEnabledModelKeys };
    }
    return { catalog: sdkModelCatalog, keys: sdkEnabledModelKeys };
  }

  /**
   * @param {'sdk' | 'openrouter' | 'opencode'} [harness]
   */
  function rebuildAvailableAgentModels(harness) {
    const resolvedHarness = normalizeModelPickerHarness(harness);
    pickerHarness = resolvedHarness;
    const { catalog, keys } = getCatalogStateForHarness(resolvedHarness);
    const filtered = filterCatalogByEnabled(catalog, keys);
    availableAgentModels = toLegacyModelOptions(filtered);
  }

  /**
   * @param {'sdk' | 'openrouter' | 'opencode'} harness
   */
  function setModelPickerHarness(harness) {
    rebuildAvailableAgentModels(harness);
  }

  /**
   * @param {unknown} enabledKeys
   */
  function applyChatEnabledModels(enabledKeys) {
    sdkEnabledModelKeys = normalizeChatEnabledModels(enabledKeys);
    if (pickerHarness === 'sdk') rebuildAvailableAgentModels('sdk');
    refreshModelSelectLabels();
  }

  /**
   * @param {unknown} enabledKeys
   */
  function applyOpenRouterEnabledModels(enabledKeys) {
    openrouterEnabledModelKeys = normalizeChatEnabledModels(enabledKeys);
    if (pickerHarness === 'openrouter') rebuildAvailableAgentModels('openrouter');
    refreshModelSelectLabels();
  }

  /**
   * @param {unknown} enabledKeys
   */
  function applyOpenCodeEnabledModels(enabledKeys) {
    opencodeEnabledModelKeys = normalizeChatEnabledModels(enabledKeys);
    if (pickerHarness === 'opencode') rebuildAvailableAgentModels('opencode');
    refreshModelSelectLabels();
  }

  /**
   * @returns {boolean}
   */
  function isOpenCodeHarnessActiveInUi() {
    const newModal = document.getElementById('chat-new-modal');
    const isNewChatOpen = !!(newModal && !newModal.hidden);
    if (isNewChatOpen) {
      const harnessSel = document.getElementById('chat-new-harness-select');
      return normalizeModelPickerHarness(harnessSel?.value) === 'opencode';
    }
    const pendingBar = typeof document !== 'undefined'
      ? document.querySelector('cr-sdk-mode-bar')
      : null;
    const pendingHarness = String(pendingBar?.pendingHarness || '').trim();
    if (pendingHarness) {
      return normalizeModelPickerHarness(pendingHarness) === 'opencode';
    }
    return pickerHarness === 'opencode';
  }

  /**
   * @param {unknown} payload
   * @returns {boolean}
   */
  function applyAvailableModelsFromOpenCode(payload) {
    if (!payload?.ok || !Array.isArray(payload.models)) return false;
    const nextCatalog = payload.models.map((row) => ({
      value: row.id,
      label: row.name || row.id,
      modelId: row.id,
      group: row.name || row.id,
      provider: String(row.id || '').includes('/') ? String(row.id).split('/')[0] : 'other',
      contextWindowTokens: Number(row.contextWindowTokens) > 0 ? Number(row.contextWindowTokens) : null,
    }));
    if (nextCatalog.length === 0) return false;
    setDynamicModelContextWindows(nextCatalog);
    if (Array.isArray(payload?.chatEnabledModels)) {
      opencodeEnabledModelKeys = normalizeChatEnabledModels(payload.chatEnabledModels);
    }
    const prevSig = JSON.stringify(opencodeModelCatalog);
    const nextSig = JSON.stringify(nextCatalog);
    if (prevSig === nextSig && opencodeModelCatalog.length > 0) {
      if (isOpenCodeHarnessActiveInUi()) {
        rebuildAvailableAgentModels('opencode');
        refreshModelSelectLabels();
      }
      return false;
    }
    opencodeModelCatalog = nextCatalog;
    if (isOpenCodeHarnessActiveInUi()) {
      rebuildAvailableAgentModels('opencode');
      refreshModelSelectLabels();
    }
    return true;
  }

  /**
   * @param {unknown} payload
   * @returns {boolean}
   */
  function applyAvailableModelsFromOpenRouter(payload) {
    if (!payload?.ok || !Array.isArray(payload.models)) return false;
    const nextCatalog = payload.models.map((row) => ({
      value: row.id,
      label: row.name || row.id,
      modelId: row.id,
      group: row.name || row.id,
      provider: String(row.id || '').includes('/') ? String(row.id).split('/')[0] : 'other',
    }));
    if (nextCatalog.length === 0) return false;
    if (Array.isArray(payload?.chatEnabledModels)) {
      openrouterEnabledModelKeys = normalizeChatEnabledModels(payload.chatEnabledModels);
    }
    const prevSig = JSON.stringify(openrouterModelCatalog);
    const nextSig = JSON.stringify(nextCatalog);
    if (prevSig === nextSig && pickerHarness === 'openrouter' && availableAgentModels.length > 0) {
      return false;
    }
    openrouterModelCatalog = nextCatalog;
    if (pickerHarness === 'openrouter') rebuildAvailableAgentModels('openrouter');
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
      sdkEnabledModelKeys = normalizeChatEnabledModels(payload.chatEnabledModels);
    }
    const prevSig = JSON.stringify(sdkModelCatalog);
    const nextSig = JSON.stringify(nextCatalog);
    if (prevSig === nextSig && pickerHarness === 'sdk' && availableAgentModels.length > 0) return false;
    sdkModelCatalog = nextCatalog;
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
   */
  function renderModelSelectOptions(selectEl, selectedValue) {
    if (!selectEl) return;
    const activity = getModelActivityMap();
    const desiredValue = selectedValue || selectEl.value || 'auto';
    const models = availableAgentModels.slice();
    if (desiredValue && !models.some((m) => m.value === desiredValue)) {
      models.push({ value: desiredValue, label: desiredValue });
    }
    selectEl.innerHTML = models.map((m) => {
      const label = formatModelOptionLabel(m.label, activity.get(m.value));
      return '<option value="' + escapeHtml(m.value) + '">' + escapeHtml(label) + '</option>';
    }).join('');
    selectEl.value = desiredValue;
  }

  /** @param {string} value */
  function getModelLabelByValue(value) {
    return getCatalogEntryLabel(sdkModelCatalog, value)
      || getCatalogEntryLabel(openrouterModelCatalog, value)
      || getCatalogEntryLabel(opencodeModelCatalog, value);
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
      if (resolvedHarness === 'sdk' && models.some((row) => row.value === 'auto')) {
        nextValue = 'auto';
      } else {
        nextValue = models[0]?.value || '';
      }
    }
    const dropdownWasOpen = !options.forceCloseDropdown && newModelSel._floatingModelControl?.isOpen?.() === true;
    renderModelSelectOptions(newModelSel, nextValue || 'auto');
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

  return {
    applyChatEnabledModels,
    applyOpenRouterEnabledModels,
    applyOpenCodeEnabledModels,
    setModelPickerHarness,
    refreshNewChatModelPicker,
    applyAvailableModelsFromSdkStatus,
    applyAvailableModelsFromOpenRouter,
    applyAvailableModelsFromOpenCode,
    refreshModelSelectLabels,
    ensureFloatingModelSelect,
    ensureFloatingFolderSelect,
    getModelLabelByValue,
    getAvailableAgentModels,
    renderModelSelectOptions,
    getSdkModeBarModelOptions,
  };
}
