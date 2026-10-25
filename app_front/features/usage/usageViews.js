/**
 * Settings → Usage sub-views (Overview / Analysis / Billing / Limits /
 * Delegations / Settings): which hosts are visible, the remembered choice and
 * the tab bar wiring. Loading lives in `usageSettings.js`; this module only
 * switches what is shown.
 */

import { getUsagePlanLimits } from '../../core/api/index.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import { renderPlanLimitsView } from './planLimitsView.js';
import { renderUsage } from './usageDom.js';

/** Sub-views of Settings → Usage, in tab order. */
export const USAGE_VIEWS = Object.freeze(['overview', 'analysis', 'billing', 'limits', 'delegations', 'settings']);
const USAGE_VIEW_STORAGE_KEY = 'cretli-usage-view';

/**
 * @param {unknown} view
 * @returns {string}
 */
export function normalizeUsageView(view) {
  return USAGE_VIEWS.includes(String(view)) ? String(view) : 'overview';
}

/** @returns {string} */
export function readStoredUsageView() {
  try {
    return normalizeUsageView(typeof localStorage !== 'undefined' ? localStorage.getItem(USAGE_VIEW_STORAGE_KEY) : '');
  } catch {
    return 'overview';
  }
}

/** @param {string} view */
export function storeUsageView(view) {
  try {
    localStorage.setItem(USAGE_VIEW_STORAGE_KEY, normalizeUsageView(view));
  } catch {
    /* the remembered view is a convenience */
  }
}

/** @returns {HTMLElement|null} */
export function getUsageSection() {
  if (typeof document === 'undefined') return null;
  return document.querySelector('.settings-section[data-settings-tab="usage"]');
}

/**
 * Show one sub-view. Hosts list the views they belong to in `data-usage-view`
 * (the filter bar serves Overview and Analysis); `data-usage-view-part`
 * splits the shared ledger content between those two.
 *
 * @param {string} view
 * @param {ParentNode|null} [root]
 * @returns {void}
 */
export function applyUsageView(view, root = getUsageSection()) {
  if (!root) return;
  for (const host of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-usage-view]'))) {
    const views = String(host.getAttribute('data-usage-view') || '').split(/\s+/);
    host.hidden = !views.includes(view);
  }
  for (const part of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-usage-view-part]'))) {
    part.hidden = part.getAttribute('data-usage-view-part') !== view;
  }
  for (const tab of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-usage-view-tab]'))) {
    const selected = tab.getAttribute('data-usage-view-tab') === view;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
  }
  const shared = root.querySelector('#usage-view-overview');
  if (shared) shared.setAttribute('aria-labelledby', `usage-view-tab-${view === 'analysis' ? 'analysis' : 'overview'}`);
}

/**
 * Sub-view tabs: click selects, Left/Right/Home/End move between tabs
 * (WAI-ARIA tabs pattern with automatic activation).
 *
 * @param {(view: string) => void} onSelect
 * @returns {void}
 */
export function wireUsageViewTabs(onSelect) {
  const root = getUsageSection();
  if (!root) return;
  const tabs = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-usage-view-tab]')]);
  for (const tab of tabs) {
    tab.addEventListener('click', () => onSelect(normalizeUsageView(tab.getAttribute('data-usage-view-tab'))));
    tab.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      const index = tabs.indexOf(tab);
      let next = -1;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      onSelect(normalizeUsageView(tabs[next].getAttribute('data-usage-view-tab')));
    });
  }
}

/**
 * Plan limits panel (latest readings, lockouts, Codex credits).
 *
 * @returns {Promise<void>}
 */
export async function refreshPlanLimitsPanel() {
  const planEl = document.getElementById('usage-plan-limits');
  if (!planEl) return;
  // Lit owns this host: a textContent write would drop its markers and the
  // next render would append after the stale text ("Loading…Failed").
  renderUsage(planEl, t('usage.loading'));
  const [planResult] = await Promise.allSettled([getUsagePlanLimits()]);
  renderUsage(planEl, planResult.status === 'fulfilled' && planResult.value?.ok
    ? renderPlanLimitsView(planResult.value, { t, lang: getCurrentLang() })
    : t('usage.sectionLoadFailed'));
}
