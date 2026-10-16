/**
 * Settings → Delegations subtabs (Limits / Review / Models).
 *
 * One GET `/api/delegation-settings` feeds all three panels; Save sends a PATCH
 * with only the fields the operator changed. This is the single write path for
 * delegation options — Usage and Watcher only link here. `scope=server` fields
 * are read-only previews of the env value.
 */

import { t, getCurrentLang } from '../../i18n/index.js';
import { readBarInputLiveValue } from '../../components/ui/read-bar-input-live-value.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getWatcherWorkspaceFolder, scopeWatcherRequestToWorkspace } from '../watcher/watcherWorkspaceScope.js';

const API_PATH = '/api/delegation-settings';
const PAIR_SEPARATOR = '\u0001';

/** Fields per editable subtab, in render order. `kind` selects the control. */
export const DELEGATION_SUBTAB_FIELDS = Object.freeze({
  limits: [
    { field: 'max_depth', kind: 'int', min: 1, max: 8 },
    { field: 'tree_slot_limit', kind: 'int', min: 0 },
    { field: 'run_deadline_implement_ms', kind: 'int', min: 0 },
    { field: 'run_deadline_review_fix_ms', kind: 'int', min: 0 },
    { field: 'cancelling_timeout_ms', kind: 'int', min: 1 },
    { field: 'global_limit', kind: 'int', min: 0 },
    { field: 'queue_max', kind: 'int', min: 0 },
  ],
  review: [
    { field: 'review_fanout', kind: 'fanout' },
    { field: 'parallel_implement_fanout', kind: 'fanout' },
    { field: 'review_allow_uncertified', kind: 'bool' },
    { field: 'code_review_phase', kind: 'bool' },
    { field: 'code_review_max_closures', kind: 'int', min: 0 },
    { field: 'reviewer_pair_enabled', kind: 'bool' },
    { field: 'reviewer_pair_members', kind: 'pair' },
    { field: 'reviewer_pair_strict', kind: 'bool' },
  ],
  models: [
    { field: 'empty_favorites', kind: 'enum', options: ['deny', 'all'] },
    { field: 'plan_window_enabled', kind: 'bool' },
    { field: 'plan_window_hard_free_percent', kind: 'int', min: 1, max: 20 },
  ],
});

/** @type {{ data: object | null, favorites: Array<{ harness: string, model: string, label: string }> }} */
const state = { data: null, favorites: [], favoritesAt: 0, favoritesPromise: null, dirty: new Set() };
/** Favorites change rarely; reuse them across tab entries for this long. */
const FAVORITES_TTL_MS = 60_000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function api(path, options = {}) {
  const scoped = scopeWatcherRequestToWorkspace(path, options, getWatcherWorkspaceFolder());
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (scoped.options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers,
    credentials: 'include',
    body: scoped.options.body !== undefined ? JSON.stringify(scoped.options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  if (Array.isArray(value)) {
    return value.length ? value.map((m) => `${m.harness}/${m.model}`).join(', ') : t('settings.delegationSettingsNone');
  }
  if (typeof value === 'boolean') return t(value ? 'settings.delegationSettingsOn' : 'settings.delegationSettingsOff');
  return String(value ?? '');
}

/**
 * Only the fields whose control value differs from the loaded effective value.
 *
 * @param {Record<string, unknown>} baseline effective values from the API
 * @param {Record<string, unknown>} current values read from the form
 * @returns {Record<string, unknown>}
 */
export function buildDelegationPatch(baseline, current) {
  const patch = {};
  for (const [field, value] of Object.entries(current || {})) {
    if (JSON.stringify(value) !== JSON.stringify(baseline?.[field])) patch[field] = value;
  }
  return patch;
}

/**
 * @param {{ field: string, kind: string, min?: number, max?: number, options?: string[] }} spec
 * @param {object} data API response
 * @returns {string}
 */
function renderField(spec, data) {
  const { field } = spec;
  const value = data.effective?.[field];
  const readOnly = data.scope?.[field] === 'server';
  const source = data.source?.[field] || 'default';
  const id = `delegation-field-${field}`;
  const dis = readOnly ? ' disabled' : '';
  let control = '';
  if (spec.kind === 'bool') {
    control = `<label class="cr-check"><input id="${id}" type="checkbox" data-delegation-field="${field}"${value ? ' checked' : ''}${dis}> ${esc(t(`settings.delegationField_${field}`))}</label>`;
  } else if (spec.kind === 'fanout' || spec.kind === 'enum') {
    const options = spec.kind === 'fanout' ? ['1', '2'] : spec.options;
    const label = (opt) => (spec.kind === 'enum' ? t(`settings.delegationEnum_${field}_${opt}`) : opt);
    control = `<cr-bar-select id="${id}" data-delegation-field="${field}" data-options="${esc(JSON.stringify(options.map((opt) => ({ value: opt, label: label(opt) }))))}" value="${esc(value)}"${dis}></cr-bar-select>`;
  } else if (spec.kind === 'pair') {
    const members = Array.isArray(value) ? value : [];
    const slot = (index) => {
      const current = members[index] ? `${members[index].harness}${PAIR_SEPARATOR}${members[index].model}` : '';
      const known = state.favorites.some((fav) => `${fav.harness}${PAIR_SEPARATOR}${fav.model}` === current);
      const options = [{ value: '', label: t('settings.delegationSettingsNone') }];
      // A saved member that left the favorites stays selectable so it is not dropped silently.
      if (current && !known) options.push({ value: current, label: `${members[index].harness} / ${members[index].model}` });
      for (const fav of state.favorites) {
        options.push({ value: `${fav.harness}${PAIR_SEPARATOR}${fav.model}`, label: `${fav.harness} / ${fav.label}` });
      }
      return `<cr-bar-select id="${id}-${index}" data-delegation-pair-member="${index}" data-options="${esc(JSON.stringify(options))}" value="${esc(current)}"${dis}></cr-bar-select>`;
    };
    control = `<div class="cr-row">${slot(0)}${slot(1)}</div>`;
  } else {
    control = `<cr-bar-input id="${id}" type="number" data-delegation-field="${field}" min="${spec.min ?? 0}"${spec.max != null ? ` max="${spec.max}"` : ''} value="${esc(value)}"${dis}></cr-bar-input>`;
  }
  const label = spec.kind === 'bool' ? '' : `<span class="cr-field-label">${esc(t(`settings.delegationField_${field}`))}</span>`;
  const reset = !readOnly && source === 'workspace'
    ? `<cr-bar-button class="cr-field-action" data-delegation-reset="${field}">${esc(t('settings.delegationSettingsUseDefault'))}</cr-bar-button>`
    : '';
  return `
    <div class="cr-field" data-delegation-row="${field}">
      ${label}
      ${control}
      <p class="cr-hint">
        <span class="cr-badge" data-delegation-source="${esc(source)}">${esc(t(`settings.delegationSource_${source}`))}</span>
        ${readOnly ? `<span>${esc(t('settings.delegationSettingsServerScope'))}</span>` : ''}
        <span>${esc(t('settings.delegationSettingsEnvDefault'))}: <code>${esc(formatValue(data.envDefault?.[field]))}</code></span>
      </p>
      <p class="cr-hint">${esc(t(`settings.delegationHint_${field}`))}</p>
      ${reset}
    </div>`;
}

/**
 * @param {string} tab
 * @param {object} data
 * @returns {string}
 */
function renderSubtab(tab, data) {
  const fields = DELEGATION_SUBTAB_FIELDS[tab].map((spec) => renderField(spec, data)).join('');
  const extra = tab === 'models'
    ? `<p class="cr-hint"><a href="#" data-delegation-stats-link="1">${esc(t('settings.delegationSettingsModelStatsLink'))}</a></p>`
    : '';
  return `
    <div class="cr-page-body">
      <p class="cr-hint">${esc(t(`settings.delegationSettings_${tab}Hint`))}</p>
      ${fields}
      ${extra}
    </div>`;
}

/**
 * @param {string} tab
 * @returns {HTMLElement | null}
 */
function getRoot(tab) {
  return document.getElementById(`settings-delegation-${tab}-root`);
}

/**
 * Status text lives in the shared footer, outside the scroll box.
 *
 * @param {HTMLElement} root
 * @param {string} text
 * @param {'error' | 'success' | ''} tone
 */
function setStatus(root, text, tone = '') {
  const el = document.getElementById('settings-delegation-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

/**
 * Re-render one subtab, or all of them when `only` is omitted.
 *
 * @param {string} [only]
 */
function renderAll(only) {
  if (!state.data) return;
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    if (only && tab !== only) continue;
    const root = getRoot(tab);
    if (!root) continue;
    root.innerHTML = renderSubtab(tab, state.data);
    root.querySelectorAll('cr-bar-select[data-options]').forEach((el) => {
      el.options = JSON.parse(el.dataset.options || '[]');
    });
  }
}

/**
 * Repaint only subtabs with no unsaved edits, so a refresh never wipes input.
 */
function renderCleanTabs() {
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    if (!state.dirty.has(tab)) renderAll(tab);
  }
}

/**
 * @param {Element & { value?: unknown }} el
 * @returns {string}
 */
function readControlValue(el) {
  return el.localName === 'cr-bar-input' ? readBarInputLiveValue(el) : String(el.value ?? '');
}

/** Re-render all subtabs but keep unsaved control values (language change). */
function rerenderPreservingEdits() {
  const snapshot = {};
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    const root = getRoot(tab);
    if (!root) continue;
    snapshot[tab] = [...root.querySelectorAll('[data-delegation-field], [data-delegation-pair-member]')]
      .map((el) => ({ el: el.dataset.delegationField ? `[data-delegation-field="${el.dataset.delegationField}"]` : `[data-delegation-pair-member="${el.dataset.delegationPairMember}"]`, value: readControlValue(el), checked: el.checked, type: el.type }));
  }
  renderAll();
  for (const [tab, items] of Object.entries(snapshot)) {
    const root = getRoot(tab);
    for (const item of items) {
      const el = root?.querySelector(item.el);
      if (!el || el.disabled) continue;
      if (item.type === 'checkbox') el.checked = item.checked;
      else el.value = item.value;
    }
  }
}

/**
 * Enabled favorites across harnesses, for the reviewer pair selectors.
 * Cached for FAVORITES_TTL_MS and de-duplicated while in flight, so repeated
 * tab entries do not re-issue the per-harness requests.
 *
 * @returns {Promise<Array<{ harness: string, model: string, label: string }>>}
 */
function loadFavorites() {
  if (state.favoritesAt && Date.now() - state.favoritesAt < FAVORITES_TTL_MS) return Promise.resolve(state.favorites);
  if (state.favoritesPromise) return state.favoritesPromise;
  state.favoritesPromise = (async () => {
    const catalog = await api('/api/harness-catalog/harnesses');
    const harnesses = (catalog.json?.items || []).map((item) => String(item?.id || '')).filter(Boolean);
    const lists = await Promise.all(harnesses.map(async (harness) => {
      const res = await api(`/api/harness-catalog/models?harness=${encodeURIComponent(harness)}&enabled_only=1`);
      return (res.json?.items || [])
        .filter((item) => item && item.id)
        .map((item) => ({ harness, model: String(item.id), label: String(item.label || item.id) }));
    }));
    state.favorites = lists.flat();
    state.favoritesAt = Date.now();
    return state.favorites;
  })().finally(() => { state.favoritesPromise = null; });
  return state.favoritesPromise;
}

/**
 * @param {HTMLElement} root
 * @returns {{ values: Record<string, unknown>, error: string }}
 */
function readSubtab(root, tab) {
  const values = {};
  let error = '';
  for (const spec of DELEGATION_SUBTAB_FIELDS[tab]) {
    if (state.data?.scope?.[spec.field] === 'server') continue;
    if (spec.kind === 'pair') {
      const members = [0, 1]
        .map((index) => String(root.querySelector(`[data-delegation-pair-member="${index}"]`)?.value || ''))
        .filter(Boolean)
        .map((raw) => {
          const [harness, model] = raw.split(PAIR_SEPARATOR);
          return { harness, model };
        });
      if (members.length === 1) error = t('settings.delegationSettingsPairNeedsTwo');
      values[spec.field] = members;
      continue;
    }
    const el = root.querySelector(`[data-delegation-field="${spec.field}"]`);
    if (!el) continue;
    if (spec.kind === 'bool') values[spec.field] = el.checked === true;
    else if (spec.kind === 'int' || spec.kind === 'fanout') {
      const num = Number.parseInt(readControlValue(el), 10);
      if (!Number.isSafeInteger(num) || num < (spec.min ?? 1) || (spec.max != null && num > spec.max)) {
        error = t('settings.delegationSettingsInvalidNumber', { field: t(`settings.delegationField_${spec.field}`) });
      }
      values[spec.field] = num;
    } else values[spec.field] = readControlValue(el);
  }
  return { values, error };
}

/** Fetch and paint all three panels. */
export async function refreshDelegationSettings() {
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    const root = getRoot(tab);
    if (root) root.textContent = t('settings.delegationSettingsLoading');
  }
  const [{ status, json }, favorites] = await Promise.all([api(API_PATH), loadFavorites().catch(() => [])]);
  if (status !== 200 || !json?.ok) {
    for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
      const root = getRoot(tab);
      if (root) {
        // A missing JSON body usually means the server predates this endpoint (404 HTML).
        const detail = json?.error || `HTTP ${status}`;
        root.textContent = `${t('settings.delegationSettingsLoadFailed')} (${detail})`;
      }
    }
    return;
  }
  state.data = json;
  state.favorites = favorites;
  // Tabs with unsaved edits keep their controls; the rest pick up fresh values.
  renderCleanTabs();
}

/**
 * @param {HTMLElement} root
 * @param {Record<string, unknown>} patch
 * @param {string} tab subtab being saved
 */
async function savePatch(root, patch, tab) {
  const { status, json } = await api(API_PATH, { method: 'PATCH', body: patch });
  if (status !== 200 || !json?.ok) return setStatus(root, json?.error || t('settings.delegationSettingsSaveFailed'), 'error');
  state.data = json;
  state.dirty.delete(tab);
  // Only the saved subtab is repainted so unsaved edits elsewhere survive.
  renderAll(tab);
  setStatus(root, t('settings.delegationSettingsSaved'), 'success');
  return undefined;
}

/** Wire subtab switching, Save/reset and cross-panel links once. */
export function initDelegationSettings() {
  if (state.bound) return;
  state.bound = true;
  for (const tab of Object.keys(DELEGATION_SUBTAB_FIELDS)) {
    const root = getRoot(tab);
    if (!root) continue;
    root.addEventListener('click', async (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-delegation-stats-link]')) {
        event.preventDefault();
        openDelegationSubtabLink('stats');
        return;
      }
      const reset = target.closest('[data-delegation-reset]');
      if (reset) {
        await savePatch(root, { [reset.dataset.delegationReset]: null }, tab);
        return;
      }
    });
    const markDirty = () => state.dirty.add(tab);
    root.addEventListener('input', markDirty);
    root.addEventListener('change', markDirty);
    root.addEventListener('cr-change', markDirty);
  }
  // The Save footer is a sibling of the scroll box and saves the visible subtab.
  document.getElementById('settings-delegation-save')?.addEventListener('click', async () => {
    const tab = Object.keys(DELEGATION_SUBTAB_FIELDS).find((key) => !getRoot(key)?.closest('[hidden]'));
    const root = tab ? getRoot(tab) : null;
    if (!root) return;
    const { values, error } = readSubtab(root, tab);
    if (error) return setStatus(root, error, 'error');
    const patch = buildDelegationPatch(state.data?.effective, values);
    if (Object.keys(patch).length === 0) return setStatus(root, t('settings.delegationSettingsNoChanges'));
    return savePatch(root, patch, tab);
  });
  // Links from Usage / Watcher (no second write path, just navigation).
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('[data-delegation-subtab-link]') : null;
    if (!link) return;
    event.preventDefault();
    openDelegationSubtabLink(link.dataset.delegationSubtabLink);
  });
  window.addEventListener('cr-lang-changed', () => rerenderPreservingEdits());
}

/**
 * Open Settings → Delegations on a subtab; `stats` jumps to the Usage tab's
 * Model × role outcomes block instead.
 *
 * @param {string} tab
 */
export function openDelegationSubtabLink(tab) {
  if (tab === 'stats') {
    document.querySelector('#settings-tabs .settings-tab[data-settings-tab="usage"]')?.click();
    document.getElementById('delegation-stats-title')?.scrollIntoView?.({ block: 'start' });
    return;
  }
  const target = tab === 'center' ? 'delegations' : `delegations-${tab}`;
  document.querySelector(`#settings-delegation-tabs .settings-tab[data-settings-tab="${target}"]`)?.click()
    || document.querySelector('#settings-tabs .settings-tab[data-settings-tab="delegations"]')?.click();
}
