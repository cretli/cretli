/**
 * Settings UI: OpenCode model catalog and chat visibility toggles (Harness tab).
 */
import * as api from './core/api/index.js';
import { t } from './i18n/index.js';
import {
  enrichCatalogEntryMetaList,
  groupModelCatalogForSettings,
  normalizeModelCatalogSortMode,
} from '../lib/model-catalog-meta.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from './lib/storageKeyAlias.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

const OPENCODE_MODEL_SETTINGS_SORT_LS_KEY = 'cretli-opencode-models-sort';

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
 * @param {Array<{ id?: string, name?: string }>} models
 * @returns {import('../lib/model-catalog.js').ModelCatalogEntry[]}
 */
function buildCatalogFromOpenCodeModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((row) => {
      const id = String(row?.id || '').trim();
      if (!id) return null;
      const name = String(row?.name || id).trim();
      const provider = id.includes('/') ? id.split('/')[0] : 'other';
      /** @type {import('../lib/model-catalog.js').ModelCatalogEntry} */
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
    const stored = readStorageValueWithAlias(localStorage, OPENCODE_MODEL_SETTINGS_SORT_LS_KEY, '');
    return normalizeModelCatalogSortMode(stored);
  } catch {
    return 'provider';
  }
}

function persistSettingsSortMode(mode) {
  settingsSortMode = normalizeModelCatalogSortMode(mode);
  try {
    writeStorageValueWithAlias(localStorage, OPENCODE_MODEL_SETTINGS_SORT_LS_KEY, settingsSortMode);
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
  const sortEl = document.getElementById('opencode-model-settings-sort');
  if (!isSortSelect(sortEl)) return;
  fillSortOptions(sortEl);
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
    const haystack = [row.label, row.group, row.modelId, row.providerLabel, row.value]
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
function renderModelRowHtml(entry, groupName) {
  const checked = draftEnabledKeys.has(entry.value);
  const rowLabel = entry.label !== groupName ? entry.label : (entry.modelId || entry.value);
  return (
    '<label class="chat-model-settings-row">'
    + '<input type="checkbox" class="opencode-model-settings-checkbox" data-model-value="'
    + escapeHtml(entry.value)
    + '"'
    + (checked ? ' checked' : '')
    + ' />'
    + '<span class="chat-model-settings-row-body">'
    + '<span class="chat-model-settings-label">'
    + escapeHtml(rowLabel)
    + '</span>'
    + '</span>'
    + '</label>'
  );
}

function renderModelSettingsList() {
  const listEl = document.getElementById('opencode-model-settings-list');
  const searchInput = document.getElementById('opencode-model-settings-search');
  if (!listEl) return;
  const query = searchInput ? String(searchInput.value || '') : '';
  const visibleRows = filterCatalogForSearch(query);
  if (visibleRows.length === 0) {
    listEl.innerHTML = '<p class="settings-hint">' + escapeHtml(t('settings.harnessOpenCodeModelsEmpty')) + '</p>';
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
  const btn = document.getElementById('opencode-model-settings-toggle-all-btn');
  if (!btn) return;
  btn.textContent = areAllCatalogModelsSelected()
    ? t('settings.chatModelsDeselectAll')
    : t('settings.chatModelsSelectAll');
}

function updateModelSettingsSummary() {
  const summaryEl = document.getElementById('opencode-model-settings-summary');
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
  const listEl = document.getElementById('opencode-model-settings-list');
  if (!listEl) return;
  /** @type {Set<string>} */
  const next = new Set();
  listEl.querySelectorAll('.opencode-model-settings-checkbox[data-model-value]').forEach((el) => {
    if (!(el instanceof HTMLInputElement)) return;
    if (!el.checked) return;
    const value = String(el.getAttribute('data-model-value') || '').trim();
    if (!value) return;
    next.add(value);
  });
  draftEnabledKeys = next;
  updateModelSettingsSummary();
}

async function refreshOpenCodeStatusPanel() {
  const statusEl = document.getElementById('opencode-harness-status');
  if (!statusEl) return;
  try {
    const data = await api.getOpenCodeStatus();
    if (!data?.opencodeApiKeyEffective) {
      statusEl.textContent = t('settings.harnessOpenCodeNotReadyNoKey');
      return;
    }
    if (!data?.ok || !data.opencodeReady) {
      statusEl.textContent = data?.error || t('settings.harnessOpenCodeNotReady');
      return;
    }
    const providers = Array.isArray(data.connectedProviders) ? data.connectedProviders.join(', ') : '—';
    const version = data.version ? ` · v${data.version}` : '';
    statusEl.textContent = t('settings.harnessOpenCodeReady', { providers, version });
  } catch {
    statusEl.textContent = t('settings.harnessOpenCodeNotReady');
  }
}

async function loadOpenCodeModelSettingsData() {
  const statusEl = document.getElementById('opencode-model-settings-status');
  const summaryEl = document.getElementById('opencode-model-settings-summary');
  if (statusEl) statusEl.textContent = t('settings.chatModelsLoading');
  if (summaryEl) summaryEl.textContent = t('settings.chatModelsLoading');
  void refreshOpenCodeStatusPanel();
  try {
    const settingsData = await api.getSettings();
    const folder = typeof settingsData?.workspaceFolder === 'string' ? settingsData.workspaceFolder.trim() : '';
    const params = folder ? { workspaceFolder: folder } : {};
    const modelsData = await api.getOpenCodeModels(params);
    if (!modelsData?.ok) {
      settingsModelCatalog = [];
      settingsLoaded = true;
      syncSortSelectUi();
      renderModelSettingsList();
      if (statusEl) {
        statusEl.textContent = modelsData?.error || t('settings.harnessOpenCodeModelsEmpty');
      }
      return;
    }
    settingsModelCatalog = enrichCatalogEntryMetaList(
      buildCatalogFromOpenCodeModels(modelsData.models),
    );
    const enabledFromSettings = Array.isArray(settingsData?.opencodeChatEnabledModels)
      ? settingsData.opencodeChatEnabledModels
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
 * Initializes OpenCode model settings panel (Settings → Harness).
 */
export function initOpenCodeModelSettings() {
  const listEl = document.getElementById('opencode-model-settings-list');
  const saveBtn = document.getElementById('opencode-model-settings-save-btn');
  const toggleAllBtn = document.getElementById('opencode-model-settings-toggle-all-btn');
  const clearBtn = document.getElementById('opencode-model-settings-clear-btn');
  const searchInput = document.getElementById('opencode-model-settings-search');
  const sortSelect = document.getElementById('opencode-model-settings-sort');
  const statusEl = document.getElementById('opencode-model-settings-status');
  if (!listEl || !saveBtn) return;

  settingsSortMode = readSettingsSortMode();
  syncSortSelectUi();
  window.addEventListener('cr-lang-changed', () => syncSortSelectUi());

  listEl.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('opencode-model-settings-checkbox')) return;
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
    api.patchSettings({ opencodeChatEnabledModels: payload }).then((data) => {
      if (!data?.ok) {
        if (statusEl) statusEl.textContent = data?.error || t('settings.chatModelsSaveError');
        return;
      }
      const savedKeys = data.opencodeChatEnabledModels || payload;
      if (statusEl) statusEl.textContent = t('settings.chatModelsSaved');
      window.dispatchEvent(new CustomEvent('cretli-opencode-models-changed', {
        detail: { opencodeChatEnabledModels: savedKeys },
      }));
    }).catch(() => {
      if (statusEl) statusEl.textContent = t('settings.chatModelsSaveError');
    });
  });
}

export function refreshOpenCodeModelSettingsPanel() {
  void loadOpenCodeModelSettingsData();
}
