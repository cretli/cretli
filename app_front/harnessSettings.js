/**
 * Harness tab: default new-chat harness selector.
 */
import * as api from './core/api/index.js';
import { t } from './i18n/index.js';

/** @typedef {'sdk' | 'openrouter' | 'opencode'} NewChatHarness */

/** @type {NewChatHarness} */
let cachedDefaultHarness = 'sdk';

/**
 * @param {unknown} value
 * @returns {NewChatHarness}
 */
function normalizeDefaultHarness(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'opencode') return 'opencode';
  return 'sdk';
}

/**
 * @returns {NewChatHarness}
 */
export function getDefaultNewChatHarness() {
  return cachedDefaultHarness;
}

/**
 * Applies default harness to the new-chat modal select when present.
 */
export function applyDefaultNewChatHarnessToModal() {
  const harnessSel = document.getElementById('chat-new-harness-select');
  if (!(harnessSel instanceof HTMLSelectElement)) return;
  harnessSel.value = cachedDefaultHarness;
}

function renderHarnessSetupStatus(data) {
  const listEl = document.getElementById('harness-setup-status');
  if (!listEl) return;
  const status = data?.harnessStatus;
  if (!status) {
    listEl.replaceChildren();
    return;
  }
  const rows = [
    { id: 'opencode', label: t('settings.harnessOpenCode'), backend: status.opencode },
    { id: 'openrouter', label: t('settings.harnessOpenRouter'), backend: status.openrouter },
    { id: 'sdk', label: t('settings.harnessSdk'), backend: status.sdk },
  ];
  listEl.replaceChildren();
  for (const row of rows) {
    const item = document.createElement('li');
    item.className = 'harness-setup-status-item';
    const ready = !!(row.backend && row.backend.configured);
    const missingSdk = row.id === 'sdk' && row.backend && row.backend.available === false;
    const detail = ready
      ? t('settings.harnessStatusReady')
      : missingSdk
        ? t('settings.harnessStatusSdkMissing')
        : t('settings.harnessStatusNeedsKey');
    item.classList.toggle('is-ready', ready);
    item.classList.toggle('is-missing', !ready);
    item.textContent = `${row.label}: ${detail}`;
    listEl.appendChild(item);
  }
}

async function loadDefaultHarnessFromServer() {
  try {
    const data = await api.getSettings();
    if (!data?.ok) return;
    cachedDefaultHarness = normalizeDefaultHarness(data.defaultNewChatHarness);
    const selectEl = document.getElementById('default-new-chat-harness-select');
    if (selectEl) {
      fillDefaultHarnessOptions(selectEl);
      selectEl.value = cachedDefaultHarness;
    }
    renderHarnessSetupStatus(data);
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLElement} selectEl
 */
function fillDefaultHarnessOptions(selectEl) {
  if (selectEl.tagName !== 'CR-BAR-SELECT') return;
  selectEl.options = [
    { value: 'sdk', label: t('settings.harnessSdk') },
    { value: 'openrouter', label: t('settings.harnessOpenRouter') },
    { value: 'opencode', label: t('settings.harnessOpenCode') },
  ];
}

/**
 * Initializes harness defaults UI (Settings → Harness).
 */
export function initHarnessSettings() {
  const selectEl = document.getElementById('default-new-chat-harness-select');
  const saveBtn = document.getElementById('default-new-chat-harness-save-btn');
  const statusEl = document.getElementById('default-new-chat-harness-save-status');
  if (!selectEl || !saveBtn) return;

  fillDefaultHarnessOptions(selectEl);
  window.addEventListener('cr-lang-changed', () => fillDefaultHarnessOptions(selectEl));

  void loadDefaultHarnessFromServer();

  saveBtn.addEventListener('click', () => {
    const value = normalizeDefaultHarness(selectEl.value);
    if (statusEl) statusEl.textContent = t('settings.harnessDefaultsSaving');
    api.patchSettings({ defaultNewChatHarness: value }).then((data) => {
      if (!data?.ok) {
        if (statusEl) statusEl.textContent = data?.error || t('settings.harnessDefaultsSaveError');
        return;
      }
      cachedDefaultHarness = normalizeDefaultHarness(data.defaultNewChatHarness);
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
