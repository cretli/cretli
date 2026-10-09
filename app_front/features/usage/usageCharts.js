/**
 * Settings → Usage: pure helpers for formatting, chart building, sorting and CSV.
 *
 * Everything here is DOM-free so the unit tests can import it under Node.
 * The locale-aware labels come from the caller; only number/date formatting
 * uses the language code directly.
 */

import { formatUsd } from '../../../lib/usage/usage-rates.js';

export { formatUsd };

/** Metric ids accepted by the UI (a subset of the backend metric list). */
export const USAGE_METRICS = Object.freeze(['tokens', 'usd', 'runs']);
/** Grouping dimensions exposed by the switch. */
export const USAGE_GROUPS = Object.freeze(['harness', 'model']);
/** Sortable table columns. */
export const USAGE_SORT_KEYS = Object.freeze(['usd', 'tokens', 'runs', 'successRate', 'p95']);
/** Palette size defined by `.settings-usage-series-0..7` in app.scss. */
export const USAGE_SERIES_PALETTE_SIZE = 8;

/**
 * Harnesses whose runs are prepaid (subscription/plan), so a missing USD price
 * means "in subscription" rather than "no price". This mirrors
 * `billingMode: 'subscription'` on Claude plan login and the Cursor SDK plan.
 */
const SUBSCRIPTION_HARNESSES = Object.freeze(['sdk', 'claude']);

/**
 * @param {string} lang
 * @returns {string}
 */
function localeFor(lang) {
  return lang === 'pl' ? 'pl-PL' : 'en-US';
}

/**
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {object} [tokens]
 * @returns {number}
 */
export function sumTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(tokens)) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

/**
 * Compact token count: 1_600_000_000 -> "1,6 mld" (pl) / "1.6B" (en).
 *
 * @param {number} value
 * @param {string} [lang]
 * @returns {string}
 */
export function formatCompactNumber(value, lang = 'en') {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const units = lang === 'pl'
    ? [
        { threshold: 1e12, suffix: ' bln' },
        { threshold: 1e9, suffix: ' mld' },
        { threshold: 1e6, suffix: ' mln' },
        { threshold: 1e3, suffix: ' tys.' },
      ]
    : [
        { threshold: 1e12, suffix: 'T' },
        { threshold: 1e9, suffix: 'B' },
        { threshold: 1e6, suffix: 'M' },
        { threshold: 1e3, suffix: 'K' },
      ];
  const abs = Math.abs(num);
  for (const unit of units) {
    if (abs >= unit.threshold) {
      const scaled = num / unit.threshold;
      const digits = Math.abs(scaled) >= 100 ? 0 : 1;
      const formatted = new Intl.NumberFormat(localeFor(lang), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(scaled);
      return `${formatted}${unit.suffix}`;
    }
  }
  return new Intl.NumberFormat(localeFor(lang), { maximumFractionDigits: 0 }).format(num);
}

/**
 * @param {number} value
 * @param {string} [lang]
 * @returns {string}
 */
export function formatInteger(value, lang = 'en') {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat(localeFor(lang), { maximumFractionDigits: 0 }).format(num);
}

/**
 * @param {number|null|undefined} rate 0..1
 * @param {string} [lang]
 * @returns {string}
 */
export function formatPercent(rate, lang = 'en') {
  if (rate == null || rate === '') return '—';
  const num = Number(rate);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat(localeFor(lang), {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(num);
}

/**
 * Value shown on the chart axis / tooltip for the active metric.
 *
 * @param {number} value
 * @param {'usd'|'tokens'|'runs'|'events'} metric
 * @param {string} [lang]
 * @returns {string}
 */
export function formatChartValue(value, metric, lang = 'en') {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (metric === 'usd') return formatUsd(num);
  if (metric === 'tokens') return formatCompactNumber(num, lang);
  return formatInteger(num, lang);
}

/**
 * @param {string} bucket ISO day (`YYYY-MM-DD`) or hour (`YYYY-MM-DDTHH:...Z`)
 * @returns {string}
 */
export function formatBucketLabel(bucket) {
  const raw = String(bucket || '');
  if (raw.includes('T')) return raw.slice(11, 16);
  return raw.slice(5, 10);
}

/**
 * Normalizes a summary group row (byHarness/byModel) into a table row.
 *
 * @param {object} row
 * @param {{ key?: string, label?: string, harness?: string|null }} [meta]
 * @returns {object}
 */
export function normalizeUsageRow(row = {}, meta = {}) {
  const runs = Number(row.runs) || 0;
  const okRuns = Number(row.okRuns) || 0;
  const rawP95 = row.p95LatencyMs == null || row.p95LatencyMs === '' ? null : Number(row.p95LatencyMs);
  const rawUsd = row.usd == null || row.usd === '' ? null : Number(row.usd);
  return {
    key: String(meta.key ?? row.model ?? row.harness ?? 'unknown'),
    label: String(meta.label ?? row.model ?? row.harness ?? 'unknown'),
    harness: meta.harness != null ? String(meta.harness) : (row.harness ? String(row.harness) : null),
    usd: rawUsd != null && Number.isFinite(rawUsd) ? rawUsd : null,
    estimatedUsd: Number(row.estimatedUsd) || 0,
    unpricedEvents: Number(row.unpricedEvents) || 0,
    events: Number(row.events) || 0,
    runs,
    okRuns,
    errorRuns: Number(row.errorRuns) || 0,
    limitHits: Number(row.limitHits) || 0,
    totalTokens: Number.isFinite(Number(row.totalTokens)) ? Number(row.totalTokens) : sumTokens(row.tokens),
    successRate: runs > 0 ? okRuns / runs : null,
    p95LatencyMs: rawP95 != null && Number.isFinite(rawP95) && rawP95 >= 0 ? rawP95 : null,
  };
}

/**
 * @param {object} summary GET /api/usage/summary payload `summary`
 * @returns {object[]}
 */
export function harnessRowsFromSummary(summary) {
  const groups = summary?.byHarness && typeof summary.byHarness === 'object' ? summary.byHarness : {};
  return Object.entries(groups).map(([harness, row]) =>
    normalizeUsageRow(row, { key: harness, label: harness, harness })
  );
}

/**
 * @param {object[]} models `models` array from GET /api/usage/models
 * @returns {object[]}
 */
export function modelRowsFromPayload(models) {
  return (Array.isArray(models) ? models : []).map((row) =>
    normalizeUsageRow(row, { key: row?.model, label: row?.model, harness: null })
  );
}

/**
 * Why a row has no metered USD.
 *
 * @param {object} row
 * @returns {'subscription'|'unpriced'|null}
 */
export function unpricedReason(row) {
  const usd = Number(row?.usd);
  if (Number.isFinite(usd) && usd > 0) return null;
  if (Number(row?.unpricedEvents) > 0) {
    const harness = String(row?.harness || '').toLowerCase();
    return SUBSCRIPTION_HARNESSES.includes(harness) ? 'subscription' : 'unpriced';
  }
  return null;
}

/**
 * @param {object} row
 * @param {'usd'|'tokens'|'runs'|'successRate'|'p95'} key
 * @returns {number|null}
 */
export function usageSortValue(row, key) {
  if (key === 'usd') return row?.usd == null ? null : Number(row.usd);
  if (key === 'tokens') return Number(row?.totalTokens) || 0;
  if (key === 'runs') return Number(row?.runs) || 0;
  if (key === 'successRate') return row?.successRate == null ? null : Number(row.successRate);
  if (key === 'p95') return row?.p95LatencyMs == null ? null : Number(row.p95LatencyMs);
  return null;
}

/**
 * Stable sort with missing values last and a token/label tie-break.
 *
 * @param {object[]} rows
 * @param {'usd'|'tokens'|'runs'|'successRate'|'p95'} key
 * @param {'asc'|'desc'} [dir]
 * @returns {object[]}
 */
export function sortUsageRows(rows, key, dir = 'desc') {
  const list = Array.isArray(rows) ? [...rows] : [];
  if (!USAGE_SORT_KEYS.includes(key)) return list;
  const direction = dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const av = usageSortValue(a, key);
    const bv = usageSortValue(b, key);
    if (av == null && bv == null) return String(a.label).localeCompare(String(b.label));
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return av < bv ? -direction : direction;
    const at = Number(a.totalTokens) || 0;
    const bt = Number(b.totalTokens) || 0;
    if (at !== bt) return bt - at;
    return String(a.label).localeCompare(String(b.label));
  });
  return list;
}

/**
 * @param {number} value
 * @param {number} max
 * @returns {number} 0..100
 */
export function buildSharePercent(value, max) {
  const v = Number(value) || 0;
  const m = Number(max) || 0;
  if (m <= 0 || v <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((v / m) * 100)));
}

/**
 * Turns a timeseries payload into a stacked-bar model.
 *
 * Groups beyond `maxSeries` collapse into a single "other" slice so the legend
 * and palette stay readable.
 *
 * @param {{ buckets?: string[], series?: Array<{ group: string, values: number[] }> }} timeseries
 * @param {{ otherLabel?: string, maxSeries?: number, labelFor?: (group: string) => string }} [options]
 * @returns {{ buckets: string[], series: Array<{ group: string, label: string, values: number[], total: number, colorIndex: number }>, bucketTotals: number[], max: number }}
 */
export function buildChartModel(timeseries, options = {}) {
  const buckets = Array.isArray(timeseries?.buckets) ? timeseries.buckets.map(String) : [];
  const input = Array.isArray(timeseries?.series) ? timeseries.series : [];
  const otherLabel = String(options.otherLabel || 'other');
  const labelFor = typeof options.labelFor === 'function' ? options.labelFor : (group) => group;
  const maxSeries = Number.isFinite(Number(options.maxSeries))
    ? Math.max(1, Number(options.maxSeries))
    : USAGE_SERIES_PALETTE_SIZE;
  const normalized = input.map((entry) => {
    const group = String(entry?.group ?? 'unknown');
    const values = buckets.map((_, index) => {
      const raw = Number(entry?.values?.[index]);
      return Number.isFinite(raw) && raw > 0 ? raw : 0;
    });
    const total = values.reduce((sum, value) => sum + value, 0);
    return { group, label: String(labelFor(group)), values, total };
  });
  const ranked = normalized.sort((a, b) => b.total - a.total || a.group.localeCompare(b.group));
  let visible = ranked;
  if (ranked.length > maxSeries) {
    const kept = ranked.slice(0, maxSeries - 1);
    const rest = ranked.slice(maxSeries - 1);
    const values = buckets.map((_, index) => rest.reduce((sum, entry) => sum + entry.values[index], 0));
    kept.push({ group: otherLabel, label: otherLabel, values, total: values.reduce((sum, value) => sum + value, 0) });
    visible = kept;
  }
  const series = visible.map((entry, index) => ({
    group: entry.group,
    label: entry.label,
    values: entry.values,
    total: entry.total,
    colorIndex: index % USAGE_SERIES_PALETTE_SIZE,
  }));
  const bucketTotals = buckets.map((_, index) => series.reduce((sum, entry) => sum + entry.values[index], 0));
  const max = bucketTotals.reduce((peak, value) => Math.max(peak, value), 0);
  return { buckets, series, bucketTotals, max };
}

/**
 * SVG stacked bar chart (no external dependency).
 *
 * @param {ReturnType<typeof buildChartModel>} model
 * @param {{ lang?: string, metric?: string, formatValue?: (value: number) => string, formatBucket?: (bucket: string) => string, minWidth?: number }} [options]
 * @returns {string} SVG markup, or '' when there is nothing to draw
 */
export function renderStackedBarSvg(model, options = {}) {
  if (!model || !Array.isArray(model.buckets) || model.buckets.length === 0) return '';
  if (!(Number(model.max) > 0)) return '';
  const metric = options.metric || 'tokens';
  const lang = options.lang || 'en';
  const formatValue = typeof options.formatValue === 'function'
    ? options.formatValue
    : (value) => formatChartValue(value, metric, lang);
  const formatBucket = typeof options.formatBucket === 'function'
    ? options.formatBucket
    : formatBucketLabel;
  const chartHeight = 200;
  const top = 12;
  const bottom = 30;
  // Left gutter holds the Y-axis value labels; without it the zero baseline
  // and the peak are invisible on the chart.
  const left = 56;
  const right = 8;
  const plotHeight = chartHeight - top - bottom;
  const barWidth = 26;
  const gap = 14;
  const slot = barWidth + gap;
  const minWidth = Number.isFinite(Number(options.minWidth)) ? Number(options.minWidth) : 320;
  const svgWidth = Math.max(minWidth, left + model.buckets.length * slot + right);
  const parts = [];
  parts.push(
    `<svg class="settings-usage-svg" viewBox="0 0 ${svgWidth} ${chartHeight}" width="${svgWidth}" height="${chartHeight}" preserveAspectRatio="xMinYMin meet" focusable="false" aria-hidden="true">`
  );
  for (let line = 0; line <= 4; line += 1) {
    const y = top + (plotHeight / 4) * line;
    parts.push(`<line class="settings-usage-grid" x1="${left}" y1="${y.toFixed(1)}" x2="${svgWidth - right}" y2="${y.toFixed(1)}" />`);
  }
  // 0, ½ max and max keep the scale readable without crowding the plot.
  const yTicks = [
    { value: 0, y: top + plotHeight },
    { value: model.max / 2, y: top + plotHeight / 2 },
    { value: model.max, y: top },
  ];
  for (const tick of yTicks) {
    parts.push(
      `<text class="settings-usage-axis-label settings-usage-axis-label-y" x="${left - 6}" y="${(tick.y + 3).toFixed(1)}" text-anchor="end">${escapeHtml(formatValue(tick.value))}</text>`
    );
  }
  const labelStep = Math.max(1, Math.ceil(model.buckets.length / 12));
  model.buckets.forEach((bucket, bucketIndex) => {
    const x = left + bucketIndex * slot + gap / 2;
    let cursor = top + plotHeight;
    for (const entry of model.series) {
      const value = entry.values[bucketIndex] || 0;
      if (value <= 0) continue;
      const height = (value / model.max) * plotHeight;
      const y = cursor - height;
      const title = `${entry.label}: ${formatValue(value)}`;
      parts.push(
        `<rect class="settings-usage-bar settings-usage-series-${entry.colorIndex}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth}" height="${Math.max(1, height).toFixed(1)}" rx="2"><title>${escapeHtml(title)}</title></rect>`
      );
      cursor = y;
    }
    if (bucketIndex % labelStep === 0) {
      const label = formatBucket(bucket);
      parts.push(
        `<text class="settings-usage-axis-label" x="${(x + barWidth / 2).toFixed(1)}" y="${chartHeight - 10}" text-anchor="middle">${escapeHtml(label)}</text>`
      );
    }
  });
  parts.push('</svg>');
  return parts.join('');
}

/**
 * CSV (comma separated, CRLF, RFC 4180 quoting).
 *
 * Cells that a spreadsheet would treat as a formula (`=`, `+`, `-`, `@`, tab
 * or CR first) get a leading apostrophe, so exported model/harness names cannot
 * execute as formulas.
 *
 * @param {Array<unknown>} header
 * @param {Array<Array<unknown>>} rows
 * @returns {string}
 */
export function buildCsv(header, rows) {
  const escapeCell = (value) => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [Array.isArray(header) ? header : [], ...(Array.isArray(rows) ? rows : [])];
  return lines
    .map((line) => (Array.isArray(line) ? line : [line]).map(escapeCell).join(','))
    .join('\r\n');
}

/**
 * Sums summary `byDay` rows inside an inclusive ISO-day window.
 *
 * @param {Record<string, object>} byDay
 * @param {string} fromKey
 * @param {string} toKey
 * @returns {{ usd: number, estimatedUsd: number, unpricedEvents: number, tokens: number, runs: number, okRuns: number, successRate: number|null }}
 */
export function sumDayWindow(byDay, fromKey, toKey) {
  const days = byDay && typeof byDay === 'object' ? byDay : {};
  let usd = 0;
  let estimatedUsd = 0;
  let unpricedEvents = 0;
  let tokens = 0;
  let runs = 0;
  let okRuns = 0;
  for (const [day, row] of Object.entries(days)) {
    if (day < fromKey || day > toKey) continue;
    usd += Number(row?.usd) || 0;
    estimatedUsd += Number(row?.estimatedUsd) || 0;
    unpricedEvents += Number(row?.unpricedEvents) || 0;
    tokens += sumTokens(row?.tokens);
    runs += Number(row?.runs) || 0;
    okRuns += Number(row?.okRuns) || 0;
  }
  return {
    usd,
    estimatedUsd,
    unpricedEvents,
    tokens,
    runs,
    okRuns,
    successRate: runs > 0 ? okRuns / runs : null,
  };
}

/**
 * @param {unknown} iso
 * @param {number} deltaDays
 * @returns {string}
 */
export function addDaysIso(iso, deltaDays) {
  const day = String(iso || '').slice(0, 10);
  const base = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return day;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

/**
 * Disjoint token buckets with their i18n label keys, in additive order. Cache
 * read is a label of its own: it is context, not newly generated text.
 */
export const TOKEN_BUCKET_FIELDS = Object.freeze([
  Object.freeze({ key: 'inputWithoutCache', labelKey: 'usage.bucketInput' }),
  Object.freeze({ key: 'cacheRead', labelKey: 'usage.bucketCacheRead' }),
  Object.freeze({ key: 'cacheWrite', labelKey: 'usage.bucketCacheWrite' }),
  Object.freeze({ key: 'outputWithoutReasoning', labelKey: 'usage.bucketOutput' }),
  Object.freeze({ key: 'reasoning', labelKey: 'usage.bucketReasoning' }),
  Object.freeze({ key: 'audioInput', labelKey: 'usage.bucketAudioInput' }),
  Object.freeze({ key: 'audioOutput', labelKey: 'usage.bucketAudioOutput' }),
]);

/**
 * @param {unknown} value
 * @returns {number}
 */
function nonNegative(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Percentage of a cohort total (0..100). Returns `null` when there is no total,
 * so a missing denominator never becomes a confident 0%.
 *
 * @param {number} value
 * @param {number} total
 * @returns {number|null}
 */
export function buildShareOfTotalPercent(value, total) {
  const v = nonNegative(value);
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Number(((v / t) * 100).toFixed(2));
}

/**
 * Rows for the disjoint token breakdown. `share_ratio` sums to 1 across the
 * returned rows and is always relative to the disjoint total, so a caller can
 * never see shares that disagree with the API total.
 *
 * Diagnostic reasoning (`reasoningRelation === 'unknown'`, e.g. qwen) is
 * already inside output. It is returned in `diagnosticRows` and never added to
 * `totalTokens` or to a row share; a producer that leaked it into `reasoning`
 * cannot inflate the total.
 *
 * @param {object} [buckets] `summary.buckets` / `insights.tokens`
 * @returns {{ rows: object[], diagnosticRows: object[], totalTokens: number, cacheTokens: number, reasoningDiagnosticTokens: number }}
 */
export function tokenBucketRows(buckets = {}) {
  const diagnosticTokens = nonNegative(buckets?.reasoningDiagnosticTokens);
  const rawReasoning = nonNegative(buckets?.reasoning);
  const otherFields = TOKEN_BUCKET_FIELDS
    .filter((field) => field.key !== 'reasoning')
    .reduce((sum, field) => sum + nonNegative(buckets?.[field.key]), 0);
  // The API's disjoint total is authoritative. Without it, derive the total
  // from the additive fields and never add diagnostic reasoning again.
  const explicitTotal = Number(buckets?.totalTokens);
  const totalTokens = Number.isFinite(explicitTotal) && explicitTotal >= 0
    ? explicitTotal
    : (diagnosticTokens > 0 ? otherFields : otherFields + rawReasoning);
  const reasoningAdditive = Math.max(0, totalTokens - otherFields);
  const rows = TOKEN_BUCKET_FIELDS.map((field) => ({
    key: field.key,
    labelKey: field.labelKey,
    value: field.key === 'reasoning' ? reasoningAdditive : nonNegative(buckets?.[field.key]),
  }));
  const diagnosticRows = diagnosticTokens > 0
    ? [{ key: 'reasoningDiagnostic', labelKey: 'usage.bucketReasoningDiagnostic', value: diagnosticTokens }]
    : [];
  return {
    rows: rows.map((row) => ({
      ...row,
      share_ratio: totalTokens > 0 ? Number((row.value / totalTokens).toFixed(6)) : null,
      share_percent: buildShareOfTotalPercent(row.value, totalTokens),
    })),
    diagnosticRows,
    totalTokens,
    cacheTokens: nonNegative(buckets?.cacheRead) + nonNegative(buckets?.cacheWrite),
    // Reasoning already inside output when its relation is unknown.
    reasoningDiagnosticTokens: diagnosticTokens,
  };
}

/**
 * The two coverage ratios, each with its explicit denominator and n.
 *
 * @param {object} [coverage]
 * @returns {object[]}
 */
export function coverageViewRows(coverage = {}) {
  const row = (key, labelKey) => {
    const entry = coverage?.[key] || {};
    const denominator = entry.denominator == null ? null : Number(entry.denominator);
    return {
      key,
      labelKey,
      n: entry.n == null ? null : Number(entry.n),
      denominator,
      ratio: entry.ratio == null ? null : Number(entry.ratio),
    };
  };
  return [
    row('endedWithUsage', 'usage.coverageEndedWithUsage'),
    row('endedComplete', 'usage.coverageEndedComplete'),
  ];
}

/**
 * Completeness/lifecycle counts shown separately from the ratios.
 *
 * @param {object} [coverage]
 * @returns {object[]}
 */
export function coverageBreakdownRows(coverage = {}) {
  const by = coverage?.byCompleteness && typeof coverage.byCompleteness === 'object' ? coverage.byCompleteness : {};
  const rows = ['complete', 'partial', 'missing', 'unsupported', 'unknown'].map((key) => ({
    key,
    labelKey: `usage.coverage_${key}`,
    n: Number(by[key]) || 0,
  }));
  rows.push({ key: 'active', labelKey: 'usage.coverage_active', n: Number(coverage?.runs?.active) || 0 });
  rows.push({ key: 'legacy', labelKey: 'usage.coverage_legacy', n: Number(coverage?.legacy?.inferredWithoutRunStart) || 0 });
  rows.push({ key: 'estimated', labelKey: 'usage.coverage_estimated', n: Number(coverage?.estimated?.runs) || 0 });
  rows.push({ key: 'reportedZero', labelKey: 'usage.coverage_reportedZero', n: Number(coverage?.reportedZero?.runs) || 0 });
  return rows;
}

/** Origin detail -> product-language label key. */
export const ORIGIN_DETAIL_LABEL_KEYS = Object.freeze({
  selected: 'usage.originSelected',
  alternate: 'usage.originAlternate',
  fanout: 'usage.originFanout',
  fallback: 'usage.originFallback',
  explore: 'usage.originExplore',
  none: 'usage.originUnknown',
});

/** Link status -> label key; legacy/none are the "unknown link" states. */
export const LINK_STATUS_LABEL_KEYS = Object.freeze({
  linked: 'usage.linkLinked',
  'rejected-link': 'usage.linkRejected',
  legacy: 'usage.linkLegacy',
  none: 'usage.linkNone',
});

/**
 * Executed automatic choices. Proposals and diagnostic picks are returned
 * beside `executed`, never added to it.
 *
 * @param {object} [choices]
 * @returns {object}
 */
export function choicesView(choices = {}) {
  const executed = Number(choices?.executed) || 0;
  const originRows = ['auto', 'manual', 'unknown'].map((key) => {
    const value = Number(choices?.[key]) || 0;
    return {
      key,
      labelKey: `usage.choices_${key}`,
      value,
      share_percent: buildShareOfTotalPercent(value, executed),
    };
  });
  const originDetails = Object.entries(choices?.originDetails && typeof choices.originDetails === 'object' ? choices.originDetails : {})
    .map(([key, value]) => ({
      key,
      labelKey: ORIGIN_DETAIL_LABEL_KEYS[key] || '',
      value: Number(value) || 0,
    }))
    .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));
  const linkStatuses = Object.entries(choices?.linkStatuses && typeof choices.linkStatuses === 'object' ? choices.linkStatuses : {})
    .map(([key, value]) => ({
      key,
      labelKey: LINK_STATUS_LABEL_KEYS[key] || '',
      value: Number(value) || 0,
    }))
    .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));
  return {
    executed,
    auto: Number(choices?.auto) || 0,
    manual: Number(choices?.manual) || 0,
    unknown: Number(choices?.unknown) || 0,
    proposals: choices?.proposals == null ? null : Number(choices.proposals),
    diagnosticPicks: choices?.diagnosticPicks == null ? null : Number(choices.diagnosticPicks),
    originRows,
    originDetails,
    linkStatuses,
    groups: Array.isArray(choices?.groups) ? choices.groups : [],
  };
}

/**
 * Model rows for the executed-choices table, richest first.
 *
 * @param {object[]} groups
 * @returns {object[]}
 */
export function choiceGroupRows(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    key: String(group?.key || ''),
    harness: String(group?.harness || ''),
    model: String(group?.model || ''),
    executed: Number(group?.executed) || 0,
    auto: Number(group?.auto) || 0,
    manual: Number(group?.manual) || 0,
    unknown: Number(group?.unknown) || 0,
    originDetails: group?.originDetails && typeof group.originDetails === 'object' ? group.originDetails : {},
    linkStatuses: group?.linkStatuses && typeof group.linkStatuses === 'object' ? group.linkStatuses : {},
    technicalSuccess: Number(group?.technicalSuccess) || 0,
    technicalOutcomeKnown: Number(group?.technicalOutcomeKnown) || 0,
    technicalSuccessRate: group?.technicalSuccessRate == null ? null : Number(group.technicalSuccessRate),
  }));
}

/**
 * Separation/acceptance signals with explicit denominators. Nothing here is a
 * single blended "quality" number.
 *
 * @param {object} [signals]
 * @returns {object[]}
 */
export function signalRows(signals = {}) {
  const pct = (entry) => (entry?.denominator > 0 && entry?.n != null ? entry.n / entry.denominator : null);
  return [
    { key: 'technicalSuccess', labelKey: 'usage.signalTechnical', n: Number(signals?.technicalSuccess?.n) || 0, denominator: Number(signals?.technicalSuccess?.denominator) || 0, ratio: pct(signals?.technicalSuccess) },
    { key: 'acceptedByReview', labelKey: 'usage.signalAccepted', n: Number(signals?.acceptedByReview?.n) || 0, denominator: Number(signals?.acceptedByReview?.denominator) || 0, ratio: pct(signals?.acceptedByReview) },
    { key: 'manualAccepted', labelKey: 'usage.signalManualAccepted', n: Number(signals?.manualAccepted?.n) || 0, denominator: Number(signals?.manualAccepted?.denominator) || 0, ratio: pct(signals?.manualAccepted) },
    { key: 'rejectedByReview', labelKey: 'usage.signalRejected', n: Number(signals?.rejectedByReview?.n) || 0, denominator: Number(signals?.rejectedByReview?.denominator) || 0, ratio: pct(signals?.rejectedByReview) },
  ];
}

/**
 * Cost provenance rows. `partial` is repeated so the UI can mark the total.
 *
 * @param {object} [cost]
 * @returns {object}
 */
export function costProvenanceView(cost = {}) {
  return {
    actualUsd: Number(cost?.actualUsd) || 0,
    estimatedUsd: Number(cost?.estimatedUsd) || 0,
    subscriptionEvents: Number(cost?.subscriptionEvents) || 0,
    unpricedEvents: Number(cost?.unpricedEvents) || 0,
    pricedEvents: Number(cost?.pricedEvents) || 0,
    totalEvents: Number(cost?.totalEvents) || 0,
    partial: cost?.partial === true,
  };
}

/**
 * Leading metadata rows for the CSV export: scope, range, zone, filters,
 * coverage and versions travel with the numbers.
 *
 * @param {{ window?: object, filters?: object, coverage?: object, version?: object }} [input]
 * @returns {Array<[string, string]>}
 */
export function exportMetaRows(input = {}) {
  const window = input.window || {};
  const filters = input.filters || {};
  const coverage = input.coverage || {};
  const version = input.version || {};
  const ratio = (entry) => (entry && entry.denominator != null
    ? `${entry.n ?? ''}/${entry.denominator}`
    : '');
  return [
    ['scope', String(filters.scope || 'own')],
    ['tz', String(window.tz || '')],
    ['range', String(window.range || '')],
    ['from', String(window.from || '')],
    ['to', String(window.to || '')],
    ['role', String(filters.role || '')],
    ['harness', String(filters.harness || '')],
    ['origin', String(filters.origin || '')],
    ['workspace', String(filters.workspaceFile || '')],
    ['subject', String(filters.subject || '')],
    ['coverage_ended_with_usage', ratio(coverage.endedWithUsage)],
    ['coverage_ended_complete', ratio(coverage.endedComplete)],
    ['schema_version', String(version.schemaVersion ?? '')],
    ['normalization_version', String(version.normalizationVersion ?? '')],
    ['contract_revision', String(version.contractRevision ?? '')],
  ];
}
