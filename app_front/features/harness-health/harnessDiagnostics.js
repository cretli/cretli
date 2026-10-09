/**
 * Settings → Harness: read-only model diagnostics panel.
 *
 * Fetches `GET /api/harness-diagnostics` and renders the pure view model from
 * `harnessDiagnosticsModel.js`. The panel is loaded lazily (when the Harness
 * tab is active or the user presses Refresh); opening the screen never starts
 * an agent or a delegation, because the endpoint only reads catalogs and
 * aggregates.
 */

import { getHarnessDiagnostics } from '../../api.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import {
  buildDiagnosticsViewModel,
  renderDiagnosticsHtml,
} from './harnessDiagnosticsModel.js';

/** Roles offered by the endpoint, in the same order as the picker. */
export const HARNESS_DIAGNOSTICS_ROLES = Object.freeze(['plan', 'implement', 'review', 'fix']);

const ROLE_LABEL_KEYS = Object.freeze({
  plan: 'harnessDiagnostics.rolePlan',
  implement: 'harnessDiagnostics.roleImplement',
  review: 'harnessDiagnostics.roleReview',
  fix: 'harnessDiagnostics.roleFix',
});

let wired = false;
let loadSeq = 0;
let currentRole = 'implement';

/**
 * @returns {HTMLElement|null}
 */
function outputEl() {
  return document.getElementById('harness-diagnostics-output');
}

/**
 * @returns {HTMLElement|null}
 */
function statusEl() {
  return document.getElementById('harness-diagnostics-status');
}

/**
 * @param {string} message
 * @returns {void}
 */
function setStatus(message) {
  const el = statusEl();
  if (el) el.textContent = message || '';
}

/**
 * @returns {Array<{ value: string, label: string }>}
 */
function roleOptions() {
  return HARNESS_DIAGNOSTICS_ROLES.map((value) => ({
    value,
    label: t(ROLE_LABEL_KEYS[value] || value, { role: value }) || value,
  }));
}

/**
 * Fills the role select once and keeps it in sync with the active language.
 *
 * @returns {void}
 */
function fillRoleSelect() {
  const select = document.getElementById('harness-diagnostics-role');
  if (!select) return;
  select.options = roleOptions();
  select.value = currentRole;
}

/**
 * Opens Settings → Usage grouped by harness, the closest supported filter.
 *
 * @returns {void}
 */
function openUsage() {
  const groupSelect = document.getElementById('usage-group-select');
  if (groupSelect instanceof HTMLSelectElement) {
    groupSelect.value = 'harness';
    groupSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const tabBtn = document.querySelector('#settings-tabs [data-settings-tab="usage"]')
    || document.querySelector('.settings-tab[data-settings-tab="usage"]');
  if (tabBtn instanceof HTMLElement) tabBtn.click();
}

/**
 * @param {object} report
 * @returns {void}
 */
function render(report) {
  const el = outputEl();
  if (!el) return;
  const lang = getCurrentLang();
  const model = buildDiagnosticsViewModel(report, lang, t('harnessDiagnostics.unknown'));
  el.innerHTML = renderDiagnosticsHtml(model, t);
}

/**
 * @param {boolean} [fresh]
 * @returns {Promise<void>}
 */
export async function loadHarnessDiagnostics(fresh = false) {
  const el = outputEl();
  if (!el) return;
  const select = document.getElementById('harness-diagnostics-role');
  currentRole = String(select?.value || currentRole || 'implement');
  const seq = ++loadSeq;
  setStatus(t('harnessDiagnostics.loading'));
  try {
    const report = await getHarnessDiagnostics({ role: currentRole, fresh });
    if (seq !== loadSeq) return;
    if (!report?.ok) {
      el.replaceChildren();
      setStatus(report?.error || t('harnessDiagnostics.loadFailed'));
      return;
    }
    render(report);
    setStatus('');
  } catch {
    if (seq !== loadSeq) return;
    setStatus(t('harnessDiagnostics.loadFailed'));
  }
}

/**
 * @returns {void}
 */
export function initHarnessDiagnostics() {
  const section = document.getElementById('harness-diagnostics-section');
  if (!section || wired) return;
  wired = true;
  fillRoleSelect();
  const select = document.getElementById('harness-diagnostics-role');
  if (select) {
    select.addEventListener('change', () => {
      currentRole = String(select.value || 'implement');
      void loadHarnessDiagnostics(false);
    });
  }
  const refresh = document.getElementById('harness-diagnostics-refresh');
  if (refresh) {
    refresh.addEventListener('click', () => {
      void loadHarnessDiagnostics(true);
    });
  }
  const el = outputEl();
  if (el) {
    el.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-action="details"]') : null;
      if (target) openUsage();
    });
  }
  window.addEventListener('cr-lang-changed', () => {
    fillRoleSelect();
    const current = outputEl();
    if (current && current.childElementCount > 0) void loadHarnessDiagnostics(false);
  });
}

/**
 * Called when the Harness settings tab becomes active. Loads lazily and never
 * more than once for the same role within a session unless the user refreshes.
 *
 * @returns {void}
 */
export function refreshHarnessDiagnosticsPanel() {
  const el = outputEl();
  if (!el || el.childElementCount === 0) void loadHarnessDiagnostics(false);
}
