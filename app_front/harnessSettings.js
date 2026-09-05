/**
 * Harness tab: enable/disable backends and the default new-chat harness.
 */
import * as api from './core/api/index.js';
import { t } from './i18n/index.js';
import {
  DEFAULT_HARNESS_ORDER,
  isHarnessEnabled,
  listEnabledHarnesses,
  normalizeHarnessOrder,
} from '../lib/harness-enabled.js';
import { initHarnessOrderDrag } from './features/chat/harnessOrderDrag.js';
import {
  loadHarnessModelUsage,
  readHarnessModelUsage,
} from './features/chat/harnessModelUsage.js';

/** @typedef {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen'} NewChatHarness */

/** @type {NewChatHarness} */
let cachedDefaultHarness = 'sdk';
/** @type {string[]} */
let cachedHarnessOrder = DEFAULT_HARNESS_ORDER.slice();
/** @type {string[]} */
let cachedEnabledHarnesses = listEnabledHarnesses(undefined, cachedHarnessOrder);
/** @type {object|null} */
let cachedHarnessStatus = null;
/** @type {Record<string, { enabled: number, total: number }>} */
let cachedHarnessModelUsage = Object.create(null);
let harnessSettingsLoadSeq = 0;

/**
 * @param {unknown} value
 * @returns {NewChatHarness}
 */
function normalizeDefaultHarness(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'opencode') return 'opencode';
  if (raw === 'codebuddy') return 'codebuddy';
  if (raw === 'deepseek') return 'deepseek';
  if (raw === 'codex') return 'codex';
  if (raw === 'qwen') return 'qwen';
  return 'sdk';
}

/**
 * @returns {NewChatHarness}
 */
export function getDefaultNewChatHarness() {
  return cachedDefaultHarness;
}

/**
 * @returns {string[]}
 */
export function getEnabledHarnessIds() {
  return cachedEnabledHarnesses.slice();
}

/**
 * @returns {string[]}
 */
export function getHarnessOrder() {
  return cachedHarnessOrder.slice();
}

/**
 * @param {unknown} ids
 */
export function applyHarnessOrder(ids) {
  cachedHarnessOrder = normalizeHarnessOrder(ids);
}

/**
 * @param {unknown} harness
 * @returns {boolean}
 */
export function isHarnessEnabledInSettings(harness) {
  return isHarnessEnabled(harness, cachedEnabledHarnesses);
}

/**
 * @param {unknown} ids
 */
export function applyEnabledHarnesses(ids) {
  cachedEnabledHarnesses = listEnabledHarnesses(ids, cachedHarnessOrder);
  if (!isHarnessEnabled(cachedDefaultHarness, cachedEnabledHarnesses)) {
    cachedDefaultHarness = /** @type {NewChatHarness} */ (cachedEnabledHarnesses[0] || 'sdk');
  }
  fillHarnessChoiceSelects();
}

/**
 * Applies default harness to the new-chat modal select when present.
 */
export function applyDefaultNewChatHarnessToModal() {
  const harnessSel = document.getElementById('chat-new-harness-select');
  if (!(harnessSel instanceof HTMLSelectElement)) return;
  fillNativeHarnessSelect(harnessSel);
  if (isHarnessEnabled(cachedDefaultHarness, cachedEnabledHarnesses)) {
    harnessSel.value = cachedDefaultHarness;
  }
}

function harnessCatalog() {
  return [
    { id: 'opencode', tab: 'harness-opencode', label: t('settings.harnessOpenCode') },
    { id: 'openrouter', tab: 'harness-openrouter', label: t('settings.harnessOpenRouter') },
    { id: 'sdk', tab: 'harness-sdk', label: t('settings.harnessSdk') },
    { id: 'codebuddy', tab: 'harness-codebuddy', label: t('settings.harnessCodeBuddy') },
    { id: 'deepseek', tab: 'harness-deepseek', label: t('settings.harnessDeepSeek') },
    { id: 'qwen', tab: 'harness-qwen', label: t('settings.harnessQwen') },
    { id: 'codex', tab: 'harness-codex', label: t('settings.harnessCodex') },
  ];
}

function harnessRows() {
  const byId = new Map(harnessCatalog().map((row) => [row.id, row]));
  return cachedHarnessOrder.map((id) => byId.get(id)).filter(Boolean);
}

function enabledHarnessOptions() {
  return harnessRows()
    .filter((row) => isHarnessEnabled(row.id, cachedEnabledHarnesses))
    .map((row) => ({ value: row.id, label: row.label }));
}

/**
 * @param {HTMLSelectElement} selectEl
 */
function fillNativeHarnessSelect(selectEl) {
  const current = selectEl.value;
  const options = enabledHarnessOptions();
  selectEl.replaceChildren();
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    selectEl.appendChild(el);
  }
  if (options.some((row) => row.value === current)) {
    selectEl.value = current;
    return;
  }
  const fallback = options.some((row) => row.value === cachedDefaultHarness)
    ? cachedDefaultHarness
    : (options[0]?.value || '');
  if (fallback) selectEl.value = fallback;
}

function fillHarnessChoiceSelects() {
  const defaultEl = document.getElementById('default-new-chat-harness-select');
  if (defaultEl?.tagName === 'CR-BAR-SELECT') {
    defaultEl.options = enabledHarnessOptions();
    defaultEl.value = cachedDefaultHarness;
  }
  const newChatEl = document.getElementById('chat-new-harness-select');
  if (newChatEl instanceof HTMLSelectElement) fillNativeHarnessSelect(newChatEl);
}

function renderHarnessSetupStatus(data) {
  const listEl = document.getElementById('harness-setup-status');
  if (!listEl) return;
  const status = data?.harnessStatus || cachedHarnessStatus;
  if (data?.harnessStatus) cachedHarnessStatus = data.harnessStatus;
  if (!status) {
    listEl.replaceChildren();
    return;
  }
  listEl.replaceChildren();
  for (const row of harnessRows()) {
    const backend = status[row.id];
    const item = document.createElement('li');
    item.className = 'harness-setup-status-row';
    item.dataset.harnessId = row.id;
    const dragBtn = document.createElement('button');
    dragBtn.type = 'button';
    dragBtn.className = 'harness-setup-drag';
    dragBtn.setAttribute('aria-label', t('settings.harnessReorderHandle', { label: row.label }));
    dragBtn.innerHTML = '<span class="mdi mdi-drag" aria-hidden="true"></span>';
    const enableLabel = document.createElement('label');
    enableLabel.className = 'cr-check harness-setup-enable';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.harnessId = row.id;
    checkbox.checked = isHarnessEnabled(row.id, cachedEnabledHarnesses);
    checkbox.setAttribute('aria-label', `${row.label}: ${t('settings.harnessEnabledLabel')}`);
    checkbox.addEventListener('change', () => {
      void saveEnabledHarnessesFromUi();
    });
    const enableText = document.createElement('span');
    enableText.textContent = t('settings.harnessEnabledLabel');
    enableLabel.append(checkbox, enableText);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'harness-setup-status-item';
    const ready = !!(backend && backend.configured);
    const missingSdk = row.id === 'sdk' && backend && backend.available === false;
    const missingCodeBuddy = row.id === 'codebuddy' && backend && backend.available === false;
    const missingDeepSeek = row.id === 'deepseek' && backend && backend.available === false;
    const missingQwen = row.id === 'qwen' && backend && backend.available === false;
    const missingCodex = row.id === 'codex' && backend && backend.available === false;
    const detail = ready
      ? t('settings.harnessStatusReady')
      : missingSdk
        ? t('settings.harnessStatusSdkMissing')
        : missingCodeBuddy
          ? t('settings.harnessStatusCodeBuddyMissing')
          : missingDeepSeek
            ? t('settings.harnessStatusDeepSeekMissing')
            : missingQwen
              ? t('settings.harnessStatusQwenMissing')
              : missingCodex
                ? t('settings.harnessStatusCodexMissing')
                : t('settings.harnessStatusNeedsKey');
    btn.classList.toggle('is-ready', ready);
    btn.classList.toggle('is-missing', !ready);
    btn.classList.toggle('is-disabled-harness', !checkbox.checked);
    btn.textContent = `${row.label}: ${detail}`;
    btn.addEventListener('click', () => {
      const tabBtn = document.querySelector(`#settings-harness-tabs [data-settings-tab="${row.tab}"]`);
      if (tabBtn instanceof HTMLElement) tabBtn.click();
    });
    const usage = readHarnessModelUsage(cachedHarnessModelUsage, row.id);
    const usageEl = document.createElement('span');
    usageEl.className = 'harness-setup-usage';
    usageEl.classList.toggle('is-active', usage.enabled > 0 && usage.enabled < usage.total);
    usageEl.textContent = `${usage.enabled}/${usage.total}`;
    usageEl.title = t('settings.harnessModelUsageHint', usage);
    usageEl.setAttribute('aria-label', t('settings.harnessModelUsageHint', usage));
    item.append(dragBtn, enableLabel, btn, usageEl);
    listEl.appendChild(item);
  }
}

function emitHarnessListChanged() {
  window.dispatchEvent(new CustomEvent('cretli-enabled-harnesses-changed', {
    detail: {
      enabledHarnesses: getEnabledHarnessIds(),
      harnessOrder: getHarnessOrder(),
    },
  }));
}

async function saveHarnessOrderFromUi(ids) {
  const statusEl = document.getElementById('harness-enabled-save-status');
  applyHarnessOrder(ids);
  applyEnabledHarnesses(cachedEnabledHarnesses);
  fillHarnessChoiceSelects();
  if (statusEl) statusEl.textContent = t('settings.harnessEnabledSaving');
  try {
    const data = await api.patchSettings({ harnessOrder: normalizeHarnessOrder(ids) });
    if (!data?.ok) {
      if (statusEl) statusEl.textContent = data?.error || t('settings.harnessOrderSaveError');
      return;
    }
    applyHarnessOrder(data.harnessOrder);
    applyEnabledHarnesses(data.enabledHarnesses);
    cachedDefaultHarness = normalizeDefaultHarness(data.defaultNewChatHarness);
    fillHarnessChoiceSelects();
    if (statusEl) statusEl.textContent = t('settings.harnessOrderSaved');
    emitHarnessListChanged();
  } catch {
    if (statusEl) statusEl.textContent = t('settings.harnessOrderSaveError');
  }
}

function readEnabledHarnessesFromUi() {
  const listEl = document.getElementById('harness-setup-status');
  if (!listEl) return [];
  return [...listEl.querySelectorAll('input[data-harness-id]')]
    .filter((el) => el instanceof HTMLInputElement && el.checked)
    .map((el) => String(el.dataset.harnessId || ''))
    .filter(Boolean);
}

async function saveEnabledHarnessesFromUi() {
  const statusEl = document.getElementById('harness-enabled-save-status');
  const next = readEnabledHarnessesFromUi();
  if (next.length === 0) {
    applyEnabledHarnesses(cachedEnabledHarnesses);
    renderHarnessSetupStatus({ harnessStatus: cachedHarnessStatus });
    if (statusEl) statusEl.textContent = t('settings.harnessEnabledNeedOne');
    return;
  }
  const seq = ++harnessSettingsLoadSeq;
  applyEnabledHarnesses(next);
  renderHarnessSetupStatus({ harnessStatus: cachedHarnessStatus });
  if (statusEl) statusEl.textContent = t('settings.harnessEnabledSaving');
  try {
    const data = await api.patchSettings({ enabledHarnesses: next });
    if (seq !== harnessSettingsLoadSeq) return;
    if (!data?.ok) {
      if (statusEl) statusEl.textContent = data?.error || t('settings.harnessEnabledSaveError');
      return;
    }
    applyHarnessOrder(data.harnessOrder);
    applyEnabledHarnesses(data.enabledHarnesses || next);
    cachedDefaultHarness = normalizeDefaultHarness(data.defaultNewChatHarness);
    fillHarnessChoiceSelects();
    renderHarnessSetupStatus(data);
    if (statusEl) statusEl.textContent = t('settings.harnessEnabledSaved');
    emitHarnessListChanged();
  } catch {
    if (seq !== harnessSettingsLoadSeq) return;
    if (statusEl) statusEl.textContent = t('settings.harnessEnabledSaveError');
  }
}

async function refreshHarnessModelUsage(settings) {
  try {
    cachedHarnessModelUsage = await loadHarnessModelUsage(settings);
  } catch {
    cachedHarnessModelUsage = Object.create(null);
  }
}

async function loadDefaultHarnessFromServer() {
  const seq = ++harnessSettingsLoadSeq;
  try {
    const data = await api.getSettings();
    if (seq !== harnessSettingsLoadSeq) return;
    if (!data?.ok) return;
    applyHarnessOrder(data.harnessOrder);
    applyEnabledHarnesses(data.enabledHarnesses);
    cachedDefaultHarness = normalizeDefaultHarness(data.defaultNewChatHarness);
    fillHarnessChoiceSelects();
    await refreshHarnessModelUsage(data);
    if (seq !== harnessSettingsLoadSeq) return;
    renderHarnessSetupStatus(data);
  } catch {
    /* ignore */
  }
}

/**
 * Initializes harness defaults UI (Settings → Harness).
 */
export function initHarnessSettings() {
  const selectEl = document.getElementById('default-new-chat-harness-select');
  const saveBtn = document.getElementById('default-new-chat-harness-save-btn');
  const statusEl = document.getElementById('default-new-chat-harness-save-status');
  window.addEventListener('cr-lang-changed', () => {
    fillHarnessChoiceSelects();
    void loadDefaultHarnessFromServer();
  });
  for (const eventName of [
    'cretli-chat-models-changed',
    'cretli-openrouter-models-changed',
    'cretli-opencode-models-changed',
    'cretli-codebuddy-models-changed',
    'cretli-deepseek-models-changed',
    'cretli-qwen-models-changed',
    'cretli-codex-models-changed',
  ]) {
    window.addEventListener(eventName, () => {
      void loadDefaultHarnessFromServer();
    });
  }
  const listEl = document.getElementById('harness-setup-status');
  if (listEl) {
    initHarnessOrderDrag({
      listEl,
      onOrderChange: (ids) => {
        void saveHarnessOrderFromUi(ids);
      },
    });
  }
  void loadDefaultHarnessFromServer();
  if (!selectEl || !saveBtn) return;
  saveBtn.addEventListener('click', () => {
    const value = normalizeDefaultHarness(selectEl.value);
    if (statusEl) statusEl.textContent = t('settings.harnessDefaultsSaving');
    api.patchSettings({ defaultNewChatHarness: value }).then((data) => {
      if (!data?.ok) {
        if (statusEl) statusEl.textContent = data?.error || t('settings.harnessDefaultsSaveError');
        return;
      }
      cachedDefaultHarness = normalizeDefaultHarness(data.defaultNewChatHarness);
      applyHarnessOrder(data.harnessOrder);
      applyEnabledHarnesses(data.enabledHarnesses);
      if (statusEl) statusEl.textContent = t('settings.harnessDefaultsSaved');
      window.dispatchEvent(new CustomEvent('cretli-default-harness-changed', {
        detail: { defaultNewChatHarness: cachedDefaultHarness },
      }));
    }).catch(() => {
      if (statusEl) statusEl.textContent = t('settings.harnessDefaultsSaveError');
    });
  });
}

export function refreshHarnessSettingsPanel() {
  void loadDefaultHarnessFromServer();
}
