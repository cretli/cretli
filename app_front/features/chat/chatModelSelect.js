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
  /** @type {import('../../../lib/model-catalog.js').ModelCatalogEntry[]} */
  let codebuddyModelCatalog = [];
  /** @type {import('../../../lib/model-catalog.js').ModelCatalogEntry[]} */
  let deepseekModelCatalog = [];
  /** @type {import('../../../lib/model-catalog.js').ModelCatalogEntry[]} */
  let qwenModelCatalog = [];
  /** @type {import('../../../lib/model-catalog.js').ModelCatalogEntry[]} */
  let codexModelCatalog = [];
  /** @type {Array<{ value: string, label: string }>} */
  let availableAgentModels = toLegacyModelOptions(sdkModelCatalog);
  /** @type {string[]} */
  let sdkEnabledModelKeys = [];
  /** @type {string[]} */
  let openrouterEnabledModelKeys = [];
  /** @type {string[]} */
  let opencodeEnabledModelKeys = [];
  /** @type {string[]} */
  let codebuddyEnabledModelKeys = [];
  /** @type {string[]} */
  let deepseekEnabledModelKeys = [];
  /** @type {string[]} */
  let qwenEnabledModelKeys = [];
  /** @type {string[]} */
  let codexEnabledModelKeys = [];
  /** @type {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen'} */
  let pickerHarness = 'sdk';

  /**
   * @param {unknown} harness
   * @returns {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen'}
   */
  function normalizeModelPickerHarness(harness) {
    const raw = typeof harness === 'string' ? harness.trim().toLowerCase() : '';
    if (raw === 'openrouter') return 'openrouter';
    if (raw === 'opencode') return 'opencode';
    if (raw === 'codebuddy') return 'codebuddy';
    if (raw === 'deepseek') return 'deepseek';
    if (raw === 'codex') return 'codex';
    if (raw === 'qwen') return 'qwen';
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
    if (resolved === 'codebuddy') {
      return { catalog: codebuddyModelCatalog, keys: codebuddyEnabledModelKeys };
    }
    if (resolved === 'deepseek') {
      return { catalog: deepseekModelCatalog, keys: deepseekEnabledModelKeys };
    }
    if (resolved === 'qwen') {
      return { catalog: qwenModelCatalog, keys: qwenEnabledModelKeys };
    }
    if (resolved === 'codex') {
      return { catalog: codexModelCatalog, keys: codexEnabledModelKeys };
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
   * @param {unknown} enabledKeys
   */
  function applyCodeBuddyEnabledModels(enabledKeys) {
    codebuddyEnabledModelKeys = normalizeChatEnabledModels(enabledKeys);
    if (pickerHarness === 'codebuddy') rebuildAvailableAgentModels('codebuddy');
    refreshModelSelectLabels();
  }

  /**
   * @param {unknown} enabledKeys
   */
  function applyDeepSeekEnabledModels(enabledKeys) {
    deepseekEnabledModelKeys = normalizeChatEnabledModels(enabledKeys);
    if (pickerHarness === 'deepseek') rebuildAvailableAgentModels('deepseek');
    refreshModelSelectLabels();
  }

  /**
   * @param {unknown} enabledKeys
   */
  function applyQwenEnabledModels(enabledKeys) {
    qwenEnabledModelKeys = normalizeChatEnabledModels(enabledKeys);
    if (pickerHarness === 'qwen') rebuildAvailableAgentModels('qwen');
    refreshModelSelectLabels();
  }

  /**
   * @param {unknown} enabledKeys
   */
  function applyCodexEnabledModels(enabledKeys) {
    codexEnabledModelKeys = normalizeChatEnabledModels(enabledKeys);
    if (pickerHarness === 'codex') rebuildAvailableAgentModels('codex');
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
  function applyAvailableModelsFromCodeBuddy(payload) {
    if (!payload?.ok || !Array.isArray(payload.models)) return false;
    const nextCatalog = payload.models.map((row) => ({
      value: row.id,
      label: row.name || row.id,
      modelId: row.id,
      group: row.name || row.id,
    }));
    if (nextCatalog.length === 0) return false;
    if (Array.isArray(payload?.chatEnabledModels)) {
      codebuddyEnabledModelKeys = normalizeChatEnabledModels(payload.chatEnabledModels);
    }
    const prevSig = JSON.stringify(codebuddyModelCatalog);
    const nextSig = JSON.stringify(nextCatalog);
    if (prevSig === nextSig && pickerHarness === 'codebuddy' && availableAgentModels.length > 0) {
      return false;
    }
    codebuddyModelCatalog = nextCatalog;
    if (pickerHarness === 'codebuddy') rebuildAvailableAgentModels('codebuddy');
    return true;
  }

  /**
   * @param {unknown} payload
   * @returns {boolean}
   */
  function applyAvailableModelsFromDeepSeek(payload) {
    if (!payload?.ok || !Array.isArray(payload.models)) return false;
    const nextCatalog = payload.models.map((row) => ({
      value: row.id,
      label: row.name || row.id,
      modelId: row.id,
      group: row.name || row.id,
    }));
    if (nextCatalog.length === 0) return false;
    if (Array.isArray(payload?.chatEnabledModels)) {
      deepseekEnabledModelKeys = normalizeChatEnabledModels(payload.chatEnabledModels);
    }
    const prevSig = JSON.stringify(deepseekModelCatalog);
    const nextSig = JSON.stringify(nextCatalog);
    if (prevSig === nextSig && pickerHarness === 'deepseek' && availableAgentModels.length > 0) {
      return false;
    }
    deepseekModelCatalog = nextCatalog;
    if (pickerHarness === 'deepseek') rebuildAvailableAgentModels('deepseek');
    return true;
  }

  /**
   * @param {unknown} payload
   * @returns {boolean}
   */
  function applyAvailableModelsFromQwen(payload) {
    if (!payload?.ok || !Array.isArray(payload.models)) return false;
    const nextCatalog = payload.models.map((row) => ({
      value: row.id,
      label: row.name || row.id,
      modelId: row.id,
      group: row.name || row.id,
    }));
    if (nextCatalog.length === 0) return false;
    if (Array.isArray(payload?.chatEnabledModels)) {
      qwenEnabledModelKeys = normalizeChatEnabledModels(payload.chatEnabledModels);
    }
    const prevSig = JSON.stringify(qwenModelCatalog);
    const nextSig = JSON.stringify(nextCatalog);
    if (prevSig === nextSig && pickerHarness === 'qwen' && availableAgentModels.length > 0) {
      return false;
    }
    qwenModelCatalog = nextCatalog;
    if (pickerHarness === 'qwen') rebuildAvailableAgentModels('qwen');
    return true;
  }

  /**
   * @param {unknown} payload
   * @returns {boolean}
   */
  function applyAvailableModelsFromCodex(payload) {
    if (!payload?.ok) return false;
    const catalogRows = Array.isArray(payload.catalog) ? payload.catalog : [];
    const modelRows = Array.isArray(payload.models) ? payload.models : [];
    const nextCatalog = catalogRows.length > 0
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
    if (nextCatalog.length === 0) return false;
    if (Array.isArray(payload?.chatEnabledModels)) {
      codexEnabledModelKeys = normalizeChatEnabledModels(payload.chatEnabledModels);
    }
    const prevSig = JSON.stringify(codexModelCatalog);
    const nextSig = JSON.stringify(nextCatalog);
    if (prevSig === nextSig && pickerHarness === 'codex' && availableAgentModels.length > 0) {
      return false;
    }
    codexModelCatalog = nextCatalog;
    if (pickerHarness === 'codex') rebuildAvailableAgentModels('codex');
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
      || getCatalogEntryLabel(sdkModelCatalog, value)
      || getCatalogEntryLabel(openrouterModelCatalog, value)
      || getCatalogEntryLabel(opencodeModelCatalog, value)
      || getCatalogEntryLabel(codebuddyModelCatalog, value)
      || getCatalogEntryLabel(deepseekModelCatalog, value)
      || getCatalogEntryLabel(qwenModelCatalog, value)
      || getCatalogEntryLabel(codexModelCatalog, value);
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
    const hit = codexModelCatalog.find((row) => row.modelId === raw && row.isDefault);
    return hit?.value || '';
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

  return {
    applyChatEnabledModels,
    applyOpenRouterEnabledModels,
    applyOpenCodeEnabledModels,
    applyCodeBuddyEnabledModels,
    applyDeepSeekEnabledModels,
    applyQwenEnabledModels,
    applyCodexEnabledModels,
    setModelPickerHarness,
    refreshNewChatModelPicker,
    applyAvailableModelsFromSdkStatus,
    applyAvailableModelsFromOpenRouter,
    applyAvailableModelsFromOpenCode,
    applyAvailableModelsFromCodeBuddy,
    applyAvailableModelsFromDeepSeek,
    applyAvailableModelsFromQwen,
    applyAvailableModelsFromCodex,
    refreshModelSelectLabels,
    ensureFloatingModelSelect,
    ensureFloatingFolderSelect,
    getModelLabelByValue,
    getAvailableAgentModels,
    renderModelSelectOptions,
    getSdkModeBarModelOptions,
  };
}
