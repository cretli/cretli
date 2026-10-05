/**
 * Workspace Watcher — monitoring dashboard view helpers (pure).
 *
 * Renders the Settings → Workspace Watcher dashboard sections from the two
 * payloads the panel fetches: `GET /api/workspace-watcher` (the live view: mode,
 * active cycles, decisions, alerts) and `GET /api/workspace-watcher/stats`
 * (aggregated throughput, success rate, stop reasons, top harnesses).
 *
 * Nothing here touches `document` or imports SCSS, so every renderer is
 * unit-testable in Node exactly like `watcherStatus.js`. The settings panel owns
 * the DOM wiring and the live countdown/duration repaints; this module only
 * turns data into HTML strings and exposes the shared formatting helpers the
 * timeline renderer (`watcherTimeline.js`) reuses.
 */

import { t } from '../../i18n/index.js';
import {
  escapeWatcherHtml,
  escapeWatcherAttr,
  formatWatcherDecisionReasonText,
} from './watcherStatus.js';

export { escapeWatcherHtml, escapeWatcherAttr, formatWatcherDecisionReasonText };

/** Outcome → a stable tone key the SCSS colors on. */
const OUTCOME_TONES = {
  success: 'success',
  failure: 'failed',
  blocked: 'blocked',
  running: 'active',
  active: 'active',
};

/**
 * @param {string | null | undefined} outcome
 * @returns {string}
 */
export function watcherOutcomeTone(outcome) {
  return OUTCOME_TONES[String(outcome || '').trim().toLowerCase()] || 'unknown';
}

/**
 * The row's live cycles, accepting either the v2 list or the v1 mirror.
 *
 * @param {object | null | undefined} watcher
 * @returns {object[]}
 */
export function liveWatcherCycles(watcher) {
  if (Array.isArray(watcher?.activeCycles) && watcher.activeCycles.length) return watcher.activeCycles;
  if (watcher?.activeCycle) return [watcher.activeCycle];
  return [];
}

/**
 * Human duration from milliseconds. `null`/NaN/negative become a placeholder so
 * a legacy cycle with no recorded start reads as "unknown", never "0s".
 *
 * @param {number | null | undefined} ms
 * @param {string} [placeholder]
 * @returns {string}
 */
export function formatDuration(ms, placeholder = '—') {
  if (ms == null || ms === '') return placeholder;
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return placeholder;
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSeconds = Math.floor(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${hours}h ${totalMinutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Remaining time until a future instant. Anything already past reads as done.
 *
 * @param {number | null | undefined} untilMs
 * @param {number} now
 * @returns {string}
 */
export function formatCountdown(untilMs, now) {
  if (untilMs == null || untilMs === '') return '—';
  const until = Number(untilMs);
  const base = Number(now);
  if (!Number.isFinite(until) || !Number.isFinite(base)) return '—';
  const remaining = until - base;
  if (remaining <= 0) return t('settings.watcherDashExpired');
  return formatDuration(remaining, '—');
}

/**
 * @param {number | null | undefined} ratio 0..1
 * @returns {string}
 */
export function formatPercent(ratio) {
  if (ratio == null || ratio === '') return '—';
  const value = Number(ratio);
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/**
 * @param {unknown} id
 * @param {number} [len]
 * @returns {string}
 */
export function shortId(id, len = 8) {
  const value = String(id || '').trim();
  return value ? value.slice(0, len) : '—';
}

/**
 * Interpret `policy.quietHours` ({ start, end } as UTC HH:MM) against `now` and
 * report whether the window is active plus the next instant it ends. Mirrors the
 * server's UTC midnight-wrap rule so the countdown is honest across midnight.
 *
 * @param {{ start?: string, end?: string } | null | undefined} quietHours
 * @param {number} now
 * @returns {{ configured: boolean, active: boolean, endsAtMs: number | null }}
 */
export function quietHoursStatus(quietHours, now) {
  const parse = (value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = parse(quietHours?.start);
  const end = parse(quietHours?.end);
  if (start == null || end == null || start === end) {
    return { configured: false, active: false, endsAtMs: null };
  }
  const date = new Date(now);
  const minutesNow = date.getUTCHours() * 60 + date.getUTCMinutes();
  const wraps = start > end;
  const active = wraps ? (minutesNow >= start || minutesNow < end) : (minutesNow >= start && minutesNow < end);
  if (!active) return { configured: true, active: false, endsAtMs: null };
  // Next end boundary, always in the future relative to `now`.
  let endsAtMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, end);
  if (endsAtMs <= now) endsAtMs += 86_400_000;
  return { configured: true, active: true, endsAtMs };
}

/**
 * Live status section: mode, per-slot active cycles (todo, phase, running
 * duration), active delegations (harness/status), and the latest decision.
 *
 * @param {object | null | undefined} view
 * @param {{ stats?: object, getTodoTitle?: (id: string) => string, now?: number }} [options]
 * @returns {string}
 */
export function renderWatcherLiveHtml(view, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const getTodoTitle = typeof options.getTodoTitle === 'function' ? options.getTodoTitle : () => '';
  const watcher = view?.watcher || {};
  const cycles = liveWatcherCycles(watcher);
  const delegations = Array.isArray(options.stats?.activeDelegations) ? options.stats.activeDelegations : [];

  const cycleRows = cycles.length
    ? cycles.map((cycle) => {
      const todoId = String(cycle?.todoIds?.[0] || '').trim();
      const title = (todoId && getTodoTitle(todoId)) || shortId(todoId);
      const startedMs = Date.parse(String(cycle?.startedAt || '').trim());
      const duration = formatDuration(Number.isFinite(startedMs) ? now - startedMs : null);
      const chatId = String(cycle?.chatId || '').trim();
      const phase = String(cycle?.phase || (cycle?.runId ? 'running' : 'starting'));
      const phaseLabel = phase === 'running'
        ? t('settings.watcherDashPhaseRunning')
        : phase === 'starting'
          ? t('settings.watcherDashPhaseStarting')
          : phase;
      return `<li class="watcher-dash-cycle" data-tone="${escapeWatcherAttr(watcherOutcomeTone(phase === 'running' ? 'running' : 'active'))}">`
        + `<span class="watcher-dash-cycle-title">${escapeWatcherHtml(title)}</span>`
        + `<code class="watcher-dash-todo">${escapeWatcherHtml(shortId(todoId))}</code>`
        + `<span class="watcher-dash-phase">${escapeWatcherHtml(phaseLabel)}</span>`
        + `<span class="watcher-dash-duration" data-watcher-duration="${escapeWatcherAttr(String(startedMs || ''))}">${escapeWatcherHtml(duration)}</span>`
        + (chatId ? `<button type="button" class="watcher-dash-link" data-watcher-open-chat="${escapeWatcherAttr(chatId)}" title="${escapeWatcherAttr(t('todo.watcherOpenOrchestrator'))}">${escapeWatcherHtml(shortId(chatId))}</button>` : '')
        + '</li>';
    }).join('')
    : `<li class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherDashNoActiveCycles'))}</li>`;

  const delegationRows = delegations.length
    ? delegations.map((row) => {
      const startedMs = Date.parse(String(row?.startedAt || row?.createdAt || '').trim());
      const duration = formatDuration(Number.isFinite(startedMs) ? now - startedMs : null);
      return `<li class="watcher-dash-delegation">`
        + `<span class="watcher-dash-harness">${escapeWatcherHtml(row?.harness || 'unknown')}</span>`
        + `<span class="watcher-dash-status" data-tone="${escapeWatcherAttr(watcherOutcomeTone('running'))}">${escapeWatcherHtml(row?.status || '')}</span>`
        + `<span class="watcher-dash-assignment">${escapeWatcherHtml(row?.assignment || '')}</span>`
        + `<span class="watcher-dash-duration" data-watcher-duration="${escapeWatcherAttr(String(startedMs || ''))}">${escapeWatcherHtml(duration)}</span>`
        + '</li>';
    }).join('')
    : `<li class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherDashNoActiveDelegations'))}</li>`;

  const decisions = Array.isArray(watcher.decisions) ? watcher.decisions : [];
  const latest = decisions.length ? decisions[decisions.length - 1] : null;

  return '<div class="cr-card watcher-dash-section watcher-dash-live">'
    + `<h4>${escapeWatcherHtml(t('settings.watcherDashLive'))}</h4>`
    + `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherMode'))}: <strong>${escapeWatcherHtml(String(watcher.mode || 'off').toUpperCase())}</strong>`
    + (watcher.paused === true ? ` · <span class="watcher-badge" data-mode="paused">${escapeWatcherHtml(t('settings.watcherPausedBadge'))}</span>` : '')
    + '</p>'
    + `<div class="watcher-dash-sub">${escapeWatcherHtml(t('settings.watcherActiveCycles'))}</div>`
    + `<ul class="watcher-dash-list watcher-dash-cycles">${cycleRows}</ul>`
    + `<div class="watcher-dash-sub">${escapeWatcherHtml(t('settings.watcherDashActiveDelegations'))}</div>`
    + `<ul class="watcher-dash-list watcher-dash-delegations">${delegationRows}</ul>`
    + `<div class="watcher-dash-sub">${escapeWatcherHtml(t('settings.watcherDashLatestDecision'))}</div>`
    + (latest
      ? `<p class="watcher-dash-latest"><code>${escapeWatcherHtml(String(latest.at || ''))}</code> <strong>${escapeWatcherHtml(String(latest.kind || ''))}</strong> · ${escapeWatcherHtml(String(latest.reason || ''))}</p>`
      : `<p class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherNoDecisions'))}</p>`)
    + '</div>';
}

/**
 * Statistics section: success rate, avg cycle time, cycle totals, daily/weekly
 * throughput bars, top stop reasons and top harnesses by delegation count +
 * verified pass rate.
 *
 * @param {object | null | undefined} stats
 * @returns {string}
 */
export function renderWatcherStatsHtml(stats) {
  const cycles = stats?.cycles || {};
  const daily = Array.isArray(stats?.throughput?.daily) ? stats.throughput.daily : [];
  const weekly = Array.isArray(stats?.throughput?.weekly) ? stats.throughput.weekly : [];
  const stopReasons = Array.isArray(stats?.stopReasons) ? stats.stopReasons : [];
  const harnesses = Array.isArray(stats?.harnesses) ? stats.harnesses : [];

  const dailyMax = Math.max(1, ...daily.map((d) => Number(d.total) || 0));
  const dailyBars = daily.map((d) => {
    const total = Number(d.total) || 0;
    const height = total === 0 ? 2 : Math.max(6, Math.round((total / dailyMax) * 46));
    return `<div class="watcher-dash-bar-group" title="${escapeWatcherAttr(`${d.day} · ${t('settings.watcherDashSuccess')}: ${d.success} · ${t('settings.watcherDashFailure')}: ${d.failure} · ${t('settings.watcherDashBlocked')}: ${d.blocked}`)}">`
      + `<div class="watcher-dash-bar" style="height:${height}px" data-total="${escapeWatcherAttr(String(total))}" data-success="${escapeWatcherAttr(String(d.success))}" data-failed="${escapeWatcherAttr(String(d.failure))}" data-blocked="${escapeWatcherAttr(String(d.blocked))}"></div>`
      + `<span class="watcher-dash-bar-label">${escapeWatcherHtml(String(d.day || '').slice(5))}</span>`
      + '</div>';
  }).join('');

  const weeklyRows = weekly.map((w) => (
    `<li><code>${escapeWatcherHtml(String(w.week || ''))}</code> · ${t('settings.watcherDashThroughput')}: ${Number(w.total) || 0} · ${t('settings.watcherDashSuccess')}: ${Number(w.success) || 0}</li>`
  )).join('') || `<li class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherDashNoStats'))}</li>`;

  const stopRows = stopReasons.map((r) => (
    `<li><strong>${escapeWatcherHtml(r.kind)}</strong> ×${Number(r.count) || 0}`
    + (r.lastReason ? ` · ${escapeWatcherHtml(r.lastReason)}` : '') + '</li>'
  )).join('') || `<li class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherDashNoStats'))}</li>`;

  const harnessRows = harnesses.map((h) => (
    `<li class="watcher-dash-harness-row">`
    + `<span class="watcher-dash-harness">${escapeWatcherHtml(h.harness)}</span>`
    + `<span class="watcher-dash-count">${Number(h.count) || 0}</span>`
    + `<span class="watcher-dash-pass" title="${escapeWatcherAttr(t('settings.watcherDashPassRate'))}">${escapeWatcherHtml(formatPercent(h.passRate))}</span>`
    + `<span class="watcher-dash-verified">${escapeWatcherHtml(t('settings.watcherDashVerifiedCount', { verified: Number(h.verified) || 0 }))}</span>`
    + '</li>'
  )).join('') || `<li class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherDashNoStats'))}</li>`;

  return '<div class="cr-card watcher-dash-section watcher-dash-stats">'
    + `<h4>${escapeWatcherHtml(t('settings.watcherDashStats'))}</h4>`
    + '<div class="watcher-dash-kpis">'
    + `<div class="watcher-dash-kpi"><span class="watcher-dash-kpi-value">${escapeWatcherHtml(formatPercent(cycles.successRate))}</span><span class="watcher-dash-kpi-label">${escapeWatcherHtml(t('settings.watcherDashSuccessRate'))}</span></div>`
    + `<div class="watcher-dash-kpi"><span class="watcher-dash-kpi-value">${escapeWatcherHtml(formatDuration(cycles.avgDurationMs))}</span><span class="watcher-dash-kpi-label">${escapeWatcherHtml(t('settings.watcherDashAvgCycle'))}</span></div>`
    + `<div class="watcher-dash-kpi"><span class="watcher-dash-kpi-value">${Number(stats?.cycleCount) || 0}</span><span class="watcher-dash-kpi-label">${escapeWatcherHtml(t('settings.watcherCyclesTotal'))}</span></div>`
    + `<div class="watcher-dash-kpi"><span class="watcher-dash-kpi-value">${Number(cycles.windowCycles) || 0}</span><span class="watcher-dash-kpi-label">${escapeWatcherHtml(t('settings.watcherDashRecentWindow'))}</span></div>`
    + '</div>'
    + `<div class="watcher-dash-sub">${escapeWatcherHtml(t('settings.watcherDashDailyThroughput'))}</div>`
    + `<div class="watcher-dash-bars">${dailyBars}</div>`
    + `<div class="watcher-dash-sub">${escapeWatcherHtml(t('settings.watcherDashWeeklyThroughput'))}</div>`
    + `<ul class="watcher-dash-list">${weeklyRows}</ul>`
    + `<div class="watcher-dash-sub">${escapeWatcherHtml(t('settings.watcherDashStopReasons'))}</div>`
    + `<ul class="watcher-dash-list watcher-dash-stops">${stopRows}</ul>`
    + `<div class="watcher-dash-sub">${escapeWatcherHtml(t('settings.watcherDashTopHarnesses'))}</div>`
    + `<ul class="watcher-dash-list watcher-dash-harnesses">${harnessRows}</ul>`
    + '</div>';
}

/**
 * Decisions section with a "filter by type" dropdown. `kinds` is the aggregated
 * per-kind tally from stats; `filterKind` selects the visible rows.
 *
 * @param {object[]} decisions
 * @param {{ kinds?: object[], filterKind?: string }} [options]
 * @returns {string}
 */
export function renderWatcherDecisionsHtml(decisions, options = {}) {
  const rows = Array.isArray(decisions) ? decisions : [];
  const kinds = Array.isArray(options.kinds) ? options.kinds : [];
  const filterKind = String(options.filterKind || 'all');
  const visible = (filterKind === 'all' ? rows : rows.filter((d) => String(d?.kind || '') === filterKind))
    .slice()
    .reverse()
    .slice(0, 40);

  const optionsHtml = ['all', ...kinds.map((k) => k.kind)]
    .map((kind) => (
      `<option value="${escapeWatcherAttr(kind)}"${kind === filterKind ? ' selected' : ''}>`
      + `${escapeWatcherHtml(kind === 'all' ? t('settings.watcherDashAllTypes') : kind)}</option>`
    )).join('');

  const tableRows = visible.length
    ? visible.map((d) => (
      `<tr><td class="watcher-dash-dec-at">${escapeWatcherHtml(String(d?.at || ''))}</td>`
      + `<td class="watcher-dash-dec-kind">${escapeWatcherHtml(String(d?.kind || ''))}</td>`
      + `<td class="watcher-dash-dec-reason">${escapeWatcherHtml(formatWatcherDecisionReasonText(d))}</td></tr>`
    )).join('')
    : `<tr><td colspan="3" class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherNoDecisions'))}</td></tr>`;

  return '<div class="cr-card watcher-dash-section watcher-dash-decisions">'
    + `<h4>${escapeWatcherHtml(t('settings.watcherDecisions'))}</h4>`
    + `<label class="watcher-dash-filter"><span class="cr-field-label">${escapeWatcherHtml(t('settings.watcherDashFilterType'))}</span>`
    + `<select class="widget-panel-select" data-watcher-decisions-filter aria-label="${escapeWatcherAttr(t('settings.watcherDashFilterType'))}">${optionsHtml}</select></label>`
    + '<table class="watcher-dash-decisions-table"><thead><tr>'
    + `<th>${escapeWatcherHtml(t('todo.watcherDecisionAt'))}</th>`
    + `<th>${escapeWatcherHtml(t('todo.watcherDecisionKind'))}</th>`
    + `<th>${escapeWatcherHtml(t('todo.watcherDecisionReason'))}</th>`
    + `</tr></thead><tbody>${tableRows}</tbody></table>`
    + '</div>';
}

/**
 * Alerts section: active stop_reason with a clear action, the failure backoff
 * countdown, and the quiet-hours window end. Each time-sensitive value carries a
 * `data-watcher-*` hook so the panel repaints it every second without refetching.
 *
 * @param {object | null | undefined} view
 * @param {{ now?: number }} [options]
 * @returns {string}
 */
export function renderWatcherAlertsHtml(view, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const watcher = view?.watcher || {};
  const policy = watcher.policy || {};

  const alerts = [];
  const stopReason = String(watcher.stopReason || '').trim();
  if (stopReason) {
    alerts.push('<div class="watcher-dash-alert" data-tone="stopped">'
      + `<span class="watcher-dash-alert-label">${escapeWatcherHtml(t('settings.watcherStopReason'))}</span>`
      + `<span class="watcher-dash-alert-text">${escapeWatcherHtml(stopReason)}</span>`
      + `<button type="button" class="watcher-dash-alert-clear" data-watcher-action="clear-stop">${escapeWatcherHtml(t('settings.watcherClearStop'))}</button>`
      + '</div>');
  }
  const backoffMs = Date.parse(String(watcher.backoffUntil || '').trim());
  if (Number.isFinite(backoffMs) && backoffMs > now) {
    alerts.push('<div class="watcher-dash-alert" data-tone="backoff">'
      + `<span class="watcher-dash-alert-label">${escapeWatcherHtml(t('settings.watcherBackoff'))}</span>`
      + `<span class="watcher-dash-countdown" data-watcher-countdown="${escapeWatcherAttr(String(backoffMs))}">${escapeWatcherHtml(formatCountdown(backoffMs, now))}</span>`
      + '</div>');
  }
  const quiet = quietHoursStatus(policy.quietHours, now);
  if (quiet.configured) {
    if (quiet.active && quiet.endsAtMs != null) {
      alerts.push('<div class="watcher-dash-alert" data-tone="quiet">'
        + `<span class="watcher-dash-alert-label">${escapeWatcherHtml(t('settings.watcherDashQuietActive'))}</span>`
        + `<span class="watcher-dash-countdown" data-watcher-countdown="${escapeWatcherAttr(String(quiet.endsAtMs))}">${escapeWatcherHtml(formatCountdown(quiet.endsAtMs, now))}</span>`
        + `<span class="watcher-dash-alert-text">${escapeWatcherHtml(t('settings.watcherDashQuietEnds'))}</span>`
        + '</div>');
    } else {
      alerts.push('<div class="watcher-dash-alert" data-tone="quiet-next">'
        + `<span class="watcher-dash-alert-label">${escapeWatcherHtml(t('settings.watcherDashQuietNext'))}</span>`
        + `<span class="watcher-dash-alert-text">${escapeWatcherHtml(`${String(policy.quietHours?.start || '')}–${String(policy.quietHours?.end || '')} UTC`)}</span>`
        + '</div>');
    }
  }

  const body = alerts.length
    ? alerts.join('')
    : `<p class="watcher-dash-empty">${escapeWatcherHtml(t('settings.watcherDashNoAlerts'))}</p>`;

  return '<div class="cr-card watcher-dash-section watcher-dash-alerts">'
    + `<h4>${escapeWatcherHtml(t('settings.watcherDashAlerts'))}</h4>`
    + body
    + '</div>';
}
