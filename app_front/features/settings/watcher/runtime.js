/**
 * Tabs, the per-second countdown ticker and runtime-control polling.
 */

import { ws } from './store.js';
import { formatCountdown, formatDuration } from '../../watcher/watcherDashboard.js';
import { cretliApiFetch } from '../../../lib/cretliApiRequest.js';
import { watcherApi } from './api.js';
import { refreshWorkspaceWatcherSettingsPanel } from './refresh.js';
import { t } from '../../../i18n/index.js';
import { WATCHER_SETTINGS_TAB, WATCHER_TABS } from './constants.js';
import { queryField, queryFields } from './format.js';

/**
 * Whether the dashboard is actually on screen. The settings watcher `<section>`
 * is `hidden` when another tab is active, and a hidden subtree reports a null
 * `offsetParent`; a detached container is never visible. Both cases mean the
 * ticker is doing invisible work and should stop.
 *
 * @param {HTMLElement | null} container
 * @returns {boolean}
 */
export function dashboardIsVisible(container) {
  return !!container && container.isConnected && container.offsetParent !== null;
}

/** Start the per-second ticker once. A hidden monitoring tab must not restart it. */
export function ensureWatcherTicker(root) {
  if (ws.dashTimer) return;
  const timer = /** @type {any} */ (setInterval(() => tickWatcherTimes(root), 1000));
  if (typeof timer.unref === 'function') timer.unref();
  ws.dashTimer = timer;
}

/** Clear the per-second repaint timer so a hidden/unmounted panel stops. */
export function stopWatcherTicker() {
  if (ws.dashTimer) {
    clearInterval(ws.dashTimer);
    ws.dashTimer = null;
  }
}

/**
 * Lightweight per-second repaint of only the time-driven fields (backoff and
 * quiet-hours countdowns, running-cycle durations). This avoids refetching the
 * whole view every second while keeping the dashboard honest about elapsed time.
 * When the dashboard is hidden or detached it stops the ticker instead of
 * spinning forever in the background.
 *
 * @param {HTMLElement} root
 */
export function tickWatcherTimes(root) {
  const container = queryField(root, '#watcher-dashboard');
  const scoutSchedule = queryField(root, '#watcher-scout-schedule-info');
  const statusCard = queryField(root, '#watcher-status-card');
  const scheduleInfo = queryField(root, '#watcher-schedule-info');
  const scoutProfiles = queryField(root, '#watcher-scout-profiles');
  // Any countdown surface keeps the ticker alive; when none is on screen
  // (a hidden tab, a detached panel) the ticker stops instead of spinning.
  if (!dashboardIsVisible(container) && !dashboardIsVisible(scoutSchedule)
    && !dashboardIsVisible(statusCard)
    && !dashboardIsVisible(scoutProfiles)
    && !dashboardIsVisible(scheduleInfo)) {
    stopWatcherTicker();
    return;
  }
  if (Date.now() - ws.lastRuntimePollAt >= 5_000) void refreshWatcherRuntimeControl(root);
  const now = Date.now();
  for (const node of queryFields(root, '[data-watcher-countdown]')) {
    const until = Number(node.getAttribute('data-watcher-countdown'));
    if (!Number.isFinite(until)) continue;
    node.textContent = formatCountdown(until, now);
  }
  for (const node of queryFields(root, '[data-watcher-duration]')) {
    const started = Number(node.getAttribute('data-watcher-duration'));
    if (!Number.isFinite(started) || started <= 0) continue;
    node.textContent = formatDuration(now - started);
  }
}

/** @returns {string} */
export function activeWatcherTab() {
  return WATCHER_TABS.includes(ws.tab) ? ws.tab : 'status';
}

/**
 * @param {string} id
 * @returns {string}
 */
export function watcherPanelAttrs(id) {
  const on = activeWatcherTab() === id;
  return `id="watcher-panel-${id}" class="watcher-tab-panel cr-form" data-watcher-panel="${id}"${on ? '' : ' hidden'}`;
}

/**
 * Show one section and keep the others mounted, so an unsaved policy edit
 * survives a tab change and a live dashboard update.
 *
 * @param {HTMLElement} root
 */
export function applyWatcherTab(root) {
  const tab = activeWatcherTab();
  for (const panel of queryFields(root, '[data-watcher-panel]')) {
    panel.hidden = panel.getAttribute('data-watcher-panel') !== tab;
  }
  const savebar = queryField(root, '#watcher-savebar');
  if (savebar) savebar.hidden = tab !== 'settings' && tab !== 'scout';
  // The monitoring dashboard, the Scout schedule card and the cycle schedule
  // card all render a live countdown, so the per-second ticker follows them.
  if (tab === 'monitor' || tab === 'scout' || tab === 'status') {
    ensureWatcherTicker(root);
    tickWatcherTimes(root);
  } else {
    stopWatcherTicker();
  }
}

/** Read the settings-nav sub-tab into the panel state. */
export function syncWatcherTabFromSettings() {
  const settingsTab = document.getElementById('settings-panel')?.dataset.activeSettingsTab || '';
  const next = WATCHER_SETTINGS_TAB[settingsTab];
  if (next && next !== ws.tab) ws.tab = next;
}

/** Fetch the server load card (`/api/health`) into the store. */
export async function loadWatcherLoad() {
  let load = null;
  try {
    const res = await cretliApiFetch('/api/health', { credentials: 'include' });
    load = (await res.json())?.load || null;
  } catch {
    load = null;
  }
  ws.loadMetrics = { loaded: true, load };
}

/** Refresh the global drain count without rebuilding the editable settings form. */
export async function refreshWatcherRuntimeControl(root) {
  if (ws.runtimePollInFlight || !ws.lastView) return;
  ws.runtimePollInFlight = true;
  ws.lastRuntimePollAt = Date.now();
  try {
    const res = await watcherApi('/api/workspace-watcher/runtime-control');
    if (!res.json?.ok || !root.isConnected || !ws.lastView) return;
    ws.runtimeControl = res.json.runtimeControl || { statusUnavailable: true };
  } catch {
    // A transient status fetch failure must not interrupt the dashboard timer.
  } finally {
    ws.runtimePollInFlight = false;
  }
}

/**
 * Wire the "disable starts" checkbox of the runtime-control region. The region
 * replaces its nodes on every render, so the listener is bound to the fresh
 * checkbox each time and never accumulates.
 *
 * @param {HTMLElement} panel
 */
export function bindRuntimeToggle(panel) {
  const toggle = /** @type {HTMLInputElement | null} */ (panel.querySelector('#watcher-runtime-disabled'));
  toggle?.addEventListener('change', async () => {
    toggle.disabled = true;
    const checkedBefore = toggle.checked;
    const restore = (message) => {
      const liveToggle = /** @type {HTMLInputElement | null} */ (panel.querySelector('#watcher-runtime-disabled'));
      if (liveToggle) liveToggle.checked = !checkedBefore;
      const status = panel.querySelector('#watcher-runtime-status');
      if (status) status.textContent = message;
    };
    try {
      const res = await watcherApi('/api/workspace-watcher/runtime-control', {
        method: 'PATCH',
        body: { startsEnabled: !toggle.checked },
      });
      if (!res.json?.ok) {
        restore(res.json?.error || t('settings.watcherActionError'));
        return;
      }
      await refreshWorkspaceWatcherSettingsPanel({ full: false });
    } catch {
      restore(t('settings.watcherActionError'));
    } finally {
      const liveToggle = /** @type {HTMLInputElement | null} */ (panel.querySelector('#watcher-runtime-disabled'));
      if (liveToggle) liveToggle.disabled = false;
    }
  });
}
