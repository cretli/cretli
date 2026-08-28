/**
 * Settings UI: full SDK model catalog with variants/modes and chat visibility toggles.
 */
import * as api from './core/api/index.js';
import { t } from './i18n/index.js';
import { buildCatalogFromSdkStatusPayload } from '../lib/model-catalog.js';
import {
  enrichCatalogEntryMetaList,
  groupModelCatalogForSettings,
  normalizeModelCatalogSortMode,
} from '../lib/model-catalog-meta.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from './lib/storageKeyAlias.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

const MODEL_SETTINGS_SORT_LS_KEY = 'cretli-chat-models-sort';

/**
 * @param {string} value
 * @returns {string}
 */
/** @type {import('../lib/model-catalog.js').ModelCatalogEntry[]} */
let settingsModelCatalog = [];
/** @type {Set<string>} */
let draftEnabledKeys = new Set();
/** @type {boolean} */
let settingsLoaded = false;
/** @type {import('../lib/model-catalog-meta.js').ModelCatalogSortMode} */
let settingsSortMode = 'provider';

/**
 * @param {unknown} catalog
 * @returns {import('../lib/model-catalog.js').ModelCatalogEntry[]}
 */
function normalizeSettingsCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  return catalog
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const value = String(row.value || row.modelId || '').trim();
      if (!value) return null;
      const label = String(row.label || value).trim();
      const modelId = String(row.modelId || value).trim();
      const group = String(row.group || label || modelId).trim();
      /** @type {import('../lib/model-catalog.js').ModelCatalogEntry} */
      const entry = { value, label, modelId, group };
      if (row.variantLabel) entry.variantLabel = String(row.variantLabel);
      if (row.isDefault === true) entry.isDefault = true;
      if (row.provider) entry.provider = String(row.provider);
      if (row.providerLabel) entry.providerLabel = String(row.providerLabel);
      if (Number.isFinite(row.costTier)) entry.costTier = Number(row.costTier);
      if (row.costLabel) entry.costLabel = String(row.costLabel);
      if (Array.isArray(row.params)) entry.params = row.params;
      return entry;
    })
    .filter(Boolean);
}

function readSettingsSortMode() {
  try {
    const stored = readStorageValueWithAlias(localStorage, MODEL_SETTINGS_SORT_LS_KEY, '');
    return normalizeModelCatalogSortMode(stored);
  } catch {
    return 'provider';
  }
}

function persistSettingsSortMode(mode) {
  settingsSortMode = normalizeModelCatalogSortMode(mode);
  try {
    writeStorageValueWithAlias(localStorage, MODEL_SETTINGS_SORT_LS_KEY, settingsSortMode);
  } catch {
    /* ignore */
  }
}

function syncSortSelectUi() {
  const sortEl = document.getElementById('chat-model-settings-sort');
  if (!(sortEl instanceof HTMLSelectElement)) return;
  sortEl.value = settingsSortMode;
}

/**
 * @param {string} query
 * @returns {import('../lib/model-catalog.js').ModelCatalogEntry[]}
 */
function filterCatalogForSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return settingsModelCatalog.slice();
  return settingsModelCatalog.filter((row) => {
    const haystack = [
      row.label,
      row.group,
      row.modelId,
      row.variantLabel,
      row.providerLabel,
      row.value,
      row.costLabel,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * @param {import('../lib/model-catalog.js').ModelCatalogEntry} entry
 * @param {string} groupName
 * @returns {string}
 */
function resolveRowLabel(entry, groupName) {
  const groupPrefix = groupName + ' — ';
  if (entry.label.startsWith(groupPrefix)) return entry.label.slice(groupPrefix.length);
  if (entry.variantLabel) return entry.variantLabel;
  if (entry.label !== groupName) return entry.label;
  return entry.modelId || entry.value;
}

/**
 * @param {import('../lib/model-catalog.js').ModelCatalogEntry} entry
 * @returns {string}
 */
function renderModelRowHtml(entry, groupName) {
  const checked = draftEnabledKeys.has(entry.value);
  const rowLabel = resolveRowLabel(entry, groupName);
  const costLabel = entry.costLabel || '—';
  const defaultBadge = entry.isDefault
    ? '<span class="chat-model-settings-default-badge">' + escapeHtml(t('settings.chatModelsDefaultBadge')) + '</span>'
    : '';
  return (
    '<label class="chat-model-settings-row">'
    + '<input type="checkbox" class="chat-model-settings-checkbox" data-model-value="'
    + escapeHtml(entry.value)
    + '"'
    + (checked ? ' checked' : '')
    + ' />'
    + '<span class="chat-model-settings-row-body">'
    + '<span class="chat-model-settings-label">'
    + escapeHtml(rowLabel)
    + defaultBadge
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
  const listEl = document.getElementById('chat-model-settings-list');
  const searchInput = document.getElementById('chat-model-settings-search');
  if (!listEl) return;
  const query = searchInput instanceof HTMLInputElement ? searchInput.value : '';
  const visibleRows = filterCatalogForSearch(query);
  if (visibleRows.length === 0) {
    listEl.innerHTML = '<p class="settings-hint">' + escapeHtml(t('settings.chatModelsEmpty')) + '</p>';
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
  const btn = document.getElementById('chat-model-settings-toggle-all-btn');
  if (!btn) return;
  btn.textContent = areAllCatalogModelsSelected()
    ? t('settings.chatModelsDeselectAll')
    : t('settings.chatModelsSelectAll');
  btn.setAttribute(
    'aria-label',
    areAllCatalogModelsSelected()
      ? t('settings.chatModelsDeselectAll')
      : t('settings.chatModelsSelectAll'),
  );
}

function updateModelSettingsSummary() {
  const summaryEl = document.getElementById('chat-model-settings-summary');
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
  const listEl = document.getElementById('chat-model-settings-list');
  if (!listEl) return;
  /** @type {Set<string>} */
  const next = new Set();
  listEl.querySelectorAll('.chat-model-settings-checkbox[data-model-value]').forEach((el) => {
    if (!(el instanceof HTMLInputElement)) return;
    if (!el.checked) return;
    const value = String(el.getAttribute('data-model-value') || '').trim();
    if (!value) return;
    next.add(value);
  });
  draftEnabledKeys = next;
  updateModelSettingsSummary();
}

async function loadModelSettingsData() {
  const statusEl = document.getElementById('chat-model-settings-status');
  const summaryEl = document.getElementById('chat-model-settings-summary');
  if (statusEl) statusEl.textContent = t('settings.chatModelsLoading');
  if (summaryEl) summaryEl.textContent = t('settings.chatModelsLoading');
  try {
    const [sdkData, settingsData] = await Promise.all([
      api.getAgentSdkStatus(),
      api.getSettings(),
    ]);
    settingsModelCatalog = enrichCatalogEntryMetaList(
      normalizeSettingsCatalog(buildCatalogFromSdkStatusPayload(sdkData)),
    );
    const enabledFromSettings = Array.isArray(settingsData?.chatEnabledModels)
      ? settingsData.chatEnabledModels
      : (Array.isArray(sdkData?.chatEnabledModels) ? sdkData.chatEnabledModels : []);
    if (enabledFromSettings.length > 0) {
      setDraftEnabledKeys(enabledFromSettings);
    } else if (!settingsLoaded) {
      setDraftEnabledKeys(settingsModelCatalog.map((row) => row.value));
    }
    settingsLoaded = true;
    syncSortSelectUi();
    renderModelSettingsList();
    if (statusEl) {
      if (sdkData?.ok === false) {
        statusEl.textContent = sdkData?.error || t('settings.chatModelsLoadError');
      } else if (sdkData?.modelsWarning) {
        statusEl.textContent = String(sdkData.modelsWarning);
      } else if (!sdkData?.ready) {
        statusEl.textContent = t('settings.chatModelsEmpty');
      } else {
        statusEl.textContent = '';
      }
    }
  } catch {
    settingsModelCatalog = enrichCatalogEntryMetaList(
      normalizeSettingsCatalog(buildCatalogFromSdkStatusPayload({})),
    );
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

function selectDefaultModelSettings() {
  const defaults = settingsModelCatalog.filter((row) => row.isDefault).map((row) => row.value);
  if (defaults.length === 0) {
    setDraftEnabledKeys(['auto', 'composer-2.5', 'composer-2'].filter((value) =>
      settingsModelCatalog.some((row) => row.value === value),
    ));
  } else {
    setDraftEnabledKeys(defaults);
  }
  renderModelSettingsList();
}

/**
 * Initializes chat model settings panel (Settings → Harness).
 */
export function initModelSettings() {
  const listEl = document.getElementById('chat-model-settings-list');
  const saveBtn = document.getElementById('chat-model-settings-save-btn');
  const toggleAllBtn = document.getElementById('chat-model-settings-toggle-all-btn');
  const clearBtn = document.getElementById('chat-model-settings-clear-btn');
  const defaultsBtn = document.getElementById('chat-model-settings-defaults-btn');
  const searchInput = document.getElementById('chat-model-settings-search');
  const sortSelect = document.getElementById('chat-model-settings-sort');
  const statusEl = document.getElementById('chat-model-settings-status');
  if (!listEl || !saveBtn) return;

  settingsSortMode = readSettingsSortMode();
  syncSortSelectUi();

  listEl.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('chat-model-settings-checkbox')) return;
    readDraftEnabledKeysFromUi();
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => renderModelSettingsList());
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      if (!(sortSelect instanceof HTMLSelectElement)) return;
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
  if (defaultsBtn) {
    defaultsBtn.addEventListener('click', () => selectDefaultModelSettings());
  }

  saveBtn.addEventListener('click', () => {
    readDraftEnabledKeysFromUi();
    const payload = Array.from(draftEnabledKeys);
    if (statusEl) statusEl.textContent = t('settings.chatModelsSaving');
    api.patchSettings({ chatEnabledModels: payload }).then((data) => {
      if (!data?.ok) {
        if (statusEl) statusEl.textContent = data?.error || t('settings.chatModelsSaveError');
        return;
      }
      const savedKeys = data.chatEnabledModels || payload;
      if (statusEl) statusEl.textContent = t('settings.chatModelsSaved');
      window.dispatchEvent(new CustomEvent('cretli-chat-models-changed', {
        detail: { chatEnabledModels: savedKeys },
      }));
    }).catch(() => {
      if (statusEl) statusEl.textContent = t('settings.chatModelsSaveError');
    });
  });
}

export function refreshModelSettingsPanel() {
  void loadModelSettingsData();
}
