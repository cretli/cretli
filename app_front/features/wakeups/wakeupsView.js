/**
 * Settings → Wake-ups: pure view-model and markup helpers (no DOM, no fetch)
 * shared by `wakeupsSettings.js` and the unit tests. The view is kind-agnostic:
 * per-kind settings are rendered from the kind's `settingsSchema`.
 */

import { escapeHtml } from '../usage/usageCharts.js';

/** Row states the UI knows a label for; anything else is shown verbatim. */
export const WAKEUP_STATES = Object.freeze(['armed', 'resuming', 'resumed', 'cancelled', 'expired', 'blocked']);

/**
 * @param {(key: string, vars?: object) => string} t
 * @param {string} key
 * @param {string} fallback shown when the dictionary has no entry for `key`
 * @returns {string}
 */
function translateOr(t, key, fallback) {
  const text = t(key);
  return text && text !== key ? text : fallback;
}

/**
 * @param {unknown} iso
 * @param {string} [locale]
 * @returns {string} localized date-time, or a dash for a missing/unparseable value
 */
export function formatWakeupTime(iso, locale) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(locale || undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Display model of one `GET /api/wakeups` row; values stay raw (escaping
 * happens once, in the render functions).
 *
 * @param {object} item
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [locale]
 * @param {Map<string, string>|Record<string, string>} [kindLabels] kind id -> label
 */
export function buildWakeupRowModel(item, t, locale, kindLabels = {}) {
  const kind = String(item?.kind || '');
  const state = String(item?.state || '');
  const labels = kindLabels instanceof Map ? Object.fromEntries(kindLabels) : kindLabels;
  const subject = [item?.subjectType, item?.subjectId].filter(Boolean).join(': ');
  return {
    id: String(item?.id || ''),
    kind: labels[kind] || kind || '—',
    subject: subject || '—',
    dueAt: formatWakeupTime(item?.dueAt, locale),
    state: WAKEUP_STATES.includes(state) ? t(`wakeups.state_${state}`) : state || '—',
    reason: String(item?.reason || '—'),
    attempts: String(Number(item?.attempts) || 0),
    canCancel: state === 'armed',
  };
}

/**
 * @param {object[]} items
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [locale]
 * @param {Record<string, string>} [kindLabels]
 * @returns {string} escaped table markup, or an empty-state hint for an empty list
 */
export function renderWakeupRowsHtml(items, t, locale, kindLabels = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return `<p class="settings-hint">${escapeHtml(t('wakeups.empty'))}</p>`;
  const rows = list.map((item) => {
    const row = buildWakeupRowModel(item, t, locale, kindLabels);
    const action = row.canCancel
      ? `<cr-bar-button type="button" data-wakeup-cancel="${escapeHtml(row.id)}">${escapeHtml(t('wakeups.cancel'))}</cr-bar-button>`
      : '';
    return `<tr><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.subject)}</td>`
      + `<td>${escapeHtml(row.dueAt)}</td><td>${escapeHtml(row.state)}</td>`
      + `<td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.attempts)}</td><td>${action}</td></tr>`;
  }).join('');
  const head = ['colKind', 'colSubject', 'colDue', 'colState', 'colReason', 'colAttempts']
    .map((key) => `<th scope="col">${escapeHtml(t(`wakeups.${key}`))}</th>`).join('');
  return `<div class="settings-usage-table-scroll"><table class="settings-usage-table"><thead><tr>${head}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * Field descriptors of one kind, in schema order, merged with the stored value.
 *
 * @param {{ settings?: object, settingsSchema?: object }} kind
 * @returns {Array<{ key: string, type: string, min?: number, max?: number, default?: unknown, value: unknown }>}
 */
export function buildKindFields(kind) {
  const schema = kind?.settingsSchema && typeof kind.settingsSchema === 'object' ? kind.settingsSchema : {};
  const settings = kind?.settings && typeof kind.settings === 'object' ? kind.settings : {};
  return Object.entries(schema)
    .filter(([, spec]) => spec && (spec.type === 'boolean' || spec.type === 'integer'))
    .map(([key, spec]) => ({
      key,
      type: spec.type,
      min: spec.min,
      max: spec.max,
      default: spec.default,
      value: key in settings ? settings[key] : spec.default,
    }));
}

/**
 * Builds the PATCH body for one kind from raw control values. An empty or
 * non-numeric integer field is omitted so the server keeps the stored value;
 * the server clamps to the bounds.
 *
 * @param {{ settingsSchema?: object }} kind
 * @param {Record<string, string|boolean|undefined>} values keyed by setting key
 * @returns {Record<string, number|boolean>}
 */
export function buildKindSettingsPatch(kind, values = {}) {
  const patch = {};
  for (const field of buildKindFields(kind)) {
    if (field.type === 'boolean') {
      patch[field.key] = values[field.key] === true;
      continue;
    }
    const raw = String(values[field.key] ?? '').trim();
    const numeric = Number(raw);
    if (raw && Number.isFinite(numeric)) patch[field.key] = Math.round(numeric);
  }
  return patch;
}

function renderFieldHtml(kindId, field, t) {
  const id = `wakeup-${kindId}-${field.key}`;
  const label = escapeHtml(translateOr(t, `wakeups.field_${field.key}`, field.key));
  if (field.type === 'boolean') {
    return `<label class="settings-usage-toggle"><input type="checkbox" id="${escapeHtml(id)}" data-wakeup-field="${escapeHtml(field.key)}"${field.value === true ? ' checked' : ''} /> <span>${label}</span></label>`;
  }
  const bounds = `${Number.isFinite(field.min) ? ` min="${field.min}"` : ''}${Number.isFinite(field.max) ? ` max="${field.max}"` : ''}`;
  const value = field.value == null ? '' : String(field.value);
  return `<div class="cr-field"><label class="cr-field-label" for="${escapeHtml(id)}">${label}</label>`
    + `<input id="${escapeHtml(id)}" type="number"${bounds} step="1" inputmode="numeric" data-wakeup-field="${escapeHtml(field.key)}" value="${escapeHtml(value)}" /></div>`;
}

/**
 * @param {object[]} kinds `GET /api/wakeups/kinds` entries
 * @param {(key: string, vars?: object) => string} t
 * @returns {string} one card per kind; an empty-state hint without kinds
 */
export function renderKindsHtml(kinds, t) {
  const list = Array.isArray(kinds) ? kinds : [];
  if (!list.length) return `<p class="settings-hint">${escapeHtml(t('wakeups.noKinds'))}</p>`;
  return list.map((kind) => {
    const kindId = String(kind?.kind || '');
    const fields = buildKindFields(kind);
    const enabledKey = t(kind?.enabled ? 'wakeups.enabled' : 'wakeups.disabled');
    const body = fields.length
      ? `<div class="cr-form">${fields.map((field) => renderFieldHtml(kindId, field, t)).join('')}</div>`
        + `<div class="cr-row"><cr-bar-button variant="primary" type="button" data-wakeup-kind-save="${escapeHtml(kindId)}">${escapeHtml(t('wakeups.save'))}</cr-bar-button>`
        + `<span class="cr-status" data-wakeup-kind-status="${escapeHtml(kindId)}" aria-live="polite"></span></div>`
      : `<p class="settings-hint">${escapeHtml(t('wakeups.noSettings'))}</p>`;
    const description = kind?.description ? `<p class="settings-hint">${escapeHtml(kind.description)}</p>` : '';
    return `<div class="cr-card" data-wakeup-kind="${escapeHtml(kindId)}">`
      + `<h5 class="settings-usage-subtitle">${escapeHtml(kind?.label || kindId)} <span class="cr-hint">(${escapeHtml(enabledKey)})</span></h5>`
      + `${description}${body}</div>`;
  }).join('');
}

/**
 * @param {object|null} status `GET /api/wakeups/status` payload
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [locale]
 * @returns {string} scheduler status list; tolerates a missing payload and an empty `jobs`
 */
export function renderStatusHtml(status, t, locale) {
  if (!status || typeof status !== 'object') return `<p class="settings-hint">${escapeHtml(t('wakeups.statusUnavailable'))}</p>`;
  const kinds = Array.isArray(status.kinds) ? status.kinds : [];
  const jobs = Array.isArray(status.jobs) ? status.jobs : [];
  const tickSeconds = Math.round((Number(status.tickMs) || 0) / 1000);
  const rows = [
    [t('wakeups.statusRunning'), t(status.running ? 'wakeups.yes' : 'wakeups.no')],
    [t('wakeups.statusTick'), t('wakeups.seconds', { count: tickSeconds })],
    [t('wakeups.statusLastTick'), formatWakeupTime(status.lastTickAt, locale)],
    [t('wakeups.statusMaxPerTick'), kinds.length ? kinds.map((k) => `${k.kind}: ${Number(k.maxPerTick) || 1}`).join(', ') : '—'],
    [t('wakeups.statusJobs'), String(jobs.length)],
  ];
  return `<dl class="settings-app-update-meta">${rows
    .map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${renderJobsHtml(jobs, t, locale)}`;
}

/**
 * @param {Array<object>} jobs periodic job rows from `GET /api/wakeups/status`
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [locale]
 * @returns {string} read-only periodic job list; empty string when there are no jobs
 */
export function renderJobsHtml(jobs, t, locale) {
  if (!Array.isArray(jobs) || !jobs.length) return '';
  const items = jobs.map((job) => {
    const seconds = Math.round((Number(job.intervalMs) || 0) / 1000);
    const result = job.lastError
      ? `${t('wakeups.jobError')}: ${job.lastError}`
      : (job.lastResult ? JSON.stringify(job.lastResult) : '—');
    const owner = job.settingKey === 'chatAutoArchive' ? ` ${t('wakeups.jobArchiveHint')}` : '';
    return `<li><strong>${escapeHtml(job.label || job.id)}</strong> — ${escapeHtml(t(job.enabled ? 'wakeups.enabled' : 'wakeups.disabled'))}, `
      + `${escapeHtml(t('wakeups.jobEvery', { count: seconds }))}, ${escapeHtml(t('wakeups.jobLastRun'))}: ${escapeHtml(formatWakeupTime(job.lastRunAt, locale))}, `
      + `${escapeHtml(result)}${escapeHtml(owner)}</li>`;
  });
  return `<h4 class="cr-section-title">${escapeHtml(t('wakeups.jobsTitle'))}</h4><ul class="settings-hint">${items.join('')}</ul>`;
}

/**
 * @param {Array<{ kind: string, label?: string }>} kinds
 * @param {(key: string, vars?: object) => string} t
 * @returns {string} `<option>` list for the kind filter (first option = all)
 */
export function renderKindFilterOptions(kinds, t) {
  const options = [`<option value="">${escapeHtml(t('wakeups.filterAll'))}</option>`];
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    options.push(`<option value="${escapeHtml(kind.kind)}">${escapeHtml(kind.label || kind.kind)}</option>`);
  }
  return options.join('');
}

/**
 * @param {(key: string, vars?: object) => string} t
 * @returns {string} `<option>` list for the state filter
 */
export function renderStateFilterOptions(t) {
  return [`<option value="">${escapeHtml(t('wakeups.filterAll'))}</option>`]
    .concat(WAKEUP_STATES.map((state) => `<option value="${state}">${escapeHtml(t(`wakeups.state_${state}`))}</option>`))
    .join('');
}

/**
 * @param {{ kind?: string, state?: string }} filters
 * @returns {string} query string for `GET /api/wakeups` (empty values omitted)
 */
export function buildWakeupQuery(filters = {}) {
  const params = new URLSearchParams();
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.state) params.set('state', filters.state);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Kind id of the scheduled-check rows rendered by the strip. */
export const CONDITION_CHECK_KIND = 'condition_check';

/**
 * @param {{ current?: unknown, target?: unknown, error?: unknown }|null|undefined} progress `details.progress`
 * @param {(key: string, vars?: object) => string} t
 * @returns {string} `7 / 20`, or a label when the check has not been evaluated yet
 */
export function formatCheckProgress(progress, t) {
  if (!progress || typeof progress !== 'object') return t('wakeups.check_notEvaluated');
  if (progress.error) return t('wakeups.check_predicateError');
  const current = Number(progress.current);
  const target = Number(progress.target);
  if (!Number.isFinite(current) || !Number.isFinite(target)) return t('wakeups.check_notEvaluated');
  return `${current} / ${target}`;
}

/**
 * Display model of one `condition_check` row; values stay raw (escaped in the render).
 *
 * @param {object} item `GET /api/wakeups` row
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [locale]
 */
export function buildCheckRowModel(item, t, locale) {
  const state = String(item?.state || '');
  const details = item?.details && typeof item.details === 'object' ? item.details : {};
  const chatId = String(details.startedChatId || '');
  return {
    id: String(item?.id || ''),
    title: String(details.title || item?.subjectId || '—'),
    progress: formatCheckProgress(details.progress, t),
    expiresAt: formatWakeupTime(details.expiresAt, locale),
    state: WAKEUP_STATES.includes(state) ? t(`wakeups.state_${state}`) : state || '—',
    canAct: state === 'armed',
    chatHref: chatId ? `/?panel=chat&chat=${encodeURIComponent(chatId)}` : '',
  };
}

/**
 * @param {object[]} items rows of kind `condition_check`
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [locale]
 * @returns {string} strip markup; an empty string when there is nothing to show (the strip hides)
 */
export function renderChecksHtml(items, t, locale) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item?.kind === CONDITION_CHECK_KIND);
  if (!list.length) return '';
  return list.map((item) => {
    const row = buildCheckRowModel(item, t, locale);
    const id = escapeHtml(row.id);
    const actions = row.canAct
      ? `<cr-bar-button type="button" data-check-run="${id}">${escapeHtml(t('wakeups.check_runNow'))}</cr-bar-button>`
        + `<cr-bar-button type="button" data-wakeup-cancel="${id}">${escapeHtml(t('wakeups.cancel'))}</cr-bar-button>`
      : '';
    const link = row.chatHref
      ? `<a class="cr-hint" href="${escapeHtml(row.chatHref)}">${escapeHtml(t('wakeups.check_openChat'))}</a>`
      : '';
    return `<div class="cr-card cr-row" data-check-row="${id}">`
      + `<strong>${escapeHtml(row.title)}</strong>`
      + `<span class="cr-hint" data-check-progress>${escapeHtml(row.progress)}</span>`
      + `<span class="cr-hint">${escapeHtml(t('wakeups.check_expires', { when: row.expiresAt }))}</span>`
      + `<span class="cr-hint">${escapeHtml(row.state)}</span>${link}${actions}</div>`;
  }).join('');
}

/**
 * Text shown for a failed `Run now`: the current progress for a
 * `condition_not_met` conflict (not an error), a generic message otherwise.
 *
 * @param {{ code?: string, progress?: object|null }|null} result
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
export function describeRunNowResult(result, t) {
  if (result?.code === 'condition_not_met') {
    return t('wakeups.check_notMet', { progress: formatCheckProgress(result.progress, t) });
  }
  return t('wakeups.check_runFailed');
}
