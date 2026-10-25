/**
 * Pure HTML builders for the Watcher status, schedule, runtime, load and override regions.
 */

import { ws } from './store.js';
import { t } from '../../../i18n/index.js';
import { scoutReasonText } from '../../watcher/scoutProfilesView.js';
import { formatCountdown, scheduleNextValueHtml } from '../../watcher/watcherDashboard.js';
import { escapeAttr, escapeHtml, formatActiveCyclesSummary } from './format.js';

/**
 * The status card is isolated from the editable form so a live watcher change or
 * an optimistic save can repaint it without rebuilding the form below (which
 * would drop unsaved edits).
 *
 * @param {any} data
 * @returns {string}
 */
export function renderWatcherStatusCardHtml(data) {
  const watcher = data.watcher || {};
  return `
    <div class="cr-row watcher-status-row">
      <span class="watcher-badge" data-mode="${escapeAttr(watcher.mode || 'off')}">${escapeHtml(String(watcher.mode || 'off').toUpperCase())}</span>
      <span class="cr-hint">${escapeHtml(t('settings.watcherGuardrail'))}: <strong>${escapeHtml(data.guardrails?.kind || '-')}</strong> (${escapeHtml(data.guardrails?.reason || '-')})</span>
      ${watcher.paused ? `<span class="watcher-badge" data-mode="paused">${escapeHtml(t('settings.watcherPausedBadge'))}</span>` : ''}
    </div>
    <p class="cr-hint">${escapeHtml(t('settings.watcherCyclesToday'))}: ${Number(data.guardrails?.usedToday) || 0} / ${Number(data.guardrails?.maxCyclesPerDay) || 0} · ${escapeHtml(t('settings.watcherCyclesTotal'))}: ${Number(watcher.cycleCount) || 0}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherLastTick'))}: ${escapeHtml(watcher.lastTickAt || '-')} · ${escapeHtml(t('settings.watcherLastCycle'))}: ${escapeHtml(watcher.lastCycleAt || '-')}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherScheduleNext'))}: ${scheduleNextValueHtml(data.schedule, Date.now())}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherSnapshot'))}: ready=${Number(data.snapshot?.readyTodoCount) || 0} active=${Number(data.snapshot?.activeAgentCount) || 0} scout=${Number(data.snapshot?.scoutAgentCount) || 0} unknown=${Number(data.snapshot?.unknownAgentCount) || 0}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherStopReason'))}: ${escapeHtml(watcher.stopReason || '-')} · ${escapeHtml(t('settings.watcherBackoff'))}: ${escapeHtml(watcher.backoffUntil || '-')}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherActiveCycles'))}: ${escapeHtml(formatActiveCyclesSummary(watcher))}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherFindings'))}: hash=${escapeHtml(watcher.findings?.hash || '-')} streak=${Number(watcher.findings?.streak) || 0}</p>
  `;
}

/**
 * Schedule card for the Scout tab. `nextScanAt` is computed server-side from the
 * same eligibility gate the heartbeat uses, so the countdown cannot drift from
 * the real schedule. The countdown node is repainted per second by
 * `tickWatcherTimes` while the Scout tab is visible.
 *
 * @param {any} scout
 * @param {number} now
 * @returns {string}
 */
export function renderScoutScheduleHtml(scout = {}, now = Date.now()) {
  const enabled = scout.enabled === true;
  const nextScanAt = Number(scout.nextScanAt) || 0;
  let nextText;
  if (!enabled) {
    nextText = escapeHtml(t('settings.watcherScoutNotScheduled'));
  } else if (nextScanAt > now) {
    nextText = `<span data-watcher-countdown="${nextScanAt}">${escapeHtml(formatCountdown(nextScanAt, now))}</span>`
      + ` <span class="watcher-scout-abs">${escapeHtml(new Date(nextScanAt).toLocaleString())}</span>`;
  } else {
    nextText = escapeHtml(t('settings.watcherScoutDueNow'));
  }
  const blocked = String(scout.blockedReason || '').trim();
  const blockedHtml = blocked
    ? `<p class="cr-hint"><span class="watcher-badge" data-mode="paused">${escapeHtml(t('settings.watcherScoutBlocked'))}</span> ${escapeHtml(scoutReasonText(blocked))}</p>`
    : '';
  return ''
    + `<p class="cr-hint"><strong>${escapeHtml(t('settings.watcherScoutNextScan'))}:</strong> ${nextText}</p>`
    + `<p class="cr-hint">${escapeHtml(t('settings.watcherScoutLastScan'))}: ${escapeHtml(scout.lastScoutAt || '-')}</p>`
    + `<p class="cr-hint">${escapeHtml(t('settings.watcherScoutScansToday'))}: ${Number(scout.usedToday) || 0} / ${Number(scout.maxPerDay) || 0}`
    + ` · ${escapeHtml(t('settings.watcherScoutRemaining'))}: ${Number(scout.remainingToday) || 0}</p>`
    + `<p class="cr-hint">${escapeHtml(t('settings.watcherScoutRunning'))}: ${Number(scout.running) || 0} / ${Number(scout.maxParallel) || 1}`
    + ` · ${escapeHtml(t('settings.watcherScoutPending'))}: ${Number(scout.pendingFindings) || 0}</p>`
    + blockedHtml;
}

/** @param {any} runtime */
export function renderWatcherRuntimeControlHtml(runtime = {}) {
  const disabled = runtime.startsEnabled === false || (runtime.statusUnavailable && runtime.startsEnabled == null);
  let message;
  if (runtime.statusUnavailable) {
    message = t('settings.watcherRuntimeUnavailable');
  } else if (!disabled) {
    message = t('settings.watcherRuntimeEnabled');
  } else if (runtime.readyForRestart) {
    message = t('settings.watcherRuntimeReady');
  } else {
    message = `${t('settings.watcherRuntimeDraining')} · ${t('settings.watcherActiveCycles')}: ${Number(runtime.activeWatcherCycles) || 0} · ${t('settings.watcherScoutSection')}: ${Number(runtime.activeScoutScans) || 0}`;
  }
  return `<p class="cr-hint">${escapeHtml(t('settings.watcherRuntimeScope'))}</p>`
    + `<label class="cr-check"><input type="checkbox" id="watcher-runtime-disabled"${disabled ? ' checked' : ''}> ${escapeHtml(t('settings.watcherRuntimeDisable'))}</label>`
    + `<p id="watcher-runtime-status" class="cr-hint">${escapeHtml(message)}</p>`;
}

/**
 * Server load card: values from /api/health `load`, thresholds read-only
 * (configured through CRETLI_HEALTH_* env vars), breached alarms highlighted.
 *
 * @param {{
 *   thresholds?: Record<string, number | undefined>,
 *   alarms?: string[],
 *   children?: { total?: number, claude?: number, opencode?: number, mcp?: number, tests?: number },
 *   eventLoopLagMs?: { p50?: number, p99?: number },
 *   routeP95Ms?: number,
 *   disk?: { freeMb?: number | null },
 *   loadAvg?: number[],
 *   cpus?: number,
 *   lan?: { hosts?: string[], unreachable?: string[] },
 * } | null} load
 */
export function renderWatcherLoadHtml(load) {
  if (!load) return `<p class="cr-hint">${escapeHtml(t('settings.watcherLoadUnavailable'))}</p>`;
  const th = load.thresholds || {};
  const alarms = new Set(load.alarms || []);
  const c = load.children || {};
  const row = (labelKey, value, limit, alarmId) => `<li${alarms.has(alarmId) ? ' data-tone="error"' : ''}>${escapeHtml(t(labelKey))}: <strong>${escapeHtml(String(value))}</strong> <span class="cr-hint">${escapeHtml(t('settings.watcherLoadLimit'))} ${escapeHtml(String(limit))}</span></li>`;
  const lag = load.eventLoopLagMs || {};
  return `<ul class="watcher-list">`
    + row('settings.watcherLoadEventLoop', `${lag.p50} / ${lag.p99} ms`, `${th.eventLoopP99Ms} ms (p99)`, 'eventLoopP99')
    + row('settings.watcherLoadRouteP95', `${load.routeP95Ms} ms`, `${th.routeP95Ms} ms`, 'routeP95')
    + row('settings.watcherLoadChildren', `${c.total} (claude ${c.claude}, opencode ${c.opencode}, mcp ${c.mcp}, tests ${c.tests})`, th.childProcesses, 'childProcesses')
    + row('settings.watcherLoadDisk', load.disk?.freeMb == null ? '?' : `${load.disk.freeMb} MB`, `${th.minFreeDiskMb} MB (min)`, 'lowDisk')
    + row('settings.watcherLoadAvg', (load.loadAvg || []).join(' / '), `${th.loadAvgPerCpu} × ${load.cpus} CPU`, 'loadAvg')
    + (load.lan?.hosts?.length
      ? row('settings.watcherLoadLan', load.lan.unreachable?.length ? `${t('settings.watcherLoadLanDown')}: ${load.lan.unreachable.join(', ')}` : t('settings.watcherLoadLanUp'), load.lan.hosts.join(', '), 'lanUnreachable')
      : '')
    + `</ul><p class="cr-hint">${escapeHtml(t('settings.watcherLoadHint'))}</p>`;
}

/**
 * Render the audited workspace override list and its create form. The form
 * collects only intent; the server sets author/time and enforces the TTL.
 *
 * @param {(key: string, values?: any) => string} t
 * @returns {string}
 */
export function renderWorkspaceOverridesHtml(t) {
  const state = ws.workspaceOverridesState;
  const parts = ['<section class="watcher-section">'];
  parts.push(`<h4 class="watcher-section-title">${escapeHtml(t('harnessModelRole.overridesTitle'))}</h4>`);
  parts.push(`<p class="cr-hint">${escapeHtml(t('harnessModelRole.overridesHint'))}</p>`);
  if (state.error) {
    parts.push(`<p class="message" data-tone="error">${escapeHtml(state.error)}</p>`);
  }
  if (state.overrides.length === 0) {
    parts.push(`<p class="cr-hint">${escapeHtml(t('harnessModelRole.overridesEmpty'))}</p>`);
  } else {
    parts.push('<ul class="harness-model-override-list">');
    for (const row of state.overrides) {
      const active = !row.revokedAt && Date.parse(row.expiresAt) > Date.now();
      const target = [row.targetHarness, row.targetModel, row.targetRole].filter(Boolean).join(' / ') || '—';
      parts.push(`<li data-override-id="${escapeAttr(row.id)}">`
        + `<span class="harness-model-role-badge" data-tone="${active ? 'active' : 'revoked'}">${escapeHtml(active ? t('harnessModelRole.overridesActive') : t('harnessModelRole.overridesRevoked'))}</span>`
        + `<strong>${escapeHtml(row.action)}</strong> ${escapeHtml(target)} `
        + `<span class="cr-hint">${escapeHtml(row.reason)}</span>`
        + (active ? `<button type="button" class="cr-bar-button" data-watcher-override-revoke="${escapeAttr(row.id)}">${escapeHtml(t('harnessModelRole.overridesRevoke'))}</button>` : '')
        + '</li>');
    }
    parts.push('</ul>');
  }
  parts.push('<div class="watcher-grid">');
  parts.push(`<label class="cr-field"><span class="cr-field-label">${escapeHtml(t('harnessModelRole.overridesAction'))}</span>`
    + '<select data-watcher-override-field="action">'
    + `<option value="prefer">${escapeHtml(t('harnessModelRole.overridesPrefer'))}</option>`
    + `<option value="exclude" selected>${escapeHtml(t('harnessModelRole.overridesExclude'))}</option>`
    + `<option value="explicit-orchestrator">${escapeHtml(t('harnessModelRole.overridesExplicit'))}</option>`
    + '</select></label>');
  parts.push(`<label class="cr-field"><span class="cr-field-label">${escapeHtml(t('harnessModelRole.overridesTargetHarness'))}</span>`
    + '<input type="text" data-watcher-override-field="targetHarness"></label>');
  parts.push(`<label class="cr-field"><span class="cr-field-label">${escapeHtml(t('harnessModelRole.overridesTargetModel'))}</span>`
    + '<input type="text" data-watcher-override-field="targetModel"></label>');
  parts.push(`<label class="cr-field"><span class="cr-field-label">${escapeHtml(t('harnessModelRole.overridesReason'))}</span>`
    + '<input type="text" data-watcher-override-field="reason"></label>');
  parts.push(`<label class="cr-field"><span class="cr-field-label">${escapeHtml(t('harnessModelRole.overridesTtlHours'))}</span>`
    + '<input type="number" min="1" max="720" step="1" value="24" data-watcher-override-field="ttlHours"></label>');
  parts.push('</div>');
  parts.push(`<div class="cr-row"><button type="button" class="cr-bar-button" data-watcher-override-create>${escapeHtml(t('harnessModelRole.overridesCreate'))}</button>`
    + `<button type="button" class="cr-bar-button" data-watcher-override-reset>${escapeHtml(t('harnessModelRole.reset'))}</button></div>`);
  parts.push('</section>');
  return parts.join('');
}

/**
 * @returns {any}
 */
export function restoreView() {
  const meta = ws.scoutEditorState.restoreMeta || {};
  return {
    diff: ws.scoutEditorState.restoreDiff,
    templateId: meta.templateId || '',
    templateVersion: meta.templateVersion || '',
    templateName: meta.templateName || '',
    scoutId: String(meta.scoutId || ws.scoutEditorState.selectedId || '').trim(),
    error: ws.scoutEditorState.restoreError,
    busy: ws.scoutEditorState.busy,
  };
}
