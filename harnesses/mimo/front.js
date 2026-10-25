/**
 * Settings UI: Xiaomi MiMo model catalog and chat visibility toggles (Harness tab).
 */
import * as api from '../../app_front/core/api/index.js';
import { t } from '../../app_front/i18n/index.js';
import {
  enrichCatalogEntryMetaList,
  groupModelCatalogForSettings,
  normalizeModelCatalogSortMode,
} from '../../lib/model-catalog-meta.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../app_front/lib/storageKeyAlias.js';
import { escapeHtml } from '../../app_front/features/chat/chatHtmlUtils.js';
import { bindFavoriteModelList, favoriteModelButtonHtml, isFavoriteModel, subscribeToFavoriteModelChanges } from '../../app_front/features/chat/modelFavoriteMarker.js';

const MIMO_MODEL_SETTINGS_SORT_LS_KEY = 'cretli-mimo-models-sort';
const MIMO_MODEL_SETTINGS_HARNESS = 'mimo';

/**
 * @param {string} value
 * @returns {string}
 */
/** @type {import('../../lib/model-catalog.js').ModelCatalogEntry[]} */
let settingsModelCatalog = [];
/** @type {Set<string>} */
let draftEnabledKeys = new Set();
/** @type {boolean} */
let settingsLoaded = false;
/** @type {import('../../lib/model-catalog-meta.js').ModelCatalogSortMode} */
let settingsSortMode = 'provider';

/**
 * @param {Array<{ id?: string, name?: string }>} models
 * @returns {import('../../lib/model-catalog.js').ModelCatalogEntry[]}
 */
function buildCatalogFromMimoModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((row) => {
      const id = String(row?.id || '').trim();
      if (!id) return null;
      const name = String(row?.name || id).trim();
      const provider = 'mimo';
      /** @type {import('../../lib/model-catalog.js').ModelCatalogEntry} */
      return {
        value: id,
        label: name,
        modelId: id,
        group: name,
        provider,
      };
    })
    .filter(Boolean);
}

function readSettingsSortMode() {
  try {
    const stored = readStorageValueWithAlias(localStorage, MIMO_MODEL_SETTINGS_SORT_LS_KEY, '');
    return normalizeModelCatalogSortMode(stored);
  } catch {
    return 'provider';
  }
}

function persistSettingsSortMode(mode) {
  settingsSortMode = normalizeModelCatalogSortMode(mode);
  try {
    writeStorageValueWithAlias(localStorage, MIMO_MODEL_SETTINGS_SORT_LS_KEY, settingsSortMode);
  } catch {
    /* ignore */
  }
}

/**
 * @param {Element | null} el
 * @returns {boolean}
 */
function isSortSelect(el) {
  return el instanceof HTMLSelectElement || el?.tagName === 'CR-BAR-SELECT';
}

/**
 * @param {Element | null} sortEl
 */
function fillSortOptions(sortEl) {
  if (!sortEl || sortEl.tagName !== 'CR-BAR-SELECT') return;
  sortEl.options = [
    { value: 'provider', label: t('settings.chatModelsSortProvider') },
    { value: 'alpha', label: t('settings.chatModelsSortAlpha') },
  ];
}

function syncSortSelectUi() {
  const sortEl = document.getElementById('mimo-model-settings-sort');
  if (!isSortSelect(sortEl)) return;
  fillSortOptions(sortEl);
  sortEl.value = settingsSortMode;
}

/**
 * @param {string} query
 * @returns {import('../../lib/model-catalog.js').ModelCatalogEntry[]}
 */
function filterCatalogForSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return settingsModelCatalog.slice();
  return settingsModelCatalog.filter((row) => {
    const haystack = [row.label, row.group, row.modelId, row.providerLabel, row.value]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * @param {import('../../lib/model-catalog.js').ModelCatalogEntry} entry
 * @param {string} groupName
 * @returns {string}
 */
function renderModelRowHtml(entry, groupName) {
  const checked = draftEnabledKeys.has(entry.value);
  const rowLabel = entry.label !== groupName ? entry.label : (entry.modelId || entry.value);
  const costLabel = entry.costLabel || '—';
  const favorite = isFavoriteModel(MIMO_MODEL_SETTINGS_HARNESS, entry.value);
  return (
    '<label class="chat-model-settings-row">'
    + '<input type="checkbox" class="mimo-model-settings-checkbox" data-model-value="'
    + escapeHtml(entry.value)
    + '"'
    + (checked ? ' checked' : '')
    + ' />'
    + '<span class="chat-model-settings-row-body">'
    + '<span class="chat-model-settings-label">'
    + favoriteModelButtonHtml(MIMO_MODEL_SETTINGS_HARNESS, entry.value, favorite)
    + escapeHtml(rowLabel)
    + '</span>'
    + '<span class="chat-model-settings-cost" title="'
    + escapeHtml(t('settings.chatModelsCostTooltip'))
    + '" aria-label="'
    + escapeHtml(t('settings.chatModelsCostTooltip'))
    + '">'
    + escapeHtml(costLabel)
    + '</span>'
    + '</span>'
    + '</label>'
  );
}

function renderModelSettingsList() {
  const listEl = document.getElementById('mimo-model-settings-list');
  const searchInput = document.getElementById('mimo-model-settings-search');
  if (!listEl) return;
  const query = searchInput ? String(searchInput.value || '') : '';
  const visibleRows = filterCatalogForSearch(query);
  if (visibleRows.length === 0) {
    listEl.innerHTML = '<p class="settings-hint">' + escapeHtml(t('settings.harnessMimoModelsEmpty')) + '</p>';
    updateModelSettingsSummary();
    updateToggleAllButtonLabel();
    return;
  }
  const grouped = groupModelCatalogForSettings(visibleRows, settingsSortMode);
  const html = [];
  for (const block of grouped) {
    if (block.type === 'flat') {
      html.push('<div class="chat-model-settings-group chat-model-settings-group-flat">');
      for (const entry of block.entries) {
        const groupName = entry.group || entry.modelId || entry.label;
        html.push(renderModelRowHtml(entry, groupName));
      }
      html.push('</div>');
      continue;
    }
    html.push(
      '<section class="chat-model-settings-provider" data-provider="'
      + escapeHtml(block.provider)
      + '">',
    );
    html.push(
      '<div class="chat-model-settings-provider-title">'
      + '<span class="chat-model-settings-provider-name">' + escapeHtml(block.providerLabel) + '</span>'
      + '<span class="chat-model-settings-provider-count">'
      + escapeHtml(t('settings.chatModelsProviderCount', {
        count: block.models.reduce((sum, model) => sum + model.entries.length, 0),
      }))
      + '</span>'
      + '</div>',
    );
    for (const model of block.models) {
      html.push('<div class="chat-model-settings-group">');
      html.push(
        '<div class="chat-model-settings-group-title">'
        + escapeHtml(model.group)
        + '</div>',
      );
      for (const entry of model.entries) {
        html.push(renderModelRowHtml(entry, model.group));
      }
      html.push('</div>');
    }
    html.push('</section>');
  }
  listEl.innerHTML = html.join('');
  updateModelSettingsSummary();
  updateToggleAllButtonLabel();
}

function getAllCatalogModelValues() {
  return settingsModelCatalog.map((row) => row.value);
}

function areAllCatalogModelsSelected() {
  const allValues = getAllCatalogModelValues();
  if (allValues.length === 0) return false;
  return allValues.every((value) => draftEnabledKeys.has(value));
}

function updateToggleAllButtonLabel() {
  const btn = document.getElementById('mimo-model-settings-toggle-all-btn');
  if (!btn) return;
  btn.textContent = areAllCatalogModelsSelected()
    ? t('settings.chatModelsDeselectAll')
    : t('settings.chatModelsSelectAll');
}

function updateModelSettingsSummary() {
  const summaryEl = document.getElementById('mimo-model-settings-summary');
  if (!summaryEl) return;
  const total = settingsModelCatalog.length;
  const enabled = draftEnabledKeys.size;
  if (total === 0) {
    summaryEl.textContent = t('settings.chatModelsLoading');
    return;
  }
  if (enabled === 0) {
    summaryEl.textContent = t('settings.chatModelsAllVisible', { total });
    return;
  }
  summaryEl.textContent = t('settings.chatModelsSelected', { enabled, total });
}

function setDraftEnabledKeys(keys) {
  draftEnabledKeys = new Set(
    (Array.isArray(keys) ? keys : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
}

function readDraftEnabledKeysFromUi() {
  const listEl = document.getElementById('mimo-model-settings-list');
  if (!listEl) return;
  /** @type {Set<string>} */
  const next = new Set();
  listEl.querySelectorAll('.mimo-model-settings-checkbox[data-model-value]').forEach((el) => {
    if (!(el instanceof HTMLInputElement)) return;
    if (!el.checked) return;
    const value = String(el.getAttribute('data-model-value') || '').trim();
    if (!value) return;
    next.add(value);
  });
  draftEnabledKeys = next;
  updateModelSettingsSummary();
}

async function refreshMimoStatusPanel() {
  const statusEl = document.getElementById('mimo-harness-status');
  if (!statusEl) return;
  try {
    const data = await api.getZaiStatus();
    if (!data?.mimoApiKeyEffective) {
      statusEl.textContent = t('settings.harnessMimoNotReadyNoKey');
      return;
    }
    if (!data?.ok || !data.ready) {
      statusEl.textContent = data?.error || t('settings.harnessMimoNotReady');
      return;
    }
    statusEl.textContent = t('settings.harnessMimoReady');
  } catch {
    statusEl.textContent = t('settings.harnessMimoNotReady');
  }
}

async function loadMimoModelSettingsData() {
  const statusEl = document.getElementById('mimo-model-settings-status');
  const summaryEl = document.getElementById('mimo-model-settings-summary');
  if (statusEl) statusEl.textContent = t('settings.chatModelsLoading');
  if (summaryEl) summaryEl.textContent = t('settings.chatModelsLoading');
  void refreshMimoStatusPanel();
  try {
    const [modelsData, settingsData] = await Promise.all([
      api.getMimoModels(),
      api.getSettings(),
    ]);
    if (!modelsData?.ok) {
      settingsModelCatalog = [];
      settingsLoaded = true;
      syncSortSelectUi();
      renderModelSettingsList();
      if (statusEl) {
        statusEl.textContent = modelsData?.error || t('settings.harnessMimoModelsEmpty');
      }
      return;
    }
    settingsModelCatalog = enrichCatalogEntryMetaList(
      buildCatalogFromMimoModels(modelsData.models),
    );
    const enabledFromSettings = Array.isArray(settingsData?.mimoChatEnabledModels)
      ? settingsData.mimoChatEnabledModels
      : (Array.isArray(modelsData?.chatEnabledModels) ? modelsData.chatEnabledModels : []);
    if (enabledFromSettings.length > 0) {
      setDraftEnabledKeys(enabledFromSettings);
    } else if (!settingsLoaded) {
      setDraftEnabledKeys(settingsModelCatalog.map((row) => row.value));
    }
    settingsLoaded = true;
    syncSortSelectUi();
    renderModelSettingsList();
    if (statusEl) statusEl.textContent = '';
  } catch {
    settingsModelCatalog = [];
    settingsLoaded = true;
    syncSortSelectUi();
    renderModelSettingsList();
    if (statusEl) statusEl.textContent = t('settings.chatModelsLoadError');
  }
}

function toggleAllCatalogModelSettings() {
  if (areAllCatalogModelsSelected()) {
    setDraftEnabledKeys([]);
  } else {
    setDraftEnabledKeys(getAllCatalogModelValues());
  }
  renderModelSettingsList();
}

/**
 * Initializes Z.AI model settings panel (Settings → Harness).
 */
export function initMimoModelSettings() {
  const listEl = document.getElementById('mimo-model-settings-list');
  const saveBtn = document.getElementById('mimo-model-settings-save-btn');
  const toggleAllBtn = document.getElementById('mimo-model-settings-toggle-all-btn');
  const clearBtn = document.getElementById('mimo-model-settings-clear-btn');
  const searchInput = document.getElementById('mimo-model-settings-search');
  const sortSelect = document.getElementById('mimo-model-settings-sort');
  const statusEl = document.getElementById('mimo-model-settings-status');
  if (!listEl || !saveBtn) return;
  initMimoCredentialsSettings();
  bindFavoriteModelList(listEl, () => renderModelSettingsList());
  subscribeToFavoriteModelChanges(() => renderModelSettingsList());

  settingsSortMode = readSettingsSortMode();
  syncSortSelectUi();
  window.addEventListener('cr-lang-changed', () => syncSortSelectUi());

  listEl.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('mimo-model-settings-checkbox')) return;
    readDraftEnabledKeysFromUi();
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => renderModelSettingsList());
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      if (!isSortSelect(sortSelect)) return;
      persistSettingsSortMode(sortSelect.value);
      renderModelSettingsList();
    });
  }

  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', () => toggleAllCatalogModelSettings());
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      setDraftEnabledKeys([]);
      renderModelSettingsList();
    });
  }

  saveBtn.addEventListener('click', () => {
    readDraftEnabledKeysFromUi();
    const payload = Array.from(draftEnabledKeys);
    if (statusEl) statusEl.textContent = t('settings.chatModelsSaving');
    api.patchSettings({ mimoChatEnabledModels: payload }).then((data) => {
      if (!data?.ok) {
        if (statusEl) statusEl.textContent = data?.error || t('settings.chatModelsSaveError');
        return;
      }
      const savedKeys = data.mimoChatEnabledModels || payload;
      if (statusEl) statusEl.textContent = t('settings.chatModelsSaved');
      window.dispatchEvent(new CustomEvent('cretli-mimo-models-changed', {
        detail: { mimoChatEnabledModels: savedKeys },
      }));
    }).catch(() => {
      if (statusEl) statusEl.textContent = t('settings.chatModelsSaveError');
    });
  });
}

export function refreshMimoModelSettingsPanel() {
  void loadMimoModelSettingsData();
}

function initMimoCredentialsSettings() {
  const apiKeyInput = document.getElementById('mimo-api-key');
  const saveButton = document.getElementById('mimo-key-save');
  const clearButton = document.getElementById('mimo-key-clear');
  const status = document.getElementById('mimo-key-status');
  const baseUrlInput = document.getElementById('mimo-base-url');
  const baseUrlSave = document.getElementById('mimo-base-url-save');
  const baseUrlStatus = document.getElementById('mimo-base-url-status');
  /** @type {HTMLElement & { value: string, placeholder: string }} */
  const keyControl = apiKeyInput;
  /** @type {HTMLElement & { value: string, placeholder: string }} */
  const baseUrlControl = baseUrlInput;
  api.getSettings().then((settings) => {
    if (!keyControl) return;
    keyControl.placeholder = settings?.mimoApiKeyStoredInSettings ? '••••••••••••••••' : '';
    if (baseUrlControl) baseUrlControl.value = settings?.mimoBaseUrl || '';
  }).catch(() => {});
  if (saveButton && status) {
    saveButton.addEventListener('click', async () => {
      const apiKey = keyControl ? keyControl.value.trim() : '';
      status.textContent = t('common.saving');
      try {
        const result = await api.patchSettings({ ...(apiKey ? { mimoApiKey: apiKey } : {}) });
        if (!result?.ok) {
          status.textContent = result?.error || t('lanSettings.saveError');
          return;
        }
        if (keyControl) keyControl.value = '';
        status.textContent = t('common.saved');
        window.dispatchEvent(new CustomEvent('cretli-mimo-key-changed'));
        void refreshMimoStatusPanel();
      } catch {
        status.textContent = t('lanSettings.connectionError');
      }
    });
  }
  if (clearButton && status) {
    clearButton.addEventListener('click', async () => {
      status.textContent = t('common.removing');
      try {
        const result = await api.patchSettings({ clearMimoApiKey: true });
        status.textContent = result?.ok ? t('common.removed') : (result?.error || t('lanSettings.error'));
        if (result?.ok) {
          window.dispatchEvent(new CustomEvent('cretli-mimo-key-changed'));
          void refreshMimoStatusPanel();
        }
      } catch {
        status.textContent = t('lanSettings.connectionError');
      }
    });
  }
  if (baseUrlSave && baseUrlStatus && baseUrlControl) {
    baseUrlSave.addEventListener('click', async () => {
      baseUrlStatus.textContent = t('common.saving');
      try {
        const raw = String(baseUrlControl.value || '').trim();
        const result = await api.patchSettings({ ...(raw ? { mimoBaseUrl: raw } : { mimoBaseUrl: '' }) });
        if (!result?.ok) {
          baseUrlStatus.textContent = result?.error || t('lanSettings.saveError');
          return;
        }
        baseUrlStatus.textContent = t('common.saved');
        window.dispatchEvent(new CustomEvent('cretli-mimo-key-changed'));
        void refreshMimoStatusPanel();
      } catch {
        baseUrlStatus.textContent = t('lanSettings.connectionError');
      }
    });
  }
}

export { initMimoModelSettings as init, refreshMimoModelSettingsPanel as refresh };
