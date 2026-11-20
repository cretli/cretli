import { configurationState } from '../../app_front/state/index.js';
import * as api from '../../app_front/core/api/index.js';
import { t } from '../../app_front/i18n/index.js';

let initialized = false;
let revision = 0;

export async function refresh() {
  void refreshLogin();
  const current = ++revision;
  try {
    const [settings, data, status] = await Promise.all([api.getSettings(), api.getAntigravityModels(), api.getAntigravityStatus()]);
    if (current !== revision) return;
    const list = document.getElementById('antigravity-models-list');
    if (!list) return;
    const selected = new Set(settings.antigravityChatEnabledModels || []);
    list.replaceChildren();
    for (const model of data.models || []) {
      const label = document.createElement('label');
      label.className = 'cr-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = model.id;
      checkbox.checked = selected.size === 0 || selected.has(model.id);
      label.append(checkbox, document.createTextNode(model.name || model.id));
      const row = document.createElement('div');
      row.className = 'cr-field';
      row.append(label);
      list.append(row);
    }
    document.getElementById('antigravity-status').textContent = status.ready ? t('settings.harnessAntigravityReady') : t('settings.harnessStatusAntigravityMissing');
  } catch {
    const status = document.getElementById('antigravity-models-status');
    if (status && current === revision) status.textContent = t('settings.chatModelsLoadError');
  }
}

export function init() {
  if (initialized) return;
  initialized = true;
  initLogin();
  window.addEventListener('cretli-antigravity-config-changed', () => { void refresh(); });
  document.getElementById('antigravity-models-refresh')?.addEventListener('click', () => { void refresh(); });
  document.getElementById('antigravity-models-save')?.addEventListener('click', async () => {
    const status = document.getElementById('antigravity-models-status');
    const models = Array.from(document.querySelectorAll('#antigravity-models-list input:checked')).map((input) => /** @type {HTMLInputElement} */ (input).value);
    status.textContent = t('settings.chatModelsSaving');
    try {
      const result = await api.patchSettings({ antigravityChatEnabledModels: models });
      if (!result?.ok) throw new Error('Settings save failed');
      status.textContent = t('settings.chatModelsSaved');
      window.dispatchEvent(new CustomEvent('cretli-antigravity-models-changed', { detail: { antigravityChatEnabledModels: models } }));
    } catch { status.textContent = t('settings.chatModelsSaveError'); }
  });
}

let loginInitialized = false;
let login = { phase: 'idle', attemptId: '', url: '', error: '' };
let timer = null;
let loginRevision = 0;
let requestBusy = false;

function renderLogin() {
  const active = ['starting', 'waiting', 'submitting'].includes(login.phase);
  const start = /** @type {HTMLElement & { disabled: boolean }} */ (document.getElementById('antigravity-login-start'));
  const cancel = /** @type {HTMLElement & { disabled: boolean }} */ (document.getElementById('antigravity-login-cancel'));
  const submit = /** @type {HTMLElement & { disabled: boolean }} */ (document.getElementById('antigravity-login-submit'));
  const box = document.getElementById('antigravity-login-box');
  const link = document.getElementById('antigravity-login-url');
  const status = document.getElementById('antigravity-login-status');
  if (start) start.disabled = active || requestBusy;
  if (cancel) { cancel.hidden = !active; cancel.disabled = requestBusy; }
  if (submit) submit.disabled = requestBusy;
  if (box) box.hidden = login.phase !== 'waiting';
  if (link instanceof HTMLAnchorElement) {
    link.removeAttribute('href');
    try {
      const url = new URL(login.url);
      if (login.phase === 'waiting' && url.protocol === 'https:' && url.hostname === 'accounts.google.com') link.href = url.href;
    } catch { /* No authorization link is available yet. */ }
  }
  const phaseKeys = {
    starting: 'settings.antigravityLoginStarting', waiting: 'settings.antigravityLoginWaiting',
    submitting: 'settings.antigravityLoginSubmitting', completed: 'settings.antigravityLoginCompleted',
    cancelled: 'settings.antigravityLoginCancelled', error: 'settings.antigravityLoginError',
  };
  if (status) status.textContent = login.error || (phaseKeys[login.phase] ? t(phaseKeys[login.phase]) : '');
}

function schedulePoll() {
  clearTimeout(timer);
  if (['starting', 'waiting', 'submitting'].includes(login.phase)) timer = setTimeout(() => { void refreshLogin(); }, 1500);
}

export async function refreshLogin() {
  const current = ++loginRevision;
  try {
    const data = await api.getAntigravityLoginStatus();
    if (current !== loginRevision || !data?.ok) return;
    const completed = login.phase !== 'completed' && data.login?.phase === 'completed';
    const preserveError = login.attemptId === data.login?.attemptId && login.phase === data.login?.phase ? login.error : '';
    login = { ...data.login, error: data.login?.error || preserveError };
    renderLogin();
    schedulePoll();
    if (completed) {
      configurationState.invalidateCredentials('antigravity');
      window.dispatchEvent(new CustomEvent('cretli-antigravity-config-changed'));
    }
  } catch {
    if (current !== loginRevision) return;
    // Keep a running attempt observable after a temporary disconnect.
    schedulePoll();
  }
}

async function action(run) {
  if (requestBusy) return;
  requestBusy = true;
  login = { ...login, error: '' };
  const current = ++loginRevision;
  clearTimeout(timer);
  renderLogin();
  try {
    const data = await run();
    if (current !== loginRevision) return;
    if (data?.login) login = data.login;
    if (!data?.ok) login = { ...login, error: data?.error || t('settings.antigravityLoginError') };
  } catch {
    if (current === loginRevision) login = { ...login, error: t('settings.antigravityLoginError') };
  } finally {
    requestBusy = false;
    renderLogin();
    // A lost start response can still have launched the server-side login.
    void refreshLogin();
  }
}

export function initLogin() {
  if (loginInitialized) return;
  loginInitialized = true;
  document.getElementById('antigravity-login-start')?.addEventListener('click', () => {
    const input = document.getElementById('antigravity-login-code');
    if (input && 'value' in input) input.value = '';
    void action(() => api.startAntigravityLogin());
  });
  document.getElementById('antigravity-login-cancel')?.addEventListener('click', () => {
    void action(() => api.cancelAntigravityLogin(login.attemptId));
  });
  document.getElementById('antigravity-login-submit')?.addEventListener('click', () => {
    const input = document.getElementById('antigravity-login-code');
    const code = input && 'value' in input ? String(input.value || '').trim() : '';
    if (!code) return;
    if (input && 'value' in input) input.value = '';
    void action(() => api.completeAntigravityLogin(login.attemptId, code));
  });
  window.addEventListener('cr-lang-changed', renderLogin);
}
