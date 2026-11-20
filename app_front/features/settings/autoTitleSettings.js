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
  const modeEl = /** @type {any} */ (document.getElementById('auto-title-mode'));
  const sourceEl = /** @type {any} */ (document.getElementById('auto-title-source'));
  const providerEl = /** @type {any} */ (document.getElementById('auto-title-provider'));
  const modelEl = /** @type {any} */ (document.getElementById('auto-title-model'));
  const testBtn = /** @type {any} */ (document.getElementById('auto-title-test'));
  const statusEl = /** @type {any} */ (document.getElementById('auto-title-status'));
  const warningEl = /** @type {any} */ (document.getElementById('auto-title-warning'));
  if (!modeEl || !sourceEl || !providerEl || !modelEl || !testBtn || !statusEl || !warningEl) return;

  modeEl.options = [
    { value: 'off', label: t('settings.autoTitleModeOff') },
    { value: 'first', label: t('settings.autoTitleModeFirst') },
    { value: 'continuous', label: t('settings.autoTitleModeContinuous') },
  ];
  sourceEl.options = [
    { value: 'server', label: t('settings.autoTitleSourceServer') },
    { value: 'agent', label: t('settings.autoTitleSourceAgent') },
    { value: 'both', label: t('settings.autoTitleSourceBoth') },
  ];

  /** @type {Array<{ id: string, label: string, available: boolean, reason: string, reasonText: string, defaultModel: string, models: Array<{ id: string, label: string }> }>} */
  let providers = [];

  const setStatus = (text, isError = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  };

  function fillModels(providerId, wanted) {
    const effective = providerId === 'auto'
      ? providers.find((p) => p.available)
      : providers.find((p) => p.id === providerId);
    const models = effective ? effective.models : [];
    const options = models.map((m) => ({ value: m.id, label: m.label || m.id }));
    // OpenRouter accepts any model id, so keep a saved id that is not in the list.
    const keepWanted = !!wanted && !models.some((m) => m.id === wanted) && effective?.id === 'openrouter';
    if (keepWanted) options.push({ value: wanted, label: wanted });
    modelEl.options = options;
    modelEl.disabled = options.length === 0;
    modelEl.value = models.some((m) => m.id === wanted) || keepWanted
      ? wanted
      : (effective?.defaultModel || '');
  }

  function fillProviders(selected) {
    const options = [{ value: 'auto', label: t('settings.autoTitleProviderAuto') }];
    for (const p of providers) {
      options.push({
        value: p.id,
        disabled: !p.available,
        label: p.available
          ? p.label
          : `${p.label} — ${t('settings.autoTitleUnavailable')}: ${reasonLabel(p.reason, p.reasonText)}`,
      });
    }
    providerEl.options = options;
    providerEl.value = options.some((o) => o.value === selected) ? selected : 'auto';
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
