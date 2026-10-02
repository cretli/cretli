/**
 * Settings → Chat and agents → Automatic chat titles (server-side generator: mode, provider, model, test).
 */

import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getCurrentLang } from '../../i18n/index.js';

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function api(path, options = {}) {
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(path, {
    method: options.method || 'GET',
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * @param {string} reason
 * @param {string} fallback
 * @returns {string}
 */
function reasonLabel(reason, fallback) {
  const key = `settings.autoTitleReason.${reason}`;
  const text = t(key);
  return text && text !== key ? text : fallback || reason;
}

/** Wires the section once; no-op when the markup is absent. */
export function initAutoTitleSettings() {
  const modeEl = document.getElementById('auto-title-mode');
  const sourceEl = document.getElementById('auto-title-source');
  const providerEl = document.getElementById('auto-title-provider');
  const modelEl = document.getElementById('auto-title-model');
  const testBtn = document.getElementById('auto-title-test');
  const statusEl = document.getElementById('auto-title-status');
  const warningEl = document.getElementById('auto-title-warning');
  if (!modeEl || !sourceEl || !providerEl || !modelEl || !testBtn || !statusEl || !warningEl) return;

  /** @type {Array<{ id: string, label: string, available: boolean, reason: string, reasonText: string, defaultModel: string, models: Array<{ id: string, label: string }> }>} */
  let providers = [];

  const setStatus = (text, isError = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  };

  function fillModels(providerId, wanted) {
    modelEl.textContent = '';
    const effective = providerId === 'auto'
      ? providers.find((p) => p.available)
      : providers.find((p) => p.id === providerId);
    const models = effective ? effective.models : [];
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      modelEl.appendChild(opt);
    }
    if (wanted && !models.some((m) => m.id === wanted) && effective?.id === 'openrouter') {
      const opt = document.createElement('option');
      opt.value = wanted;
      opt.textContent = wanted;
      modelEl.appendChild(opt);
    }
    modelEl.disabled = models.length === 0;
    modelEl.value = models.some((m) => m.id === wanted) || (wanted && effective?.id === 'openrouter')
      ? wanted
      : (effective?.defaultModel || '');
  }

  function fillProviders(selected) {
    providerEl.textContent = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = t('settings.autoTitleProviderAuto');
    providerEl.appendChild(auto);
    for (const p of providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.disabled = !p.available;
      opt.textContent = p.available
        ? p.label
        : `${p.label} — ${t('settings.autoTitleUnavailable')}: ${reasonLabel(p.reason, p.reasonText)}`;
      providerEl.appendChild(opt);
    }
    providerEl.value = selected;
    if (providerEl.value !== selected) providerEl.value = 'auto';
  }

  function showWarning(data) {
    const any = providers.some((p) => p.available);
    const selected = data?.selected?.provider || 'auto';
    const chosen = providers.find((p) => p.id === selected);
    let text = '';
    if (!any) text = t('settings.autoTitleNoProvider');
    else if (selected !== 'auto' && chosen && !chosen.available) {
      text = t('settings.autoTitleSelectedUnavailable', { reason: reasonLabel(chosen.reason, chosen.reasonText) });
    }
    warningEl.textContent = text;
    warningEl.hidden = !text;
  }

  async function load() {
    const { status, json } = await api('/api/settings/auto-title/providers');
    if (status !== 200 || !json?.ok) {
      setStatus(`${t('settings.autoTitleLoadFailed')} (HTTP ${status})`, true);
      return;
    }
    providers = json.providers || [];
    modeEl.value = json.selected?.mode || 'first';
    sourceEl.value = json.selected?.source || 'server';
    fillProviders(json.selected?.provider || 'auto');
    fillModels(providerEl.value, json.selected?.model);
    showWarning(json);
  }

  async function save(patch) {
    const { status, json } = await api('/api/settings', { method: 'PATCH', body: { autoTitle: patch } });
    if (status !== 200 || json?.ok === false) {
      setStatus(json?.error || t('settings.autoTitleSaveFailed'), true);
      return false;
    }
    setStatus(t('settings.autoTitleSaved'));
    await load();
    return true;
  }

  modeEl.addEventListener('change', () => { save({ mode: modeEl.value }); });
  sourceEl.addEventListener('change', () => { save({ source: sourceEl.value }); });
  providerEl.addEventListener('change', () => {
    fillModels(providerEl.value, '');
    save({ provider: providerEl.value, model: modelEl.value });
  });
  modelEl.addEventListener('change', () => { save({ model: modelEl.value }); });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    setStatus(t('settings.autoTitleTesting'));
    try {
      const { json } = await api('/api/settings/auto-title/test', {
        method: 'POST',
        body: { provider: providerEl.value, model: modelEl.value },
      });
      if (json?.ok) setStatus(t('settings.autoTitleTestOk', { title: json.title, provider: json.provider }));
      else setStatus(t('settings.autoTitleTestFailed', { error: json?.error || 'error' }), true);
    } catch (err) {
      setStatus(t('settings.autoTitleTestFailed', { error: err?.message || 'error' }), true);
    } finally {
      testBtn.disabled = false;
    }
  });

  load().catch(() => setStatus(t('settings.autoTitleLoadFailed'), true));
}
