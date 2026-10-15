import { escapeHtml } from './chatHtmlUtils.js';
import { formatContextTokenCount } from '../../../lib/sdk/sdk-context-advisory.js';

const WIDTH = 320;
const HEIGHT = 140;
const PAD_LEFT = 34;
const PAD = 8;
const MAX_POINTS = 400;
// Show the window limit line only when it is close enough not to flatten the data.
const WINDOW_LINE_MAX_RATIO = 1.3;
// Zoom presets: number of newest calls to show, 0 means everything the series holds.
const RANGE_PRESETS = [0, 100, 30];

function formatGap(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`;
}

/** Window of the series shown in the chart plus the geometry shared by the renderer and the hover binder. */
function buildChartModel(series, range = 0) {
  const limit = range > 0 ? Math.min(range, MAX_POINTS) : MAX_POINTS;
  const offset = Math.max(0, series.points.length - limit);
  const points = series.points.slice(offset);
  const shift = (list) => (list || []).filter((entry) => entry.index >= offset).map((entry) => ({ ...entry, index: entry.index - offset }));
  const values = points.flatMap((point) => [point.totalTokens, point.cacheReadTokens]).filter((value) => typeof value === 'number');
  const windowTokens = points.map((point) => point.contextWindowTokens).filter((value) => value > 0).pop() || null;
  const dataMax = Math.max(1, ...values);
  const showWindow = windowTokens != null && windowTokens <= dataMax * WINDOW_LINE_MAX_RATIO;
  const max = showWindow ? Math.max(dataMax, windowTokens) : dataMax;
  // Scale from zero so a collapse reads as a collapse instead of being clipped by an auto-fitted minimum.
  const min = 0;
  const step = points.length > 1 ? (WIDTH - PAD_LEFT - PAD) / (points.length - 1) : 0;
  const x = (index) => PAD_LEFT + index * step;
  const y = (value) => HEIGHT - PAD - ((value - min) / Math.max(1, max - min)) * (HEIGHT - PAD * 2);
  return { points, breaks: shift(series.breaks), compactions: shift(series.compactions), max, min, windowTokens: showWindow ? windowTokens : null, x, y, step };
}

function linePath(model, key) {
  let path = '';
  let gap = true;
  model.points.forEach((point, index) => {
    const value = point[key];
    if (typeof value !== 'number') { gap = true; return; }
    path += `${gap ? 'M' : 'L'}${model.x(index).toFixed(1)},${model.y(value).toFixed(1)}`;
    gap = false;
  });
  return path;
}

function renderMarkers(model, t) {
  const compaction = model.compactions.map((entry) => {
    const x = model.x(entry.index).toFixed(1);
    return `<g class="chat-context-series-compaction" data-event="compaction" data-index="${entry.index}">`
      + `<title>${escapeHtml(t('chat.contextEventCompaction'))}</title>`
      + `<line x1="${x}" x2="${x}" y1="${PAD}" y2="${HEIGHT - PAD}"></line>`
      + `<path d="M${(Number(x) - 4).toFixed(1)},${PAD} L${(Number(x) + 4).toFixed(1)},${PAD} L${x},${PAD + 6}Z"></path></g>`;
  });
  const breaks = model.breaks.map((entry) => {
    const x = model.x(entry.index).toFixed(1);
    return `<g class="chat-context-series-break" data-event="cache_break" data-index="${entry.index}">`
      + `<line x1="${x}" x2="${x}" y1="${PAD}" y2="${HEIGHT - PAD}"></line>`
      + `<circle cx="${x}" cy="${model.y(entry.cacheReadAfter ?? 0).toFixed(1)}" r="3"></circle></g>`;
  });
  return compaction.join('') + breaks.join('');
}

function renderAxis(model) {
  const label = (value) => formatContextTokenCount(value);
  const lines = [model.max, model.max / 2, 0].map((value) => {
    const y = model.y(value).toFixed(1);
    return `<line class="chat-context-series-grid" x1="${PAD_LEFT}" x2="${WIDTH - PAD}" y1="${y}" y2="${y}"></line>`
      + `<text class="chat-context-series-axis" x="${PAD_LEFT - 4}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end">${escapeHtml(label(value))}</text>`;
  }).join('');
  if (model.windowTokens == null) return lines;
  const y = model.y(model.windowTokens).toFixed(1);
  return lines + `<line class="chat-context-series-window" x1="${PAD_LEFT}" x2="${WIDTH - PAD}" y1="${y}" y2="${y}"></line>`;
}

function describeEvent(entry, kind, t, lang) {
  const when = new Date(entry.observedAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'medium' });
  if (kind === 'compaction') {
    const title = t(entry.cause === 'context_reset' ? 'chat.contextEventReset' : 'chat.contextEventCompaction');
    const detail = t('chat.contextEventCompactionDetail', {
      before: formatContextTokenCount(entry.totalBefore), after: formatContextTokenCount(entry.totalAfter),
    });
    return { title, when, detail, gap: '' };
  }
  const detail = t('chat.contextBreakDetail', {
    before: formatContextTokenCount(entry.cacheReadBefore), after: formatContextTokenCount(entry.cacheReadAfter),
    rewritten: formatContextTokenCount(entry.rewrittenTokens),
  });
  const gap = entry.cause === 'idle_gap' ? ` · ${t('chat.contextBreakGap', { gap: formatGap(entry.gapMs) })}` : '';
  return { title: t(`chat.contextBreakCause_${entry.cause}`), when, detail, gap };
}

/**
 * Chart of context size and cache reads over the calls of one chat. Compactions
 * (context collapses) and cache breaks are marked on the plot and listed below.
 * Harness-agnostic: it only needs the shared series. Call
 * {@link bindChatContextCacheChart} after inserting the HTML to enable hover/tap.
 * @param {{ points: object[], breaks: object[], compactions?: object[] }|null} series
 * @param {(key: string, params?: object) => string} t
 * @param {string} [lang]
 * @param {{ range?: number }} [options] `range`: show only the newest N calls (0 = all)
 */
export function renderChatContextCacheChartHtml(series, t, lang = 'en', options = {}) {
  const heading = `<h3>${escapeHtml(t('chat.contextSeriesTitle'))}</h3>`;
  if (!series || !Array.isArray(series.points) || series.points.length < 2) {
    return series ? heading + `<p class="settings-hint">${escapeHtml(t('chat.contextSeriesEmpty'))}</p>` : '';
  }
  const range = Number(options.range) > 0 ? Number(options.range) : 0;
  const model = buildChartModel(series, range);
  const svg = `<div class="chat-context-series-wrap"><svg class="chat-context-series" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeHtml(t('chat.contextSeriesTitle'))}">`
    + renderAxis(model)
    + `<path class="chat-context-series-context" d="${linePath(model, 'totalTokens')}"></path>`
    + `<path class="chat-context-series-cache" d="${linePath(model, 'cacheReadTokens')}"></path>`
    + renderMarkers(model, t)
    + `<line class="chat-context-series-cursor" x1="0" x2="0" y1="${PAD}" y2="${HEIGHT - PAD}" hidden></line>`
    + `</svg><div class="chat-context-series-tooltip" hidden></div></div>`;
  const rangeNote = `<p class="settings-hint">${escapeHtml(t('chat.contextSeriesRange', { min: formatContextTokenCount(model.min), max: formatContextTokenCount(model.max), count: model.points.length }))}</p>`;
  const key = (cls, text) => `<span class="chat-context-series-key ${cls}"></span>${escapeHtml(text)}`;
  const legend = `<p class="chat-context-breakdown-note chat-context-series-legend">${key('chat-context-series-context-key', t('chat.contextSeriesContext'))} `
    + `${key('chat-context-series-cache-key', t('chat.contextSeriesCache'))} `
    + `${key('chat-context-series-compaction-key', t('chat.contextSeriesCompaction'))} `
    + `${key('chat-context-series-break-key', t('chat.contextSeriesBreak'))}</p>`;
  const events = [
    ...(series.compactions || []).map((entry) => ({ entry, kind: 'compaction' })),
    ...series.breaks.map((entry) => ({ entry, kind: 'cache_break' })),
  ].sort((a, b) => a.entry.observedAt.localeCompare(b.entry.observedAt));
  const rows = events.map(({ entry, kind }) => {
    const info = describeEvent(entry, kind, t, lang);
    return `<li data-event="${kind}" data-observed-at="${escapeHtml(entry.observedAt)}"><strong>${escapeHtml(info.title)}</strong> · ${escapeHtml(info.when)}${escapeHtml(info.gap)}`
      + `<br><span class="settings-hint">${escapeHtml(info.detail)}</span></li>`;
  });
  const list = rows.length
    ? `<ul class="chat-context-series-breaks">${rows.join('')}</ul>`
    : `<p class="settings-hint">${escapeHtml(t('chat.contextBreakNone'))}</p>`;
  const presets = series.points.length > RANGE_PRESETS[2]
    ? `<div class="chat-context-series-ranges" role="group">${RANGE_PRESETS.map((value) => {
      const label = value === 0 ? t('chat.contextSeriesRangeAll') : t('chat.contextSeriesRangeLast', { count: value });
      return `<button type="button" class="chat-context-series-range" data-range="${value}"${value === range ? ' aria-pressed="true"' : ''}>${escapeHtml(label)}</button>`;
    }).join('')}</div>`
    : '';
  return heading + presets + svg + rangeNote + legend + list;
}

/**
 * Wire hover/tap on a chart rendered by {@link renderChatContextCacheChartHtml}:
 * a cursor line plus a tooltip with the call's time, context, cache and events.
 * Safe to call repeatedly on a freshly rendered container.
 * @param {HTMLElement} container
 * @param {{ points: object[], breaks: object[], compactions?: object[] }|null} series
 * @param {(key: string, params?: object) => string} t
 * @param {string} [lang]
 */
export function bindChatContextCacheChart(container, series, t, lang = 'en') {
  container?.querySelectorAll?.('button[data-range]').forEach((button) => button.addEventListener('click', () => {
    container.dataset.chartRange = button.dataset.range;
    container.innerHTML = renderChatContextCacheChartHtml(series, t, lang, { range: Number(button.dataset.range) });
    bindChatContextCacheChart(container, series, t, lang);
  }));
  const svg = container?.querySelector?.('svg.chat-context-series');
  const tooltip = container?.querySelector?.('.chat-context-series-tooltip');
  const cursor = svg?.querySelector('.chat-context-series-cursor');
  if (!svg || !tooltip || !cursor || !series?.points?.length) return;
  const model = buildChartModel(series, Number(container.dataset?.chartRange) || 0);
  const eventsAt = new Map();
  [...model.compactions.map((entry) => ({ entry, kind: 'compaction' })), ...model.breaks.map((entry) => ({ entry, kind: 'cache_break' }))]
    .forEach((item) => { eventsAt.set(item.entry.index, [...(eventsAt.get(item.entry.index) || []), item]); });
  const hide = () => { tooltip.hidden = true; cursor.setAttribute('hidden', ''); };
  const show = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = (clientX - rect.left) / rect.width * WIDTH;
    const index = Math.max(0, Math.min(model.points.length - 1, Math.round((svgX - PAD_LEFT) / (model.step || 1))));
    const point = model.points[index];
    const x = model.x(index);
    cursor.setAttribute('x1', x.toFixed(1));
    cursor.setAttribute('x2', x.toFixed(1));
    cursor.removeAttribute('hidden');
    const lines = [new Date(point.observedAt).toLocaleTimeString(lang, { timeStyle: 'medium' })];
    if (typeof point.totalTokens === 'number') {
      const fill = point.fillPercent != null ? ` (${point.fillPercent.toFixed(0)}%)` : '';
      lines.push(`${t('chat.contextSeriesContext')}: ${formatContextTokenCount(point.totalTokens)}${fill}`);
    }
    if (typeof point.cacheReadTokens === 'number') {
      const share = point.cachePercent != null ? ` (${point.cachePercent.toFixed(0)}%)` : '';
      lines.push(`${t('chat.contextSeriesCache')}: ${formatContextTokenCount(point.cacheReadTokens)}${share}`);
    }
    if (point.model) lines.push(point.model);
    (eventsAt.get(index) || []).forEach(({ entry, kind }) => lines.push(`⚑ ${describeEvent(entry, kind, t, lang).title}`));
    tooltip.innerHTML = lines.map((line, i) => (i === 0 ? `<strong>${escapeHtml(line)}</strong>` : `<div>${escapeHtml(line)}</div>`)).join('');
    tooltip.hidden = false;
    // Flip to the left half so the tooltip never leaves the plot.
    const flip = x > WIDTH / 2;
    tooltip.style.left = flip ? 'auto' : `${(x / WIDTH * 100).toFixed(1)}%`;
    tooltip.style.right = flip ? `${((WIDTH - x) / WIDTH * 100).toFixed(1)}%` : 'auto';
  };
  svg.addEventListener('pointermove', (event) => show(event.clientX));
  svg.addEventListener('pointerdown', (event) => show(event.clientX));
  svg.addEventListener('pointerleave', hide);
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
