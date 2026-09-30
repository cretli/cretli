/**
 * Settings → Harness health card: pure model, formatters and HTML/SVG builders.
 *
 * Everything in this file is DOM-free so the unit tests can import it under
 * Node. The caller owns translation: renderers receive already-resolved label
 * strings or a `t()` function.
 *
 * The backend payload is produced by `lib/usage/harness-health.js`:
 *   { activeLimit, planLimits[], limitHistory, runs, okRuns, errorRuns,
 *     limitHits, successRate, p50LatencyMs, p95LatencyMs, lastErrors[], daily[] }
 */

import {
  escapeHtml,
  formatInteger,
  formatPercent,
} from '../usage/usageCharts.js';

/** Plan snapshots are compared against a 7-day window in the UI. */
export const HARNESS_HEALTH_RANGE_DAYS = 7;
/** Sparkline width in user units. */
export const HARNESS_HEALTH_SPARK_WIDTH = 196;
/** Sparkline height in user units. */
export const HARNESS_HEALTH_SPARK_HEIGHT = 48;
/** Hard cap on the rendered error rows (backend already trims to 5). */
export const HARNESS_HEALTH_MAX_ERRORS = 5;

/**
 * @param {string} [lang]
 * @returns {string}
 */
function localeFor(lang) {
  return lang === 'pl' ? 'pl-PL' : 'en-US';
}

/**
 * @param {unknown} value
 * @param {number|null} [fallback]
 * @returns {number|null}
 */
function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nonNegative(value) {
  const num = finiteNumber(value, 0);
  return num != null && num > 0 ? num : 0;
}

/**
 * Local-time reset label. `HH:MM` by default; the date is prefixed when the
 * reset lands on another calendar day so the badge is never ambiguous.
 *
 * @param {unknown} iso
 * @param {{ lang?: string, now?: number }} [options]
 * @returns {string}
 */
export function formatResetTime(iso, options = {}) {
  const raw = String(iso || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const lang = options.lang === 'pl' ? 'pl' : 'en';
  const now = finiteNumber(options.now, Date.now()) ?? Date.now();
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const timePart = new Intl.DateTimeFormat(localeFor(lang), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  if (sameDay) return timePart;
  const datePart = new Intl.DateTimeFormat(localeFor(lang), {
    day: '2-digit',
    month: '2-digit',
  }).format(date);
  return `${datePart} ${timePart}`;
}

/**
 * Local date+time label for the last-errors list.
 *
 * @param {unknown} iso
 * @param {{ lang?: string }} [options]
 * @returns {string}
 */
export function formatErrorTime(iso, options = {}) {
  const raw = String(iso || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const lang = options.lang === 'pl' ? 'pl' : 'en';
  return new Intl.DateTimeFormat(localeFor(lang), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/**
 * Whole hours since a snapshot; null when the timestamp cannot be parsed.
 *
 * @param {unknown} iso
 * @param {number} [now]
 * @returns {number|null}
 */
export function formatStaleHours(iso, now = Date.now()) {
  const parsed = new Date(String(iso || '')).getTime();
  const nowMs = finiteNumber(now, Date.now()) ?? Date.now();
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / (60 * 60 * 1000)));
}

/**
 * Plan utilization is persisted as a percentage by the data layer
 * (`lib/usage/harness-health.js` upserts it verbatim, and every repo source and
 * test feeds percent — e.g. 82.5, 41, 12). The UI must not guess a scale per
 * value: `1` means 1%, not 100%, and `0.8` means 0.8%, not 80%.
 *
 * Returns the 0..1 fraction the progress bar/`formatPercent` expect, clamping
 * out-of-range values, or null when the snapshot has no utilization so the bar
 * is omitted instead of inventing 0%.
 *
 * @param {unknown} value percentage 0..100
 * @returns {number|null} 0..1 fraction, or null
 */
export function normalizeUtilization(value) {
  const num = finiteNumber(value);
  if (num == null) return null;
  return Math.max(0, Math.min(1, num / 100));
}

/**
 * @param {object} raw
 * @param {{ now: number, lang: string }} ctx
 * @returns {object|null}
 */
function normalizeActiveLimit(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const resetAt = String(raw.resetAt || '');
  const resetMs = resetAt ? new Date(resetAt).getTime() : NaN;
  // An expired row means the lockout is over; the card must not offer "Unlock".
  if (!Number.isFinite(resetMs) || resetMs <= ctx.now) return null;
  return {
    model: String(raw.model || ''),
    code: String(raw.code || ''),
    resetAt,
    resetTime: formatResetTime(resetAt, ctx),
  };
}

/**
 * @param {object} raw
 * @param {{ now: number, lang: string }} ctx
 * @returns {object|null}
 */
function normalizePlanLimit(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const utilization = normalizeUtilization(raw.utilization);
  const observedAt = String(raw.observedAt || '');
  const stale = raw.stale === true;
  const resetsAt = String(raw.resetsAt || '');
  return {
    rateLimitType: String(raw.rateLimitType || ''),
    status: String(raw.status || ''),
    utilization,
    utilizationText: utilization == null ? '' : formatPercent(utilization, ctx.lang),
    utilizationPercent: utilization == null ? null : Math.round(utilization * 100),
    resetsAt,
    resetTime: formatResetTime(resetsAt, ctx),
    observedAt,
    stale,
    staleHours: stale ? formatStaleHours(observedAt, ctx.now) : null,
  };
}

/**
 * Builds the render-ready card model. Unknown/missing fields degrade to the
 * empty state instead of zeros, so a fresh install never looks "0% healthy".
 *
 * @param {object|null|undefined} entry one `harnesses[id]` value from /api/harnesses/health
 * @param {{ now?: number, lang?: string }} [options]
 * @returns {object}
 */
export function buildHealthCardModel(entry, options = {}) {
  const now = finiteNumber(options.now, Date.now()) ?? Date.now();
  const lang = options.lang === 'pl' ? 'pl' : 'en';
  const src = entry && typeof entry === 'object' ? entry : {};
  const ctx = { now, lang };

  const runs = nonNegative(src.runs);
  const okRuns = nonNegative(src.okRuns);
  const errorRuns = nonNegative(src.errorRuns);
  const limitHits = nonNegative(src.limitHits);

  const activeLimit = normalizeActiveLimit(src.activeLimit, ctx);
  const planLimits = (Array.isArray(src.planLimits) ? src.planLimits : [])
    .map((row) => normalizePlanLimit(row, ctx))
    .filter(Boolean);

  const daily = (Array.isArray(src.daily) ? src.daily : []).map((row) => ({
    day: String(row?.day || ''),
    runs: nonNegative(row?.runs),
    errors: nonNegative(row?.errors),
  }));

  const p50 = finiteNumber(src.p50LatencyMs);
  const p95 = finiteNumber(src.p95LatencyMs);
  const lastErrors = (Array.isArray(src.lastErrors) ? src.lastErrors : [])
    .slice(0, HARNESS_HEALTH_MAX_ERRORS)
    .map((row) => ({
      ts: String(row?.ts || ''),
      time: formatErrorTime(row?.ts, { lang }),
      errorCode: row?.errorCode == null ? '' : String(row.errorCode),
      model: row?.model == null ? '' : String(row.model),
    }));

  const hasData = runs > 0;
  const status = activeLimit ? 'limit' : (hasData ? 'ok' : 'empty');

  return {
    harness: String(src.harness || ''),
    status,
    hasData,
    activeLimit,
    planLimits,
    daily,
    runs,
    okRuns,
    errorRuns,
    limitHits,
    successRate: hasData ? okRuns / runs : null,
    p50LatencyMs: p50 != null && p50 >= 0 ? p50 : null,
    p95LatencyMs: p95 != null && p95 >= 0 ? p95 : null,
    lastErrors,
  };
}

/**
 * Accessible 7-day sparkline: one run bar per day with the error share drawn on
 * top. The caller provides the translated aria-label.
 *
 * @param {Array<{ day?: string, runs?: number, errors?: number }>} daily
 * @param {{ ariaLabel?: string, width?: number, height?: number, runsLabel?: string, errorsLabel?: string }} [options]
 * @returns {string} SVG markup, or '' when there is no data to draw
 */
export function renderSparklineSvg(daily, options = {}) {
  const days = Array.isArray(daily) ? daily : [];
  if (days.length === 0) return '';
  const width = finiteNumber(options.width, HARNESS_HEALTH_SPARK_WIDTH) ?? HARNESS_HEALTH_SPARK_WIDTH;
  const height = finiteNumber(options.height, HARNESS_HEALTH_SPARK_HEIGHT) ?? HARNESS_HEALTH_SPARK_HEIGHT;
  const padX = 2;
  const padTop = 4;
  const padBottom = 2;
  const plotHeight = Math.max(1, height - padTop - padBottom);
  const plotWidth = Math.max(1, width - padX * 2);
  const maxRuns = days.reduce((max, day) => Math.max(max, nonNegative(day?.runs)), 0);
  const scale = maxRuns > 0 ? maxRuns : 1;
  const slot = plotWidth / days.length;
  const barWidth = Math.max(2, slot * 0.56);
  const runsLabel = String(options.runsLabel || 'runs');
  const errorsLabel = String(options.errorsLabel || 'errors');
  const parts = [
    `<svg class="harness-health-spark-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" focusable="false" aria-label="${escapeHtml(options.ariaLabel || '')}">`,
  ];
  days.forEach((day, index) => {
    const runs = nonNegative(day?.runs);
    const errors = nonNegative(day?.errors);
    const x = padX + index * slot + (slot - barWidth) / 2;
    const title = `${String(day?.day || '')}: ${runsLabel} ${runs}, ${errorsLabel} ${errors}`;
    parts.push(`<g><title>${escapeHtml(title)}</title>`);
    if (runs > 0) {
      const runHeight = Math.max(1, (runs / scale) * plotHeight);
      const y = padTop + plotHeight - runHeight;
      parts.push(
        `<rect class="harness-health-spark-runs" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${runHeight.toFixed(1)}" rx="1.5" />`
      );
    }
    if (errors > 0) {
      const errorHeight = Math.max(1, (errors / scale) * plotHeight);
      const y = padTop + plotHeight - errorHeight;
      parts.push(
        `<rect class="harness-health-spark-errors" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${errorHeight.toFixed(1)}" rx="1.5" />`
      );
    }
    parts.push('</g>');
  });
  parts.push('</svg>');
  return parts.join('');
}

/**
 * Table fallback for the sparkline, collapsed inside <details>.
 *
 * @param {Array<{ day?: string, runs?: number, errors?: number }>} daily
 * @param {{ caption?: string, day?: string, runs?: string, errors?: string }} [labels]
 * @returns {string}
 */
export function renderDailyTableHtml(daily, labels = {}) {
  const days = Array.isArray(daily) ? daily : [];
  if (days.length === 0) return '';
  const caption = String(labels.caption || '');
  const dayLabel = String(labels.day || 'day');
  const runsLabel = String(labels.runs || 'runs');
  const errorsLabel = String(labels.errors || 'errors');
  const rows = days
    .map((row) => `<tr><th scope="row">${escapeHtml(row?.day || '')}</th><td>${nonNegative(row?.runs)}</td><td>${nonNegative(row?.errors)}</td></tr>`)
    .join('');
  return (
    '<details class="harness-health-daily">'
    + `<summary>${escapeHtml(runsLabel)} / ${escapeHtml(errorsLabel)}</summary>`
    + '<table class="harness-health-daily-table">'
    + `<caption>${escapeHtml(caption)}</caption>`
    + `<thead><tr><th scope="col">${escapeHtml(dayLabel)}</th><th scope="col">${escapeHtml(runsLabel)}</th><th scope="col">${escapeHtml(errorsLabel)}</th></tr></thead>`
    + `<tbody>${rows}</tbody>`
    + '</table>'
    + '</details>'
  );
}

/**
 * @param {string} label
 * @param {string} value
 * @param {boolean} [warn]
 * @returns {string}
 */
function metricHtml(label, value, warn = false) {
  return `<div class="harness-health-metric${warn ? ' is-warn' : ''}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

/**
 * @param {object} limit normalized plan-limit row
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
function planLimitHtml(limit, t) {
  const parts = ['<div class="harness-health-plan-row">'];
  parts.push('<div class="harness-health-plan-head">');
  parts.push(`<span class="harness-health-plan-type">${escapeHtml(limit.rateLimitType || '—')}</span>`);
  if (limit.status) {
    parts.push(`<span class="harness-health-plan-status">${escapeHtml(limit.status)}</span>`);
  }
  parts.push('</div>');
  if (limit.utilizationPercent != null) {
    parts.push(
      `<div class="harness-health-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${limit.utilizationPercent}" aria-label="${escapeHtml(t('harnessHealth.planLimitUsageAria', { percent: limit.utilizationText }))}">`
      + `<span class="harness-health-bar-fill" style="width:${limit.utilizationPercent}%"></span>`
      + '</div>'
      + `<span class="harness-health-bar-value">${escapeHtml(limit.utilizationText)}</span>`
    );
  }
  const meta = [];
  if (limit.resetTime) meta.push(escapeHtml(t('harnessHealth.planLimitReset', { time: limit.resetTime })));
  else meta.push(escapeHtml(t('harnessHealth.planLimitNoReset')));
  if (limit.stale) {
    meta.push(limit.staleHours == null
      ? escapeHtml(t('harnessHealth.planLimitStaleShort'))
      : escapeHtml(t('harnessHealth.planLimitStale', { hours: limit.staleHours })));
  }
  parts.push(`<div class="harness-health-plan-meta">${meta.join(' · ')}</div>`);
  parts.push('</div>');
  return parts.join('');
}

/**
 * Renders the inner HTML of one health card body. All dynamic text goes through
 * `escapeHtml`; interactive controls use `data-action` for delegation.
 *
 * @param {ReturnType<typeof buildHealthCardModel>} model
 * @param {{ t?: (key: string, vars?: object) => string, lang?: string, harnessLabel?: string }} [ctx]
 * @returns {string}
 */
export function renderHealthCardHtml(model, ctx = {}) {
  const t = typeof ctx.t === 'function' ? ctx.t : (key) => key;
  const lang = ctx.lang === 'pl' ? 'pl' : 'en';
  const safe = model && typeof model === 'object' ? model : buildHealthCardModel(null, { lang });
  const parts = ['<div class="harness-health-body">'];

  const badgeClass = safe.status === 'ok' ? 'is-ok' : safe.status === 'limit' ? 'is-limit' : 'is-empty';
  const badgeText = safe.status === 'limit'
    ? t('harnessHealth.statusLimit', { time: safe.activeLimit?.resetTime || '' })
    : safe.status === 'ok'
      ? t('harnessHealth.statusOk')
      : t('harnessHealth.statusNoData');
  parts.push(
    '<div class="harness-health-head">'
    + `<span class="harness-health-badge ${badgeClass}">${escapeHtml(badgeText)}</span>`
    + `<button type="button" class="harness-health-refresh" data-action="refresh" aria-label="${escapeHtml(t('harnessHealth.refreshAria'))}">`
    + '<span class="mdi mdi-refresh" aria-hidden="true"></span>'
    + `<span>${escapeHtml(t('harnessHealth.refresh'))}</span>`
    + '</button>'
    + `<span class="harness-health-notice" data-role="notice" aria-live="polite"></span>`
    + '</div>'
  );

  if (safe.activeLimit) {
    const lock = safe.activeLimit;
    parts.push(`<div class="harness-health-lockout" role="group" aria-label="${escapeHtml(t('harnessHealth.activeLimitTitle'))}">`);
    parts.push('<div class="harness-health-lockout-text">');
    parts.push(`<span class="harness-health-lockout-title">${escapeHtml(t('harnessHealth.activeLimitTitle'))}</span>`);
    if (lock.model) parts.push(`<span>${escapeHtml(t('harnessHealth.activeLimitModel', { model: lock.model }))}</span>`);
    if (lock.code) parts.push(`<span>${escapeHtml(t('harnessHealth.activeLimitCode', { code: lock.code }))}</span>`);
    if (lock.resetTime) parts.push(`<span>${escapeHtml(t('harnessHealth.activeLimitReset', { time: lock.resetTime }))}</span>`);
    parts.push('</div>');
    parts.push(
      `<button type="button" class="harness-health-unlock" data-action="unlock" data-model="${escapeHtml(lock.model)}">${escapeHtml(t('harnessHealth.unlock'))}</button>`
    );
    parts.push('</div>');
  }

  if (safe.planLimits.length > 0) {
    parts.push(`<div class="harness-health-plan"><span class="harness-health-subtitle">${escapeHtml(t('harnessHealth.planLimitsTitle'))}</span>`);
    for (const limit of safe.planLimits) parts.push(planLimitHtml(limit, t));
    parts.push('</div>');
  }

  if (!safe.hasData) {
    parts.push(`<p class="harness-health-empty">${escapeHtml(t('harnessHealth.emptyRuns'))}</p>`);
  } else {
    const ariaLabel = t('harnessHealth.sparklineAria', { runs: safe.runs, errors: safe.errorRuns });
    parts.push('<div class="harness-health-spark">');
    parts.push(renderSparklineSvg(safe.daily, {
      ariaLabel,
      runsLabel: t('harnessHealth.sparklineLegendRuns'),
      errorsLabel: t('harnessHealth.sparklineLegendErrors'),
    }));
    parts.push(renderDailyTableHtml(safe.daily, {
      caption: t('harnessHealth.dailyTableCaption'),
      day: t('harnessHealth.dailyTableDay'),
      runs: t('harnessHealth.dailyTableRuns'),
      errors: t('harnessHealth.dailyTableErrors'),
    }));
    parts.push('</div>');

    parts.push('<dl class="harness-health-metrics">');
    parts.push(metricHtml(t('harnessHealth.metricRuns'), formatInteger(safe.runs, lang)));
    parts.push(metricHtml(t('harnessHealth.metricSuccess'), formatPercent(safe.successRate, lang)));
    parts.push(metricHtml(t('harnessHealth.metricP50'), safe.p50LatencyMs == null ? '—' : t('harnessHealth.milliseconds', { value: formatInteger(safe.p50LatencyMs, lang) })));
    parts.push(metricHtml(t('harnessHealth.metricP95'), safe.p95LatencyMs == null ? '—' : t('harnessHealth.milliseconds', { value: formatInteger(safe.p95LatencyMs, lang) })));
    parts.push(metricHtml(t('harnessHealth.metricLimitHits'), formatInteger(safe.limitHits, lang), safe.limitHits > 0));
    parts.push('</dl>');

    parts.push(`<div class="harness-health-errors"><span class="harness-health-subtitle">${escapeHtml(t('harnessHealth.lastErrorsTitle'))}</span>`);
    if (safe.lastErrors.length === 0) {
      parts.push(`<p class="harness-health-errors-empty">${escapeHtml(t('harnessHealth.lastErrorsEmpty'))}</p>`);
    } else {
      parts.push('<ul class="harness-health-errors-list">');
      for (const row of safe.lastErrors) {
        const code = row.errorCode || t('harnessHealth.unknownErrorCode');
        parts.push(
          `<li><time datetime="${escapeHtml(row.ts)}">${escapeHtml(row.time)}</time>`
          + `<code>${escapeHtml(code)}</code>`
          + (row.model ? `<span class="harness-health-error-model">${escapeHtml(row.model)}</span>` : '')
          + '</li>'
        );
      }
      parts.push('</ul>');
    }
    parts.push('</div>');
  }

  parts.push(`<a href="#" class="harness-health-details" data-action="details">${escapeHtml(t('harnessHealth.details'))}</a>`);
  parts.push('</div>');
  return parts.join('');
}
