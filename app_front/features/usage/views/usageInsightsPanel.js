/**
 * Settings → Usage: paints the token buckets, coverage, executed choices and
 * outcome signals sections from the /api/usage/insights payload.
 */

import { getCurrentLang, t } from '../../../i18n/index.js';
import { renderUsage } from '../usageDom.js';
import {
  renderChoicesView,
  renderCoverageView,
  renderSignalsView,
  renderTokenBucketsView,
  sectionHint,
} from '../usageInsightsView.js';

/** @param {string} id @returns {any} */
const byId = (id) => document.getElementById(id);

/**
 * Paints the disjoint buckets, coverage, executed choices and outcome signals
 * from the single filter-consistent /api/usage/insights payload.
 *
 * @param {any} insights
 * @returns {void}
 */
export function renderInsights(insights) {
  const lang = getCurrentLang();
  const bucketsEl = byId('usage-buckets');
  if (bucketsEl) renderUsage(bucketsEl, renderTokenBucketsView(insights?.tokens, { t, lang }));
  const coverageEl = byId('usage-coverage');
  if (coverageEl) renderUsage(coverageEl, renderCoverageView(insights?.coverage, { t, lang }));
  const choicesEl = byId('usage-choices');
  if (choicesEl) renderUsage(choicesEl, renderChoicesView(insights?.choices, { t, lang }));
  const signalsEl = byId('usage-signals');
  if (signalsEl) renderUsage(signalsEl, renderSignalsView(insights?.signals, { t, lang }));
}

/**
 * @returns {void}
 */
export function renderInsightsError() {
  const message = t('usage.sectionLoadFailed');
  for (const id of ['usage-buckets', 'usage-coverage', 'usage-choices', 'usage-signals']) {
    const el = byId(id);
    if (el) renderUsage(el, sectionHint(message));
  }
}
