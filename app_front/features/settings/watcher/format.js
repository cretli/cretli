/**
 * Small pure helpers shared by the Watcher settings views and controllers.
 */

import { t } from '../../../i18n/index.js';
import { CLOCK_RE } from './constants.js';

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

/**
 * Whether a stored quiet-hours pair reads back as "enabled" — both bounds must
 * be well-formed HH:MM. The server has no `enabled` flag: an empty/invalid pair
 * already means "no quiet window" in the guardrails, so the toggle is derived
 * from the values rather than a separate persisted field.
 *
 * @param {{ start?: unknown, end?: unknown }} [quiet]
 * @returns {boolean}
 */
export function quietHoursActive(quiet) {
  const start = String(quiet?.start ?? '').trim();
  const end = String(quiet?.end ?? '').trim();
  return CLOCK_RE.test(start) && CLOCK_RE.test(end) && start !== end;
}

/**
 * Render a cooldown duration in ms as the unit the slider trades in: seconds
 * under a minute, otherwise minutes (one decimal, trailing zero trimmed).
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatCooldownLabel(ms) {
  const value = Number(ms) || 0;
  if (value >= 3_600_000) {
    const hours = value / 3_600_000;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${t('settings.watcherHourUnit')}`;
  }
  if (value < 60_000) {
    // The slider stores seconds as milliseconds, so sub-minute values must be
    // divided down; rendering the raw ms value produced "30000 s".
    const seconds = value / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} ${t('settings.watcherSecondUnit')}`;
  }
  const minutes = value / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} ${t('settings.watcherMinuteUnit')}`;
}

/**
 * Render a duration field edited in minutes (the policy stores ms) with a live
 * human-readable hint, so nobody has to type 21600000.
 *
 * @param {{ id: string, labelKey: string, ms: number }} opts
 * @returns {string}
 */
export function renderDurationField({ id, labelKey, ms }) {
  const minutes = Math.round(((Number(ms) || 0) / 60_000) * 100) / 100;
  return `<label class="cr-field"><span class="cr-field-label">${escapeHtml(t(labelKey))}</span>`
    + `<span class="watcher-duration"><input id="${id}" type="number" inputmode="decimal" min="0" step="0.5" value="${minutes}" data-watcher-duration>`
    + `<span class="watcher-duration-unit">${escapeHtml(t('settings.watcherMinuteUnit'))}</span></span>`
    + `<span class="cr-hint" data-watcher-duration-out="${id}">≈ ${escapeHtml(formatCooldownLabel(Number(ms) || 0))}</span></label>`;
}

/** Read a minutes-based duration field back as whole milliseconds. */
export function readDurationMs(root, id) {
  const minutes = Number(root.querySelector(`#${id}`)?.value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0;
}

/**
 * @param {any | null | undefined} watcher
 * @returns {string}
 */
export function formatActiveCyclesSummary(watcher) {
  const cycles = Array.isArray(watcher?.activeCycles) && watcher.activeCycles.length
    ? watcher.activeCycles
    : (watcher?.activeCycle ? [watcher.activeCycle] : []);
  if (!cycles.length) return '-';
  return cycles.map((cycle) => (
    `${String(cycle.cycleId || '').slice(0, 8)} · chat ${String(cycle.chatId || '').slice(0, 8)}`
  )).join('; ');
}

/**
 * Look up a form control by selector. The panel markup is built from strings,
 * so the control types are not known to the checker.
 *
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {any}
 */
export function queryField(root, selector) {
  return root.querySelector(selector);
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {any[]}
 */
export function queryFields(root, selector) {
  return [...root.querySelectorAll(selector)];
}
