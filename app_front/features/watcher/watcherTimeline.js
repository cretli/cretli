/**
 * Workspace Watcher — Gantt-like cycle timeline (pure).
 *
 * Renders the closed cycles from `GET /api/workspace-watcher/stats`
 * (`cycles.recent`, which carries `startedAt`/`at`/`outcome` thanks to the
 * `cycleChats.startedAt` schema change) plus the live cycles from the main view,
 * into multi-lane bars over a selectable window (last hour / 24h / 7d).
 * Concurrency from `maxParallel > 1` is expressed by giving overlapping cycles
 * separate lanes so a busy workspace never looks serialized.
 *
 * Like `watcherStatus.js` this module never touches the DOM and imports no SCSS:
 * the settings panel wires the range buttons and the click-to-detail state and
 * passes them in, so the whole renderer is unit-testable in Node.
 */

import { t } from '../../i18n/index.js';
import {
  escapeWatcherHtml,
  escapeWatcherAttr,
  formatDuration,
  shortId,
  watcherOutcomeTone,
} from './watcherDashboard.js';

export const WATCHER_TIMELINE_RANGES = Object.freeze([
  { key: '1h', ms: 3_600_000 },
  { key: '24h', ms: 86_400_000 },
  { key: '7d', ms: 604_800_000 },
]);

/**
 * @param {string | null | undefined} key
 * @returns {number}
 */
export function resolveTimelineRangeMs(key) {
  const found = WATCHER_TIMELINE_RANGES.find((r) => r.key === String(key || '').trim());
  return (found || WATCHER_TIMELINE_RANGES[1]).ms;
}

/**
 * Coerce a stats `recent` entry or a live `activeCycles` slot into a bar record.
 * Live bars end at `now` and read as `running` so they grow in real time.
 *
 * @param {object} cycle
 * @param {number} now
 * @returns {{ chatId: string, cycleId: string, todoIds: string[], outcome: string, startMs: number | null, endMs: number | null, durationMs: number | null, live: boolean } | null}
 */
export function normalizeTimelineBar(cycle, now) {
  if (!cycle || typeof cycle !== 'object') return null;
  const startedMs = Date.parse(String(cycle.startedAt ?? '').trim());
  const atMs = Date.parse(String(cycle.at ?? '').trim());
  const realStartMs = Number.isFinite(startedMs) ? startedMs : null;
  const closeMs = Number.isFinite(atMs) ? atMs : null;
  const live = cycle.live === true || (realStartMs != null && closeMs == null);
  // Positioning may fall back to the close instant so a legacy point still
  // renders, but the duration stays null unless the real start is known — an
  // unknown start must read as "—" in the detail, never a fabricated 0ms bar.
  const startMs = realStartMs != null ? realStartMs : closeMs;
  const endMs = live ? now : closeMs;
  const outcome = live ? 'running' : String(cycle.outcome || '').trim().toLowerCase();
  const durationMs = realStartMs != null && endMs != null && endMs >= realStartMs ? endMs - realStartMs : null;
  if (startMs == null && endMs == null) return null;
  return {
    chatId: String(cycle.id ?? cycle.chatId ?? '').trim(),
    cycleId: String(cycle.cycleId ?? '').trim(),
    todoIds: Array.isArray(cycle.todoIds) ? cycle.todoIds.map((id) => String(id ?? '').trim()).filter(Boolean) : [],
    harness: String(cycle.harness ?? '').trim(),
    outcome,
    startMs,
    endMs,
    durationMs,
    live,
  };
}

/**
 * Drop bars that ended before the visible window. A bar with only a start (live)
 * is kept as long as its start is inside the window.
 *
 * @param {object[]} bars
 * @param {number} now
 * @param {number} rangeMs
 * @returns {object[]}
 */
export function filterTimelineBars(bars, now, rangeMs) {
  const windowStart = now - rangeMs;
  return (Array.isArray(bars) ? bars : []).filter((bar) => {
    const anchor = bar.startMs != null ? bar.startMs : bar.endMs;
    if (anchor == null) return false;
    const end = bar.endMs != null ? bar.endMs : now;
    return end >= windowStart && anchor <= now;
  });
}

/**
 * Greedy interval partition: overlapping bars get distinct lanes so
 * `maxParallel > 1` concurrency is visible. Returns the rows annotated with a
 * lane index and the total lane count.
 *
 * @param {object[]} bars
 * @returns {{ rows: object[], laneCount: number }}
 */
export function assignTimelineLanes(bars) {
  const sorted = (Array.isArray(bars) ? bars : [])
    .slice()
    .sort((a, b) => (a.startMs ?? a.endMs ?? 0) - (b.startMs ?? b.endMs ?? 0));
  /** @type {number[]} */
  const laneEnds = [];
  /** @type {object[]} */
  const rows = [];
  for (const bar of sorted) {
    const start = bar.startMs ?? bar.endMs ?? 0;
    const end = bar.endMs ?? bar.startMs ?? start;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      laneEnds.push(end);
      lane = laneEnds.length - 1;
    } else {
      laneEnds[lane] = end;
    }
    rows.push({ ...bar, lane });
  }
  return { rows, laneCount: laneEnds.length };
}

/**
 * @param {number} ms
 * @param {number} rangeMs
 * @returns {string}
 */
function axisLabel(ms, rangeMs) {
  const date = new Date(ms);
  const hhmm = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  if (rangeMs > 86_400_000) {
    return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${hhmm}`;
  }
  return `${hhmm} UTC`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function pct(value) {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

/**
 * Render the timeline card: range toolbar, axis, concurrent lanes of bars and an
 * optional selected-cycle detail block.
 *
 * @param {object | null | undefined} stats
 * @param {object | null | undefined} view
 * @param {{ now?: number, rangeKey?: string, selectedId?: string, getTodoTitle?: (id: string) => string }} [options]
 * @returns {string}
 */
export function renderWatcherTimelineHtml(stats, view, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const rangeMs = resolveTimelineRangeMs(options.rangeKey);
  const selectedId = String(options.selectedId || '').trim();
  const getTodoTitle = typeof options.getTodoTitle === 'function' ? options.getTodoTitle : () => '';

  const recent = Array.isArray(stats?.cycles?.recent) ? stats.cycles.recent : [];
  const liveCycles = (Array.isArray(view?.watcher?.activeCycles) && view.watcher.activeCycles.length)
    ? view.watcher.activeCycles
    : (view?.watcher?.activeCycle ? [view.watcher.activeCycle] : []);

  const bars = [
    ...recent.map((entry) => normalizeTimelineBar(entry, now)),
    ...liveCycles.map((cycle) => normalizeTimelineBar({
      id: cycle?.chatId,
      cycleId: cycle?.cycleId,
      todoIds: cycle?.todoIds,
      startedAt: cycle?.startedAt,
      at: '',
      outcome: '',
      harness: cycle?.harness,
      live: true,
    }, now)),
  ].filter(Boolean);

  const visible = filterTimelineBars(bars, now, rangeMs);
  const { rows, laneCount } = assignTimelineLanes(visible);

  const toolbarButtons = WATCHER_TIMELINE_RANGES.map((r) => (
    `<button type="button" class="watcher-tl-range"${r.key === (options.rangeKey || '24h') ? ' data-active="true"' : ''} `
    + `data-watcher-range="${escapeWatcherAttr(r.key)}">${escapeWatcherHtml(t(`settings.watcherDashRange_${r.key}`))}</button>`
  )).join('');

  // A count label tied to the *selected* range so the number shown always
  // matches the window the bars are filtered to (not the retention window).
  const activeRangeKey = options.rangeKey || '24h';
  const windowLabel = t('settings.watcherDashWindowCycles', {
    count: visible.length,
    range: t(`settings.watcherDashRange_${activeRangeKey}`),
  });
  const windowNote = `<span class="watcher-tl-window" data-window-count="${visible.length}">`
    + `${escapeWatcherHtml(windowLabel)}</span>`;

  const windowStart = now - rangeMs;
  const laneBuckets = [];
  for (const row of rows) {
    if (!laneBuckets[row.lane]) laneBuckets[row.lane] = [];
    laneBuckets[row.lane].push(row);
  }

  const laneHtml = (laneCount ? laneBuckets : [[]]).map((laneRows, laneIndex) => {
    const barsHtml = (laneRows || []).map((bar) => {
      const start = Math.max(bar.startMs ?? bar.endMs ?? windowStart, windowStart);
      const end = Math.min(bar.endMs ?? now, now);
      const span = Math.max(end - start, 0);
      const left = pct(((start - windowStart) / rangeMs) * 100);
      const width = Math.max(pct((span / rangeMs) * 100), 0.8).toFixed(3);
      const tone = watcherOutcomeTone(bar.outcome);
      const todoId = bar.todoIds[0] || '';
      const label = (todoId && getTodoTitle(todoId)) || shortId(todoId);
      const isSel = selectedId && (bar.cycleId === selectedId || bar.chatId === selectedId);
      const detail = `${label} · ${bar.outcome || 'running'} · ${bar.harness || '—'} · ${formatDuration(bar.durationMs)}`;
      return `<button type="button" class="watcher-tl-bar" data-outcome-tone="${escapeWatcherAttr(tone)}"`
        + ` data-cycle-id="${escapeWatcherAttr(bar.cycleId)}" data-chat-id="${escapeWatcherAttr(bar.chatId)}"`
        + ` data-todo-id="${escapeWatcherAttr(todoId)}" data-watcher-tl-select`
        + `${isSel ? ' data-selected="true"' : ''}`
        + ` style="left:${left}%;width:${width}%"`
        + ` title="${escapeWatcherAttr(detail)}" aria-label="${escapeWatcherAttr(detail)}">`
        + `<span class="watcher-tl-bar-label">${escapeWatcherHtml(shortId(todoId))}</span>`
        + '</button>';
    }).join('');
    return `<div class="watcher-tl-lane" data-lane="${laneIndex}">${barsHtml}</div>`;
  }).join('');

  const selectedBar = selectedId ? rows.find((bar) => bar.cycleId === selectedId || bar.chatId === selectedId) : null;
  const detailHtml = selectedBar
    ? '<div class="watcher-tl-detail" data-cycle-id="' + escapeWatcherAttr(selectedBar.cycleId) + '">'
      + `<div><strong>${escapeWatcherHtml(t('settings.watcherDashTodo'))}</strong>: ${escapeWatcherHtml((selectedBar.todoIds[0] && getTodoTitle(selectedBar.todoIds[0])) || shortId(selectedBar.todoIds[0]))} `
      + `<code>${escapeWatcherHtml(shortId(selectedBar.todoIds[0]))}</code></div>`
      + `<div><strong>${escapeWatcherHtml(t('settings.watcherDashOutcome'))}</strong>: ${escapeWatcherHtml(selectedBar.outcome || 'running')}</div>`
      + `<div><strong>${escapeWatcherHtml(t('settings.watcherDashHarness'))}</strong>: ${escapeWatcherHtml(selectedBar.harness || '—')}</div>`
      + `<div><strong>${escapeWatcherHtml(t('settings.watcherDashChat'))}</strong>: ${escapeWatcherHtml(shortId(selectedBar.chatId))}</div>`
      + `<div><strong>${escapeWatcherHtml(t('settings.watcherDashDuration'))}</strong>: ${escapeWatcherHtml(formatDuration(selectedBar.durationMs))}</div>`
      + '</div>'
    : `<p class="watcher-dash-empty watcher-tl-hint">${escapeWatcherHtml(t('settings.watcherDashClickCycle'))}</p>`;

  const concurrencyNote = laneCount > 1
    ? `<span class="watcher-tl-lanes" data-lane-count="${laneCount}">${escapeWatcherHtml(t('settings.watcherDashLanes', { count: laneCount }))}</span>`
    : '';

  const emptyNote = visible.length === 0
    ? `<p class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherDashNoCycles'))}</p>`
    : '';

  return '<div class="cr-card watcher-dash-section watcher-dash-timeline">'
    + `<h4>${escapeWatcherHtml(t('settings.watcherDashTimeline'))}</h4>`
    + `<div class="watcher-tl-toolbar" role="group" aria-label="${escapeWatcherAttr(t('settings.watcherDashRange'))}">${toolbarButtons}${windowNote}${concurrencyNote}</div>`
    + '<div class="watcher-tl-axis">'
    + `<span>${escapeWatcherHtml(axisLabel(windowStart, rangeMs))}</span>`
    + `<span>${escapeWatcherHtml(axisLabel(now - rangeMs / 2, rangeMs))}</span>`
    + `<span class="watcher-tl-axis-now">${escapeWatcherHtml(`${axisLabel(now, rangeMs)} · ${t('settings.watcherDashNow')}`)}</span>`
    + '</div>'
    + `<div class="watcher-tl-track">${laneHtml}${emptyNote}</div>`
    + detailHtml
    + '</div>';
}
