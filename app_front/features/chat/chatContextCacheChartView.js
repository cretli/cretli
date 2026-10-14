import { escapeHtml } from './chatHtmlUtils.js';
import { formatContextTokenCount } from '../../../lib/sdk/sdk-context-advisory.js';

const WIDTH = 320;
const HEIGHT = 120;
const PAD = 6;
const MAX_POINTS = 120;

function linePath(points, key, min, max) {
  const step = points.length > 1 ? (WIDTH - PAD * 2) / (points.length - 1) : 0;
  let path = '';
  points.forEach((point, index) => {
    const value = point[key];
    if (typeof value !== 'number') return;
    const x = PAD + index * step;
    const y = HEIGHT - PAD - ((value - min) / Math.max(1, max - min)) * (HEIGHT - PAD * 2);
    path += `${path ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return path;
}

function formatGap(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`;
}

/**
 * Chart of context size and cache reads over the calls of one chat, with the
 * detected cache breaks listed below. Harness-agnostic: it only needs the shared series.
 * @param {{ points: object[], breaks: object[] }|null} series
 * @param {(key: string, params?: object) => string} t
 * @param {string} [lang]
 */
export function renderChatContextCacheChartHtml(series, t, lang = 'en') {
  const heading = `<h3>${escapeHtml(t('chat.contextSeriesTitle'))}</h3>`;
  if (!series || !Array.isArray(series.points) || series.points.length < 2) {
    return series ? heading + `<p class="settings-hint">${escapeHtml(t('chat.contextSeriesEmpty'))}</p>` : '';
  }
  const offset = Math.max(0, series.points.length - MAX_POINTS);
  const points = series.points.slice(offset);
  const breaks = series.breaks.filter((entry) => entry.index >= offset).map((entry) => ({ ...entry, index: entry.index - offset }));
  // Scale to the observed range, not the window, so growth and drops stay visible.
  const values = points.flatMap((point) => [point.totalTokens, point.cacheReadTokens]).filter((value) => typeof value === 'number');
  const max = Math.max(1, ...values);
  const min = Math.max(0, Math.min(...values) * 0.9);
  const step = (WIDTH - PAD * 2) / (points.length - 1);
  const markers = breaks.map((entry) => {
    const x = (PAD + entry.index * step).toFixed(1);
    return `<line class="chat-context-series-break" x1="${x}" x2="${x}" y1="${PAD}" y2="${HEIGHT - PAD}"></line>`;
  }).join('');
  const svg = `<svg class="chat-context-series" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeHtml(t('chat.contextSeriesTitle'))}">`
    + `<path class="chat-context-series-context" d="${linePath(points, 'totalTokens', min, max)}"></path>`
    + `<path class="chat-context-series-cache" d="${linePath(points, 'cacheReadTokens', min, max)}"></path>${markers}</svg>`;
  const range = `<p class="settings-hint">${escapeHtml(t('chat.contextSeriesRange', { min: formatContextTokenCount(min), max: formatContextTokenCount(max), count: points.length }))}</p>`;
  const legend = `<p class="chat-context-breakdown-note"><span class="chat-context-series-key chat-context-series-context-key"></span>${escapeHtml(t('chat.contextSeriesContext'))} `
    + `<span class="chat-context-series-key chat-context-series-cache-key"></span>${escapeHtml(t('chat.contextSeriesCache'))}</p>`;
  const rows = series.breaks.map((entry) => {
    const when = new Date(entry.observedAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'medium' });
    const cause = t(`chat.contextBreakCause_${entry.cause}`);
    const detail = t('chat.contextBreakDetail', {
      before: formatContextTokenCount(entry.cacheReadBefore), after: formatContextTokenCount(entry.cacheReadAfter),
      rewritten: formatContextTokenCount(entry.rewrittenTokens),
    });
    const gap = entry.cause === 'idle_gap' ? ` · ${escapeHtml(t('chat.contextBreakGap', { gap: formatGap(entry.gapMs) }))}` : '';
    return `<li><strong>${escapeHtml(cause)}</strong> · ${escapeHtml(when)}${gap}<br><span class="settings-hint">${escapeHtml(detail)}</span></li>`;
  });
  const list = rows.length
    ? `<ul class="chat-context-series-breaks">${rows.join('')}</ul>`
    : `<p class="settings-hint">${escapeHtml(t('chat.contextBreakNone'))}</p>`;
  return heading + svg + range + legend + list;
}

/**
 * Fill cache and breakdown gaps of a snapshot from the stored series, so the
 * details survive a reload before the next live event arrives. Live data wins.
 * @param {object} snapshot
 * @param {{ points?: object[], latestBreakdown?: object|null }|null} series
 * @returns {object}
 */
export function mergeSeriesIntoContextSnapshot(snapshot, series) {
  if (!snapshot || !series) return snapshot;
  const last = Array.isArray(series.points) ? series.points[series.points.length - 1] : null;
  const merged = { ...snapshot };
  if (last && merged.cacheReadTokens == null) {
    merged.cacheReadTokens = last.cacheReadTokens;
    merged.cacheInputTokens = last.inputTokens;
    // Codex measures the cache share against its own input count.
    if (merged.transport === 'codex' && merged.inputTokens == null) merged.inputTokens = last.inputTokens;
  }
  if (!merged.breakdown && series.latestBreakdown) {
    merged.breakdown = series.latestBreakdown;
    if (merged.totalTokens == null) merged.totalTokens = series.latestBreakdown.totalTokens;
    if (merged.contextWindowTokens == null) merged.contextWindowTokens = series.latestBreakdown.contextWindowTokens;
  }
  return merged;
}
