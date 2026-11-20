/**
 * Settings → Usage → "Auto-resume after limit reset": pure helpers (no DOM, no
 * fetch) shared by `usageSettings.js` and the unit tests.
 */

import { html } from 'lit';

/** Numeric settings fields: input id suffix -> settings key. */
export const LIMIT_RESUME_NUMBER_FIELDS = Object.freeze({
  'usage-resume-margin': 'marginMs',
  'usage-resume-jitter': 'jitterMs',
  'usage-resume-max-chain': 'maxChain',
  'usage-resume-max-per-tick': 'maxPerTick',
  'usage-resume-catch-up': 'catchUpMs',
});

/** Checkbox settings fields: input id -> settings key. */
export const LIMIT_RESUME_TOGGLE_FIELDS = Object.freeze({
  'usage-resume-enabled': 'enabled',
  'usage-resume-allow-premium': 'allowPremium',
  'usage-resume-delegations': 'resumeDelegations',
});

/**
 * Builds the PATCH body from raw field values. An empty or non-numeric field is
 * omitted so the server keeps the stored value; bounds are clamped server-side.
 *
 * @param {Record<string, string|boolean|undefined>} values keyed by input id
 * @returns {Record<string, number|boolean>}
 */
export function buildLimitResumePatch(values = {}) {
  const patch = {};
  for (const [id, key] of Object.entries(LIMIT_RESUME_TOGGLE_FIELDS)) {
    patch[key] = values[id] === true;
  }
  for (const [id, key] of Object.entries(LIMIT_RESUME_NUMBER_FIELDS)) {
    const raw = String(values[id] ?? '').trim();
    const numeric = Number(raw);
    if (raw && Number.isFinite(numeric)) patch[key] = Math.round(numeric);
  }
  return patch;
}

/**
 * @param {unknown} iso
 * @param {string} [locale]
 * @returns {string}
 */
export function formatResetAt(iso, locale) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(locale || undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Display model of one `GET /api/usage/limit-resume` row. Values stay raw here;
 * Lit escapes them when `renderLimitResumeRowsView` is rendered.
 *
 * @param {object} item
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [locale]
 */
export function buildLimitResumeRowModel(item, t, locale) {
  const target = [item?.harness, item?.model].filter(Boolean).join('/') || '—';
  const state = String(item?.state || '');
  const known = ['armed', 'resuming', 'resumed', 'cancelled', 'expired', 'blocked'].includes(state);
  return {
    id: String(item?.id || ''),
    target,
    subjectModel: String(item?.subjectModel || '—'),
    resetAt: formatResetAt(item?.resetAt, locale),
    state: known ? t(`usageLimitResume.state_${state}`) : state || '—',
    reason: String(item?.reason || '—'),
    canCancel: state === 'armed',
  };
}

/**
 * @param {object[]} items
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [locale]
 * @returns {import('lit').TemplateResult} table of rows, or an empty-state hint
 */
export function renderLimitResumeRowsView(items, t, locale) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return html`<p class="settings-hint">${t('usageLimitResume.empty')}</p>`;
  const rows = list.map((item) => {
    const row = buildLimitResumeRowModel(item, t, locale);
    return html`<tr><td>${row.target}</td><td>${row.subjectModel}</td>
      <td>${row.resetAt}</td><td>${row.state}</td>
      <td>${row.reason}</td><td>${row.canCancel
    ? html`<button type="button" class="settings-usage-btn" data-limit-resume-cancel=${row.id}>${t('usageLimitResume.cancel')}</button>`
    : ''}</td></tr>`;
  });
  const head = ['colTarget', 'colSubject', 'colReset', 'colState', 'colReason']
    .map((key) => html`<th scope="col">${t(`usageLimitResume.${key}`)}</th>`);
  return html`<div class="settings-usage-table-scroll"><table class="settings-usage-table"><thead><tr>${head}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
