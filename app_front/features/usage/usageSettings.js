/**
 * Settings → Usage: month/today totals from the server ledger.
 */

import { getUsageSummary } from '../../api.js';
import { t } from '../../i18n/index.js';
import { formatUsd } from '../../../lib/usage/usage-rates.js';

const PROVIDER_KEYS = {
  openai: 'usage.openai',
  google: 'usage.google',
  azure: 'usage.azure',
  openrouter: 'usage.openrouter',
  cursor: 'usage.cursor',
  other: 'usage.other',
};

const FEATURE_KEYS = {
  'voice-live': 'usage.voiceLive',
  'voice-tts': 'usage.voiceTts',
  'voice-stt': 'usage.voiceStt',
  chat: 'usage.chat',
  other: 'usage.other',
};

/**
 * @param {object} [tokens]
 * @returns {number}
 */
function sumTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  return (
    Number(tokens.textInput || 0) +
    Number(tokens.textOutput || 0) +
    Number(tokens.audioInput || 0) +
    Number(tokens.audioOutput || 0) +
    Number(tokens.cachedInput || 0) +
    Number(tokens.reasoning || 0)
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} key
 * @param {Record<string, string>} map
 * @returns {string}
 */
function labelFor(key, map) {
  const i18nKey = map[key];
  return i18nKey ? t(i18nKey) : key;
}

/**
 * @param {object} row
 * @returns {string}
 */
function formatRowUsd(row) {
  const usd = Number.isFinite(row?.usd) ? row.usd : row?.totalUsd;
  if (Number(row?.unpricedEvents) > 0 && !(Number.isFinite(usd) && usd > 0)) {
    return t('usage.unpriced');
  }
  if (Number.isFinite(usd) && usd > 0) return formatUsd(usd);
  return '$0.00';
}

/**
 * @param {HTMLTableSectionElement|null} tbody
 * @param {Record<string, object>} groups
 * @param {Record<string, string>} labels
 * @returns {void}
 */
function renderGroupRows(tbody, groups, labels) {
  if (!tbody) return;
  const entries = Object.entries(groups || {}).sort((left, right) =>
    labelFor(left[0], labels).localeCompare(labelFor(right[0], labels))
  );
  if (!entries.length) {
    tbody.innerHTML = '';
    return;
  }
  tbody.innerHTML = entries
    .map(([key, row]) => {
      const tokens = Math.round(sumTokens(row.tokens));
      return `<tr><td>${escapeHtml(labelFor(key, labels))}</td><td>${escapeHtml(formatRowUsd(row))}</td><td>${tokens}</td></tr>`;
    })
    .join('');
}

/**
 * Reloads GET /api/usage/summary and paints the Usage tab.
 *
 * @returns {Promise<void>}
 */
export async function refreshUsageSettings() {
  const periodEl = document.getElementById('usage-summary-period');
  const todayEl = document.getElementById('usage-summary-today');
  const monthEl = document.getElementById('usage-summary-month');
  const emptyEl = document.getElementById('usage-summary-empty');
  const providerBody = document.querySelector('#usage-by-provider tbody');
  const featureBody = document.querySelector('#usage-by-feature tbody');
  if (!periodEl || !todayEl || !monthEl) return;
  try {
    const payload = await getUsageSummary();
    if (!payload?.ok || !payload.summary) {
      throw new Error(payload?.error || 'usage summary failed');
    }
    const summary = payload.summary;
    const todayKey = new Date().toISOString().slice(0, 10);
    const today = summary.byDay?.[todayKey] || { usd: 0, tokens: {}, unpricedEvents: 0 };
    const monthTokens = Math.round(sumTokens(summary.tokens));
    const todayTokens = Math.round(sumTokens(today.tokens));
    periodEl.textContent = t('usage.period', {
      from: String(payload.from || '').slice(0, 10),
      to: String(payload.to || '').slice(0, 10),
    });
    todayEl.textContent = t('usage.today', {
      usd: formatRowUsd(today),
      tokens: todayTokens,
    });
    monthEl.textContent = t('usage.month', {
      usd: formatRowUsd(summary),
      tokens: monthTokens,
    });
    const hasEvents =
      monthTokens > 0 ||
      Number(summary.totalUsd) > 0 ||
      Number(summary.unpricedEvents) > 0;
    if (emptyEl) emptyEl.hidden = hasEvents;
    renderGroupRows(providerBody, summary.byProvider, PROVIDER_KEYS);
    renderGroupRows(featureBody, summary.byFeature, FEATURE_KEYS);
  } catch (_error) {
    periodEl.textContent = t('usage.loadFailed');
    todayEl.textContent = '';
    monthEl.textContent = '';
    if (emptyEl) emptyEl.hidden = true;
    if (providerBody) providerBody.innerHTML = '';
    if (featureBody) featureBody.innerHTML = '';
  }
}

/**
 * Wires a language-change reload. First paint happens when the tab opens.
 *
 * @returns {void}
 */
export function initUsageSettings() {
  if (typeof window === 'undefined') return;
  window.addEventListener('cr-lang-changed', () => {
    const section = document.querySelector('.settings-section[data-settings-tab="usage"]');
    if (section && !section.hidden) void refreshUsageSettings();
  });
}
