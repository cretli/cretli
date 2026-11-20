/**
 * Browser session mode helpers (built-in Chromium vs external Chrome over CDP):
 * the new-session mode select, the per-session badge and the external-profile
 * banner. Kept DOM-light and state-free so the panel only wires them.
 */

import { t } from '../../i18n/index.js';
import { escapeHtml } from '../chat/chatHtmlUtils.js';

/**
 * Options of the new-session mode select. "Default" has an empty value, which
 * sends no `browserMode`, so the server resolves the Settings default
 * (including `auto`); its label names that default when known.
 * @param {string} [defaultMode]
 * @returns {Array<{ value: string, label: string }>}
 */
export function newSessionModeOptions(defaultMode = '') {
  const named = ['builtin', 'external', 'auto'].includes(defaultMode)
    ? t('browser.modeDefaultNamed', { mode: t(`browser.mode.${defaultMode}`) })
    : t('browser.modeDefault');
  return [
    { value: '', label: named },
    { value: 'builtin', label: t('browser.mode.builtin') },
    { value: 'external', label: t('browser.mode.external') },
  ];
}

/**
 * Body of the new-session request. `browserMode` is the session mode; the chat
 * `mode` is stamped separately and never touched here.
 * @param {unknown} selected
 * @returns {{ browserMode?: 'builtin' | 'external' }}
 */
export function newSessionBody(selected) {
  return selected === 'builtin' || selected === 'external' ? { browserMode: selected } : {};
}

/**
 * @param {Record<string, any>} session
 * @returns {string} badge markup for the session card
 */
export function sessionModeBadgeHtml(session) {
  const mode = session?.mode === 'external' ? 'external' : 'builtin';
  return `<span class="browser-mode-badge browser-mode-badge--${mode}" data-browser-session-mode="${mode}">${escapeHtml(t(`browser.modeBadge.${mode}`))}</span>`;
}

/**
 * The external-profile banner applies only to a selected external session.
 * @param {HTMLElement | null} el
 * @param {boolean} available
 * @param {Array<Record<string, any>>} sessions
 * @param {string} sessionId selected session
 */
export function renderExternalWarning(el, available, sessions, sessionId) {
  if (!el) return;
  const selected = sessions.find((session) => session.browserSessionId === sessionId);
  el.hidden = !available || selected?.mode !== 'external';
  el.textContent = el.hidden ? '' : t('browser.externalWarning');
}

/**
 * Refreshes the new-session mode select, keeping a still-valid choice.
 * @param {any} select
 * @param {string} [defaultMode]
 */
export function syncNewSessionModeSelect(select, defaultMode = '') {
  if (!select) return;
  select.options = newSessionModeOptions(defaultMode);
  if (select.value !== 'builtin' && select.value !== 'external') select.value = '';
}
