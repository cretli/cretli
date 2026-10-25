/**
 * Pure view model + HTML for the "Unrecognized errors", "Tool compatibility" and
 * "Telemetry coverage" sections of a harness health card.
 *
 * Input is the `unclassifiedErrors` / `telemetryCoverage` slice of
 * `GET /api/harnesses/health`. The server already redacts messages; the renderer
 * redacts again (defence in depth) and escapes everything it prints. "Tool not
 * found" entries are a compatibility category: never shown as a model fault.
 */

import { escapeHtml, formatInteger, formatPercent } from '../usage/usageCharts.js';

export const UNCLASSIFIED_MAX_ROWS = 20;

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`,)\]]+/gi;
const HOME_PATH_RE = /(?:~|\/(?:home|Users|root))\/[^\s"'`,)\]]*/g;
const SECRET_RE = /\b(?:sk|pk|ghp|gho|xox[a-z]|AKIA)[-_A-Za-z0-9]{12,}|\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+|\bbearer\s+[A-Za-z0-9._~+/-]+/gi;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function redactForRender(value) {
  return String(value ?? '')
    .replace(URL_RE, '<url>')
    .replace(SECRET_RE, '<secret>')
    .replace(HOME_PATH_RE, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function dateText(iso) {
  const text = String(iso || '').trim();
  return text ? text.slice(0, 16).replace('T', ' ') : '';
}

function normalizeItem(row) {
  const id = String(row?.id || '');
  return {
    id: /^[0-9a-f]{16}$/.test(id) ? id : '',
    model: redactForRender(row?.model).slice(0, 80),
    message: redactForRender(row?.message),
    count: Math.max(1, count(row?.count)),
    version: Math.max(1, count(row?.version) || count(row?.count)),
    firstSeenAt: dateText(row?.firstSeenAt),
    lastSeenAt: dateText(row?.lastSeenAt),
  };
}

/**
 * @param {unknown} unclassified server `unclassifiedErrors` slice
 * @param {unknown} coverage server `telemetryCoverage` slice
 */
export function buildUnclassifiedSectionsModel(unclassified, coverage) {
  const src = /** @type {Record<string, any>} */ (unclassified && typeof unclassified === 'object' ? unclassified : {});
  const cov = /** @type {Record<string, any> | null} */ (coverage && typeof coverage === 'object' ? coverage : null);
  const items = (Array.isArray(src.items) ? src.items : []).slice(0, UNCLASSIFIED_MAX_ROWS).map(normalizeItem);
  const compat = (Array.isArray(src.compat) ? src.compat : []).slice(0, UNCLASSIFIED_MAX_ROWS).map(normalizeItem);
  const cats = (Array.isArray(cov?.categories) ? cov.categories : []).map((c) => ({
    category: String(c?.category || 'unknown').replace(/[^a-z_]/gi, '').slice(0, 24) || 'unknown',
    total: count(c?.total),
    timingUnknownShare: Number.isFinite(Number(c?.timingUnknownShare)) && c?.timingUnknownShare != null ? Number(c.timingUnknownShare) : null,
    measurementUnknownShare: Number.isFinite(Number(c?.measurementUnknownShare)) && c?.measurementUnknownShare != null ? Number(c.measurementUnknownShare) : null,
    alarm: c?.alarm === true,
    severity: c?.severity === 'high' ? 'high' : (c?.alarm === true ? 'low' : 'none'),
  }));
  return { items, compat, coverage: cats, coverageAlarm: cats.some((c) => c.alarm) };
}

function itemRowsHtml(items, t, lang, withAck) {
  const rows = items.map((row) => {
    const meta = [
      row.model ? escapeHtml(row.model) : '',
      escapeHtml(t('harnessHealth.unclassifiedCount', { count: formatInteger(row.count, lang) })),
      row.lastSeenAt ? escapeHtml(t('harnessHealth.unclassifiedLastSeen', { time: row.lastSeenAt })) : '',
    ].filter(Boolean).join(' · ');
    const ack = withAck && row.id
      ? `<cr-bar-button class="harness-health-unclassified-ack" data-action="ack-unclassified" data-id="${escapeHtml(row.id)}" data-version="${row.version}">${escapeHtml(t('harnessHealth.unclassifiedAck'))}</cr-bar-button>`
      : '';
    return `<li class="harness-health-unclassified-item"><div class="harness-health-unclassified-text"><code>${escapeHtml(row.message)}</code><span class="harness-health-unclassified-meta">${meta}</span></div>${ack}</li>`;
  });
  return `<ul class="harness-health-unclassified-list">${rows.join('')}</ul>`;
}

/**
 * @param {ReturnType<typeof buildUnclassifiedSectionsModel>} model
 * @param {{ t?: (key: string, vars?: object) => string, lang?: string }} [ctx]
 * @returns {string} empty string when there is nothing to show
 */
export function renderUnclassifiedSectionsHtml(model, ctx = {}) {
  const t = typeof ctx.t === 'function' ? ctx.t : (key) => key;
  const lang = ctx.lang === 'pl' ? 'pl' : 'en';
  const safe = model || buildUnclassifiedSectionsModel(null, null);
  const parts = [];
  if (safe.items.length > 0) {
    parts.push(
      '<div class="harness-health-unclassified" data-role="unclassified">'
      + `<span class="harness-health-subtitle">${escapeHtml(t('harnessHealth.unclassifiedTitle'))}</span>`
      + `<p class="cr-hint">${escapeHtml(t('harnessHealth.unclassifiedHint'))}</p>`
      + itemRowsHtml(safe.items, t, lang, true)
      + '</div>',
    );
  }
  if (safe.compat.length > 0) {
    parts.push(
      '<div class="harness-health-unclassified is-compat" data-role="tool-compat">'
      + `<span class="harness-health-subtitle">${escapeHtml(t('harnessHealth.toolCompatTitle'))}</span>`
      + `<p class="cr-hint">${escapeHtml(t('harnessHealth.toolCompatHint'))}</p>`
      + itemRowsHtml(safe.compat, t, lang, true)
      + '</div>',
    );
  }
  if (safe.coverage.length > 0) {
    const rows = safe.coverage.map((c) => {
      const label = t(`harnessHealth.coverageCategory_${c.category}`) || c.category;
      const cell = (share) => escapeHtml(share == null ? '—' : formatPercent(share, lang));
      const badge = c.alarm
        ? `<span class="harness-health-coverage-alarm is-${c.severity}" role="status">${escapeHtml(t('harnessHealth.coverageAlarm'))}</span>`
        : '';
      return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(formatInteger(c.total, lang))}</td><td>${cell(c.timingUnknownShare)}</td><td>${cell(c.measurementUnknownShare)}</td><td>${badge}</td></tr>`;
    });
    parts.push(
      `<div class="harness-health-coverage" data-role="telemetry-coverage"><span class="harness-health-subtitle">${escapeHtml(t('harnessHealth.coverageTitle'))}</span>`
      + `<p class="cr-hint">${escapeHtml(t('harnessHealth.coverageHint'))}</p>`
      + '<table class="harness-health-coverage-table"><thead><tr>'
      + `<th scope="col">${escapeHtml(t('harnessHealth.coverageColCategory'))}</th>`
      + `<th scope="col">${escapeHtml(t('harnessHealth.coverageColRuns'))}</th>`
      + `<th scope="col">${escapeHtml(t('harnessHealth.coverageColTiming'))}</th>`
      + `<th scope="col">${escapeHtml(t('harnessHealth.coverageColMeasurement'))}</th>`
      + '<th scope="col"></th></tr></thead><tbody>'
      + rows.join('')
      + '</tbody></table></div>',
    );
  }
  return parts.join('');
}
