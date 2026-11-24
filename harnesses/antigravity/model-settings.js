import { t } from '../../app_front/i18n/index.js';
import { enrichCatalogEntryMetaList, groupModelCatalogForSettings } from '../../lib/model-catalog-meta.js';
import { escapeHtml } from '../../app_front/features/chat/chatHtmlUtils.js';
import { replaceChildrenWithHtml } from '../../app_front/features/settings/models/renderHtmlList.js';
import { bindFavoriteModelList, favoriteModelButtonHtml, isFavoriteModel, subscribeToFavoriteModelChanges } from '../../app_front/features/chat/modelFavoriteMarker.js';

const SORT_KEY = 'cretli-antigravity-models-sort';
/** @type {import('../../lib/model-catalog.js').ModelCatalogEntry[]} */
let catalog = [];
let selected = new Set();
let dirty = false;
let initialized = false;
/** @type {'provider' | 'alpha'} */
let sortMode = 'provider';

const element = (name) => document.getElementById(`antigravity-models-${name}`);

export function setModelCatalog(entries, enabled) {
  catalog = enrichCatalogEntryMetaList(entries);
  if (!dirty) selected = new Set(enabled.length ? enabled : catalog.map((entry) => entry.value));
}

/** A save acknowledges only the selection that was actually sent. */
export function noteModelSelectionSaved(saved) {
  if (saved.length === selected.size && saved.every((id) => selected.has(id))) dirty = false;
}

export function getSelectedModels() {
  return Array.from(selected);
}

function rowHtml(entry) {
  return `<label class="chat-model-settings-row">
    <input type="checkbox" class="chat-model-settings-checkbox" value="${escapeHtml(entry.value)}"${selected.has(entry.value) ? ' checked' : ''}>
    <span class="chat-model-settings-row-body">
      <span class="chat-model-settings-label">${favoriteModelButtonHtml('antigravity', entry.value, isFavoriteModel('antigravity', entry.value))}${escapeHtml(entry.label)}</span>
      <span class="chat-model-settings-cost" title="${escapeHtml(t('settings.chatModelsCostTooltip'))}" aria-label="${escapeHtml(t('settings.chatModelsCostTooltip'))}">${escapeHtml(entry.costLabel || '—')}</span>
    </span>
  </label>`;
}

export function renderModelPanel() {
  const list = element('list');
  if (!list) return;
  const search = /** @type {HTMLInputElement | null} */ (element('search'));
  const query = String(search?.value || '').trim().toLowerCase();
  const visible = catalog.filter((entry) => [entry.label, entry.value, entry.group, entry.providerLabel].join(' ').toLowerCase().includes(query));
  const blocks = groupModelCatalogForSettings(visible, sortMode);
  const html = blocks.map((block) => {
    if (block.type === 'flat') return `<div class="chat-model-settings-group chat-model-settings-group-flat">${block.entries.map(rowHtml).join('')}</div>`;
    const count = block.models.reduce((sum, model) => sum + model.entries.length, 0);
    return `<section class="chat-model-settings-provider" data-provider="${escapeHtml(block.provider)}">
      <div class="chat-model-settings-provider-title">
        <span class="chat-model-settings-provider-name">${escapeHtml(block.providerLabel)}</span>
        <span class="chat-model-settings-provider-count">${escapeHtml(t('settings.chatModelsProviderCount', { count }))}</span>
      </div>
      ${block.models.map((model) => `<div class="chat-model-settings-group"><div class="chat-model-settings-group-title">${escapeHtml(model.group)}</div>${model.entries.map(rowHtml).join('')}</div>`).join('')}
    </section>`;
  }).join('');
  replaceChildrenWithHtml(list, visible.length ? html : `<p class="settings-hint">${escapeHtml(t('settings.harnessAntigravityModelsEmpty'))}</p>`);
  const summary = element('summary');
  const enabled = catalog.filter((entry) => selected.has(entry.value)).length;
  if (summary) summary.textContent = selected.size === 0
    ? t('settings.chatModelsAllVisible', { total: catalog.length })
    : t('settings.chatModelsSelected', { enabled, total: catalog.length });
  const toggle = element('toggle-all');
  if (toggle) toggle.textContent = t(enabled === catalog.length && catalog.length > 0 ? 'settings.chatModelsDeselectAll' : 'settings.chatModelsSelectAll');
}

function syncSort() {
  const sort = /** @type {HTMLElement & { options: Array<{ value: string, label: string }>, value: string } | null} */ (element('sort'));
  if (!sort) return;
  sort.options = [
    { value: 'provider', label: t('settings.chatModelsSortProvider') },
    { value: 'alpha', label: t('settings.chatModelsSortAlpha') },
  ];
  sort.value = sortMode;
}

export function initModelPanel() {
  if (initialized) return;
  initialized = true;
  try { sortMode = localStorage.getItem(SORT_KEY) === 'alpha' ? 'alpha' : 'provider'; }
  catch { /* Storage may be unavailable. */ }
  syncSort();
  const list = element('list');
  if (list) {
    bindFavoriteModelList(list, renderModelPanel);
    list.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
      dirty = true;
      // Change only this model so search never discards hidden selections.
      if (input.checked) selected.add(input.value);
      else selected.delete(input.value);
      renderModelPanel();
    });
  }
  subscribeToFavoriteModelChanges(renderModelPanel);
  element('search')?.addEventListener('input', renderModelPanel);
  element('sort')?.addEventListener('change', (event) => {
    const input = /** @type {HTMLSelectElement} */ (event.target);
    sortMode = input.value === 'alpha' ? 'alpha' : 'provider';
    try { localStorage.setItem(SORT_KEY, sortMode); }
    catch { /* Storage may be unavailable. */ }
    renderModelPanel();
  });
  element('toggle-all')?.addEventListener('click', () => {
    const allSelected = catalog.length > 0 && catalog.every((entry) => selected.has(entry.value));
    dirty = true;
    selected = new Set(allSelected ? [] : catalog.map((entry) => entry.value));
    renderModelPanel();
  });
  element('clear')?.addEventListener('click', () => {
    dirty = true;
    selected = new Set();
    renderModelPanel();
  });
  window.addEventListener('cr-lang-changed', () => {
    syncSort();
    renderModelPanel();
  });
}
