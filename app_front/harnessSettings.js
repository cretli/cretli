/**
 * Harness tab: default new-chat harness selector.
 */
import * as api from './core/api/index.js';
import { t } from './i18n/index.js';

/** @typedef {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen'} NewChatHarness */

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
    { id: 'opencode', tab: 'harness-opencode', label: t('settings.harnessOpenCode'), backend: status.opencode },
    { id: 'openrouter', tab: 'harness-openrouter', label: t('settings.harnessOpenRouter'), backend: status.openrouter },
    { id: 'sdk', tab: 'harness-sdk', label: t('settings.harnessSdk'), backend: status.sdk },
    { id: 'codebuddy', tab: 'harness-codebuddy', label: t('settings.harnessCodeBuddy'), backend: status.codebuddy },
    { id: 'deepseek', tab: 'harness-deepseek', label: t('settings.harnessDeepSeek'), backend: status.deepseek },
    { id: 'qwen', tab: 'harness-qwen', label: t('settings.harnessQwen'), backend: status.qwen },
    { id: 'codex', tab: 'harness-codex', label: t('settings.harnessCodex'), backend: status.codex },
  ];
  listEl.replaceChildren();
  for (const row of rows) {
    const item = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'harness-setup-status-item';
    const ready = !!(row.backend && row.backend.configured);
    const missingSdk = row.id === 'sdk' && row.backend && row.backend.available === false;
    const missingCodeBuddy = row.id === 'codebuddy' && row.backend && row.backend.available === false;
    const missingDeepSeek = row.id === 'deepseek' && row.backend && row.backend.available === false;
    const missingQwen = row.id === 'qwen' && row.backend && row.backend.available === false;
    const missingCodex = row.id === 'codex' && row.backend && row.backend.available === false;
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
    btn.textContent = `${row.label}: ${detail}`;
    btn.addEventListener('click', () => {
      const tabBtn = document.querySelector(`#settings-harness-tabs [data-settings-tab="${row.tab}"]`);
      if (tabBtn instanceof HTMLElement) tabBtn.click();
    });
    item.appendChild(btn);
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
    { value: 'codebuddy', label: t('settings.harnessCodeBuddy') },
    { value: 'deepseek', label: t('settings.harnessDeepSeek') },
    { value: 'qwen', label: t('settings.harnessQwen') },
    { value: 'codex', label: t('settings.harnessCodex') },
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
