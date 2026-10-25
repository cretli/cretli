/**
 * Settings → Wake-ups: generic scheduler section (kinds, rows, status). All
 * markup comes from the pure helpers in `wakeupsView.js`.
 */

import { cancelWakeup, getWakeupKinds, getWakeupStatus, getWakeups, runWakeupNow, saveWakeupKindSettings } from '../../core/api/index.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import {
  buildKindSettingsPatch,
  CONDITION_CHECK_KIND,
  buildWakeupQuery,
  describeRunNowResult,
  renderChecksHtml,
  renderKindFilterOptions,
  renderKindsHtml,
  renderStateFilterOptions,
  renderStatusHtml,
  renderWakeupRowsHtml,
} from './wakeupsView.js';

let wired = false;
/** @type {object[]} last loaded kinds, used for labels and PATCH building */
let loadedKinds = [];

const byId = (id) => document.getElementById(id);

function setMessage(text) {
  const el = byId('wakeups-message');
  if (el) el.textContent = text;
}

function kindLabels() {
  return Object.fromEntries(loadedKinds.map((kind) => [kind.kind, kind.label || kind.kind]));
}

async function refreshRows() {
  const listEl = byId('wakeups-list');
  if (!listEl) return;
  const query = buildWakeupQuery({ kind: byId('wakeups-filter-kind')?.value, state: byId('wakeups-filter-state')?.value });
  try {
    const result = await getWakeups(query);
    if (!result?.ok) throw new Error(result?.error || 'load failed');
    listEl.innerHTML = renderWakeupRowsHtml(result.items, t, getCurrentLang(), kindLabels());
  } catch (error) {
    console.warn('[wakeups] list failed:', error);
    listEl.textContent = t('wakeups.loadFailed');
  }
}

/** Scheduled-check strip: hidden entirely while there is nothing to show. */
async function refreshChecks() {
  const section = byId('wakeups-checks-section');
  const listEl = byId('wakeups-checks');
  if (!section || !listEl) return;
  try {
    const result = await getWakeups(buildWakeupQuery({ kind: CONDITION_CHECK_KIND }));
    if (!result?.ok) throw new Error(result?.error || 'load failed');
    const html = renderChecksHtml(result.items, t, getCurrentLang());
    listEl.innerHTML = html;
    section.hidden = !html;
  } catch (error) {
    console.warn('[wakeups] checks failed:', error);
    section.hidden = true;
  }
}

async function refreshStatus() {
  const el = byId('wakeups-status');
  if (!el) return;
  try {
    const result = await getWakeupStatus();
    el.innerHTML = renderStatusHtml(result?.ok ? result : null, t, getCurrentLang());
  } catch (error) {
    console.warn('[wakeups] status failed:', error);
    el.innerHTML = renderStatusHtml(null, t, getCurrentLang());
  }
}

async function refreshKinds() {
  const el = byId('wakeups-kinds');
  if (!el) return;
  try {
    const result = await getWakeupKinds();
    if (!result?.ok) throw new Error(result?.error || 'load failed');
    loadedKinds = Array.isArray(result.kinds) ? result.kinds : [];
    el.innerHTML = renderKindsHtml(loadedKinds, t);
  } catch (error) {
    console.warn('[wakeups] kinds failed:', error);
    el.textContent = t('wakeups.loadFailed');
  }
  const kindFilter = byId('wakeups-filter-kind');
  if (kindFilter) {
    const previous = kindFilter.value;
    kindFilter.innerHTML = renderKindFilterOptions(loadedKinds, t);
    kindFilter.value = previous;
  }
  const stateFilter = byId('wakeups-filter-state');
  if (stateFilter && !stateFilter.options.length) stateFilter.innerHTML = renderStateFilterOptions(t);
}

/** Loads the whole section; called whenever the tab opens. */
export async function refreshWakeupsSettings() {
  if (typeof document === 'undefined') return;
  setMessage('');
  await refreshKinds();
  await Promise.all([refreshStatus(), refreshRows(), refreshChecks()]);
}

async function saveKind(kindId) {
  const card = document.querySelector(`[data-wakeup-kind="${CSS.escape(kindId)}"]`);
  const statusEl = card?.querySelector('[data-wakeup-kind-status]');
  const kind = loadedKinds.find((item) => item.kind === kindId);
  if (!card || !kind) return;
  const values = {};
  card.querySelectorAll('[data-wakeup-field]').forEach((input) => {
    values[input.dataset.wakeupField] = input.type === 'checkbox' ? input.checked : input.value;
  });
  if (statusEl) statusEl.textContent = t('wakeups.saving');
  try {
    const result = await saveWakeupKindSettings(kindId, buildKindSettingsPatch(kind, values));
    if (!result?.ok) throw new Error(result?.error || 'save failed');
    if (statusEl) statusEl.textContent = t('wakeups.saved');
    await refreshKinds();
    await refreshStatus();
  } catch (error) {
    console.warn('[wakeups] save failed:', error);
    if (statusEl) statusEl.textContent = t('wakeups.saveFailed');
  }
}

async function cancelRow(id) {
  setMessage('');
  try {
    const result = await cancelWakeup(id);
    if (!result?.ok) throw new Error(result?.code || result?.error || 'cancel failed');
  } catch (error) {
    console.warn('[wakeups] cancel failed:', error);
    setMessage(t('wakeups.cancelFailed'));
  }
  await Promise.all([refreshRows(), refreshChecks()]);
}

async function runCheck(id) {
  setMessage('');
  try {
    const result = await runWakeupNow(id);
    // An unmet condition is information (current progress), not an error.
    if (!result?.ok) setMessage(describeRunNowResult(result, t));
  } catch (error) {
    console.warn('[wakeups] run now failed:', error);
    setMessage(t('wakeups.check_runFailed'));
  }
  await Promise.all([refreshRows(), refreshChecks()]);
}

/** Wires filters, actions and the usage-card link; first paint happens on tab open. */
export function initWakeupsSettings() {
  if (typeof window === 'undefined' || wired) return;
  wired = true;
  byId('wakeups-filter-kind')?.addEventListener('change', () => { void refreshRows(); });
  byId('wakeups-filter-state')?.addEventListener('change', () => { void refreshRows(); });
  byId('wakeups-refresh')?.addEventListener('click', () => { void refreshWakeupsSettings(); });
  byId('wakeups-checks')?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const cancel = target?.closest('[data-wakeup-cancel]');
    if (cancel) return void cancelRow(cancel.getAttribute('data-wakeup-cancel') || '');
    const run = target?.closest('[data-check-run]');
    if (run) void runCheck(run.getAttribute('data-check-run') || '');
  });
  byId('wakeups-list')?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-wakeup-cancel]') : null;
    if (button) void cancelRow(button.getAttribute('data-wakeup-cancel') || '');
  });
  byId('wakeups-kinds')?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-wakeup-kind-save]') : null;
    if (button) void saveKind(button.getAttribute('data-wakeup-kind-save') || '');
  });
  byId('usage-resume-open-wakeups')?.addEventListener('click', (event) => {
    event.preventDefault();
    document.querySelector('#settings-tabs .settings-tab[data-settings-tab="wakeups"]')?.click();
  });
}
