/**
 * Settings → Harness: local harness plugin enable controls.
 *
 * Reads discovered local providers from `api.getHarnessCatalog()` and their
 * saved opt-in list from `api.getSettings().enabledLocalHarnesses`, then writes
 * a full replacement list back through `api.patchSettings()`.
 *
 * The list is deliberately separate from the built-in harness controls in
 * `harnessSettings.js`:
 *  - only rows with `origin === 'local'` are rendered, using safe metadata
 *    (`id`, `label`, `description`, `version`, `state`) via `textContent`;
 *  - local ids never enter `#harness-setup-status` / `enabledHarnesses` and are
 *    never offered in chat, mode, voice, or model selectors;
 *  - an empty local list is neutral, and a saved-but-not-discovered id is shown
 *    read-only because the strict PATCH contract rejects it.
 *
 * The exported pure helpers (`filterLocalHarnessRows`, `nextEnabledLocalHarnessIds`,
 * `buildEnabledLocalHarnessesPatch`, `orphanSavedLocalHarnessIds`,
 * `normalizeLocalHarnessIds`, `isLocalHarnessRunnable`) contain no DOM or HTTP
 * access so they can be unit-tested in isolation.
 */

import * as api from '../../api.js';
import { t } from '../../i18n/index.js';

/** Section root, list, and live status ids owned by this module. */
const ROOT_ID = 'local-harness-plugins';
const LIST_ID = 'local-harness-plugins-list';
const STATUS_ID = 'local-harness-plugins-status';

/**
 * Trim + lowercase a saved local harness id. Non-strings become an empty id.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeLocalHarnessId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Normalize a saved/id list: strings only, trim, lowercase, de-duplicate,
 * first-seen order. A non-array value means "nothing".
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeLocalHarnessIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const ids = [];
  for (const item of raw) {
    const id = normalizeLocalHarnessId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Keep only discoverable local provider rows and copy safe metadata only.
 * `origin`/`entry`/`path`/`capabilities` are never forwarded to the DOM.
 *
 * @param {unknown} rows
 * @returns {Array<{ id: string, label: string, description: string, version: string, state: string, enabled: boolean, available: boolean, ready: boolean }>}
 */
export function filterLocalHarnessRows(rows) {
  if (!Array.isArray(rows)) return [];
  /** @type {Array<{ id: string, label: string, description: string, version: string, state: string, enabled: boolean, available: boolean, ready: boolean }>} */
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.origin !== 'local') continue;
    const id = normalizeLocalHarnessId(row.id);
    if (!id) continue;
    const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : id;
    out.push({
      id,
      label,
      description: typeof row.description === 'string' ? row.description.trim() : '',
      version: typeof row.version === 'string' ? row.version.trim() : '',
      state: typeof row.state === 'string' ? row.state.trim() : '',
      enabled: row.enabled === true,
      available: row.available === true,
      ready: row.ready === true,
    });
  }
  return out;
}

/**
 * Build the full next `enabledLocalHarnesses` selection.
 *
 * Result = currently discovered local ids that are also checked, in catalog
 * order. Because the discovered list is the local catalog, a built-in id, the
 * legacy `cursor` alias, or a saved-but-undiscovered orphan can never leak in;
 * stale ids are dropped by construction. `[]` is a valid "disable all locals".
 *
 * @param {{ discoveredIds?: unknown, checkedIds?: unknown }} [input]
 * @returns {string[]}
 */
export function nextEnabledLocalHarnessIds(input = {}) {
  const discovered = normalizeLocalHarnessIds(input.discoveredIds);
  const checked = new Set(normalizeLocalHarnessIds(input.checkedIds));
  return discovered.filter((id) => checked.has(id));
}

/**
 * Saved local ids that the current catalog does not expose. Kept out of every
 * PATCH body and shown read-only instead.
 *
 * @param {{ discoveredIds?: unknown, savedIds?: unknown }} [input]
 * @returns {string[]}
 */
export function orphanSavedLocalHarnessIds(input = {}) {
  const discovered = new Set(normalizeLocalHarnessIds(input.discoveredIds));
  return normalizeLocalHarnessIds(input.savedIds).filter((id) => !discovered.has(id));
}

/**
 * The exact PATCH body for the local enable list. Carries only
 * `enabledLocalHarnesses` and never trusts the caller's ordering.
 *
 * @param {unknown} ids
 * @returns {{ enabledLocalHarnesses: string[] }}
 */
export function buildEnabledLocalHarnessesPatch(ids) {
  return { enabledLocalHarnesses: normalizeLocalHarnessIds(ids) };
}

/**
 * Whether a local provider can actually be used. Runtime loading is not
 * implemented, so every discovered plugin reports `state: 'not_loaded'` /
 * `available: false` and is not runnable. Any other state is treated as
 * unavailable too; `enabled` alone never makes a plugin runnable.
 *
 * @param {{ state?: unknown, available?: unknown, ready?: unknown } | null | undefined} row
 * @returns {boolean}
 */
export function isLocalHarnessRunnable(row) {
  if (!row || typeof row !== 'object') return false;
  return row.state === 'loaded' && row.available === true && row.ready === true;
}

/** Independent load sequence — never shares `harnessSettingsLoadSeq`. */
let localHarnessLoadSeq = 0;
let localHarnessBound = false;

const state = {
  /** @type {'idle' | 'loading' | 'ready' | 'error'} */
  phase: 'idle',
  /** @type {ReturnType<typeof filterLocalHarnessRows>} */
  rows: [],
  /** Last server-confirmed saved local ids. @type {string[]} */
  confirmedIds: [],
  /** Current checkbox selection. @type {Set<string> } */
  checkedIds: new Set(),
  /** Saved ids that are not in the current catalog. @type {string[]} */
  orphanIds: [],
  /** True while a PATCH is in flight (checkboxes disabled, one flight only). */
  saving: false,
  /** Latest requested selection queued while a PATCH is in flight. @type {string[] | null} */
  desiredIds: null,
  /** When true, the next successful save also removed orphans. */
  hadOrphansOnLoad: false,
  /** @type {string} */
  statusKey: '',
  /** @type {Record<string, string|number> | null} */
  statusVars: null,
};

/** @returns {string[]} */
function discoveredIds() {
  return state.rows.map((row) => row.id);
}

/** @param {unknown} ids @returns {void} */
function setCheckedIds(ids) {
  state.checkedIds = new Set(normalizeLocalHarnessIds(ids));
}

/** Re-derive the checkbox selection from the last confirmed server list. */
function resolveCheckedFromConfirmed() {
  setCheckedIds(nextEnabledLocalHarnessIds({
    discoveredIds: discoveredIds(),
    checkedIds: state.confirmedIds,
  }));
}

/** @returns {string} */
function statusText() {
  if (state.statusKey) return t(state.statusKey, state.statusVars || undefined);
  if (state.phase === 'loading') return t('settings.localHarnessLoading');
  if (state.phase === 'error') return t('settings.localHarnessLoadError');
  return '';
}

/**
 * @param {ReturnType<typeof filterLocalHarnessRows>[number]} row
 * @returns {HTMLLIElement}
 */
function renderRow(row) {
  const item = document.createElement('li');
  item.className = 'local-harness-plugin-row';

  const enableLabel = document.createElement('label');
  enableLabel.className = 'cr-check local-harness-plugin-enable';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.localHarnessId = row.id;
  checkbox.checked = state.checkedIds.has(row.id);
  checkbox.disabled = state.saving || state.phase === 'loading';
  checkbox.setAttribute('aria-label', `${row.label}: ${t('settings.localHarnessEnabledLabel')}`);
  checkbox.addEventListener('change', () => {
    onToggleLocalHarness(row.id, checkbox.checked);
  });
  const enableText = document.createElement('span');
  enableText.textContent = t('settings.localHarnessEnabledLabel');
  enableLabel.append(checkbox, enableText);

  const meta = document.createElement('div');
  meta.className = 'local-harness-plugin-meta';

  const name = document.createElement('span');
  name.className = 'local-harness-plugin-label';
  name.textContent = row.label;
  meta.appendChild(name);

  if (row.version) {
    const version = document.createElement('span');
    version.className = 'local-harness-plugin-version';
    version.textContent = row.version;
    meta.appendChild(version);
  }

  if (!isLocalHarnessRunnable(row)) {
    const badge = document.createElement('span');
    badge.className = 'local-harness-plugin-badge';
    badge.textContent = t('settings.localHarnessUnavailable');
    meta.appendChild(badge);
  }

  if (row.description) {
    const description = document.createElement('p');
    description.className = 'local-harness-plugin-description';
    description.textContent = row.description;
    meta.appendChild(description);
  }

  item.append(enableLabel, meta);
  return item;
}

/** Rebuild the whole section from `state`. Uses textContent only. */
function renderLocalHarnessPlugins() {
  const listEl = document.getElementById(LIST_ID);
  const statusEl = document.getElementById(STATUS_ID);
  if (statusEl) statusEl.textContent = statusText();
  if (!listEl) return;
  listEl.replaceChildren();

  // Before the first load (idle) and while loading, show only the empty list;
  // a neutral empty hint is reserved for a completed, empty catalog.
  if (state.phase === 'loading' || state.phase === 'idle') return;

  if (state.rows.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'settings-hint local-harness-plugins-empty';
    empty.textContent = t('settings.localHarnessEmpty');
    listEl.appendChild(empty);
  } else {
    for (const row of state.rows) listEl.appendChild(renderRow(row));
  }

  if (state.orphanIds.length > 0) {
    const orphan = document.createElement('li');
    orphan.className = 'settings-hint local-harness-plugins-orphan';
    orphan.textContent = `${t('settings.localHarnessOrphan')}: ${state.orphanIds.join(', ')}`;
    listEl.appendChild(orphan);
  }
}

/**
 * @param {string} id
 * @param {boolean} checked
 */
function onToggleLocalHarness(id, checked) {
  const desired = new Set(state.checkedIds);
  if (checked) desired.add(id);
  else desired.delete(id);
  const next = nextEnabledLocalHarnessIds({
    discoveredIds: discoveredIds(),
    checkedIds: [...desired],
  });
  setCheckedIds(next);
  state.desiredIds = next;
  state.statusKey = 'settings.localHarnessSaving';
  state.statusVars = null;
  renderLocalHarnessPlugins();
  void flushLocalHarnessSaves();
}

/**
 * Serialize PATCH calls: at most one in flight. A toggle made while saving is
 * queued and sent once the current request settles; a failure rolls back to the
 * last confirmed list and drops the queued wish.
 */
async function flushLocalHarnessSaves() {
  if (state.saving) return;
  state.saving = true;
  renderLocalHarnessPlugins();
  try {
    while (state.desiredIds) {
      const payloadIds = state.desiredIds;
      state.desiredIds = null;
      let data = null;
      try {
        data = await api.patchSettings(buildEnabledLocalHarnessesPatch(payloadIds));
      } catch {
        data = null;
      }
      if (data?.ok) {
        state.confirmedIds = normalizeLocalHarnessIds(data.enabledLocalHarnesses);
        state.orphanIds = orphanSavedLocalHarnessIds({
          discoveredIds: discoveredIds(),
          savedIds: state.confirmedIds,
        });
        if (state.desiredIds) {
          setCheckedIds(state.desiredIds);
          state.statusKey = 'settings.localHarnessSaving';
          state.statusVars = null;
        } else {
          resolveCheckedFromConfirmed();
          state.phase = 'ready';
          state.statusKey = state.hadOrphansOnLoad
            ? 'settings.localHarnessSavedOrphans'
            : 'settings.localHarnessSaved';
          state.statusVars = null;
          state.hadOrphansOnLoad = false;
        }
      } else {
        state.desiredIds = null;
        resolveCheckedFromConfirmed();
        state.statusKey = 'settings.localHarnessSaveError';
        state.statusVars = null;
      }
      renderLocalHarnessPlugins();
    }
  } finally {
    state.saving = false;
  }
  renderLocalHarnessPlugins();
}

/**
 * Bind the section once. Safe to call before the panel is visible.
 *
 * @returns {void}
 */
export function initLocalHarnessPlugins() {
  if (localHarnessBound || typeof document === 'undefined') return;
  if (!document.getElementById(ROOT_ID)) return;
  localHarnessBound = true;
  window.addEventListener('cr-lang-changed', () => {
    renderLocalHarnessPlugins();
  });
  renderLocalHarnessPlugins();
}

/**
 * Load settings + catalog for the local section and render it. Uses its own
 * sequence counter so a slow response can never overwrite a newer one. Errors
 * keep the previously rendered list.
 *
 * @returns {Promise<void>}
 */
export async function refreshLocalHarnessPlugins() {
  if (typeof document === 'undefined') return;
  if (!document.getElementById(ROOT_ID)) return;
  if (state.saving) return;

  const seq = ++localHarnessLoadSeq;
  state.phase = 'loading';
  state.statusKey = '';
  state.statusVars = null;
  renderLocalHarnessPlugins();

  let settings = null;
  let catalog = null;
  try {
    [settings, catalog] = await Promise.all([api.getSettings(), api.getHarnessCatalog()]);
  } catch {
    settings = null;
    catalog = null;
  }
  if (seq !== localHarnessLoadSeq) return;

  if (!settings?.ok || !catalog?.ok || !Array.isArray(catalog.items)) {
    state.phase = 'error';
    state.statusKey = 'settings.localHarnessLoadError';
    state.statusVars = null;
    renderLocalHarnessPlugins();
    return;
  }

  state.rows = filterLocalHarnessRows(catalog.items);
  state.confirmedIds = normalizeLocalHarnessIds(settings.enabledLocalHarnesses);
  state.orphanIds = orphanSavedLocalHarnessIds({
    discoveredIds: discoveredIds(),
    savedIds: state.confirmedIds,
  });
  state.hadOrphansOnLoad = state.orphanIds.length > 0;
  resolveCheckedFromConfirmed();
  state.phase = 'ready';
  state.statusKey = '';
  state.statusVars = null;
  renderLocalHarnessPlugins();
}
