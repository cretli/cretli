/**
 * Settings → Workspace Watcher.
 *
 * One deterministic guard per workspace. The UI is intentionally explicit: the
 * operator picks off/observe/autopilot, tunes the guardrails, and can nudge the
 * watcher (tick / run cycle / claim next) without turning on autopilot.
 */

import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getWorkspaceWatcherView, isWorkspaceWatcherRead } from '../watcher/watcherGetCoalesce.js';
import { getCurrentLang } from '../../i18n/index.js';
import {
  renderWatcherLiveHtml,
  renderWatcherStatsHtml,
  renderWatcherDecisionsHtml,
  renderWatcherAlertsHtml,
  formatCountdown,
  formatDuration,
} from '../watcher/watcherDashboard.js';
import { renderWatcherTimelineHtml, WATCHER_TIMELINE_RANGES } from '../watcher/watcherTimeline.js';
import {
  getWatcherWorkspaceFolder,
  scopeWatcherRequestToWorkspace,
  watcherWorkspaceScopeChanged,
} from '../watcher/watcherWorkspaceScope.js';
import './workspace-watcher-settings.scss';

const MODES = ['off', 'observe', 'autopilot'];
const PICK_ROLES = ['plan', 'implement', 'review'];
/** Scout categories — must match `WORKSPACE_SCOUT_CATEGORIES` on the server so
 *  the checkboxes and the closed-set allow-list never drift. */
const SCOUT_CATEGORIES = ['bug', 'improvement', 'refactor', 'security', 'opportunity', 'documentation'];
/** Cooldown slider bounds in ms. The persisted default is 30s (see below), so
 *  the slider spans a practical 0–15 min band in 30s steps. */
const COOLDOWN_MIN_MS = 0;
const COOLDOWN_MAX_MS = 15 * 60_000;
const COOLDOWN_STEP_MS = 30_000;
/**
 * Client mirror of `defaultWorkspaceWatcherPolicy()` on the server, used only by
 * the "Reset to defaults" action. It is kept aligned with the server default
 * (cooldown 30s) so a reset followed by a refetch never jumps: the editor and
 * the newly-created watcher row must agree end-to-end.
 */
const DEFAULT_POLICY = {
  maxParallel: 1,
  maxCyclesPerDay: 20,
  maxConsecutiveFailures: 3,
  maxSameFindings: 2,
  cooldownMs: 30_000,
  backoffBaseMs: 60_000,
  backoffCapMs: 6 * 60 * 60_000,
  requirePlanApproval: true,
  planApprovalScope: 'leaf',
  allowedHarnesses: [],
  pickRoles: [...PICK_ROLES],
  quietHours: { start: '', end: '' },
  scoutEnabled: false,
  scoutMaxParallel: 1,
  scoutMaxPerDay: 4,
  scoutIntervalHours: 6,
  scoutAutoCreate: false,
  scoutAllowedHarnesses: [],
  scoutCategories: [...SCOUT_CATEGORIES],
  orchestrator: { harness: '', model: '' },
};
/**
 * Harness catalog rows (id + label) fetched with the full render so the
 * "Allowed harnesses" checkboxes can be built synchronously. An empty list
 * degrades to the already-saved ids, never a blank control.
 * @type {{ id: string, label: string }[]}
 */
let harnessOptions = [];

/** Dashboard-local UI state. Kept module-scoped so range/filter/selection
 *  survive the innerHTML repaints without ever re-fetching from the server. */
const WATCHER_TABS = ['status', 'monitor', 'settings', 'scout', 'actions'];
/** Settings-nav sub-tab id → panel id. The bar lives in the settings header,
 *  the same place as the Harness and App sub-tabs. */
const WATCHER_SETTINGS_TAB = {
  watcher: 'status',
  'watcher-monitor': 'monitor',
  'watcher-settings': 'settings',
  'watcher-scout': 'scout',
  'watcher-actions': 'actions',
};
const dashState = {
  range: '24h',
  decisionsFilter: 'all',
  selectedCycleId: '',
  tab: 'status',
};
/** @type {object | null} */
let lastView = null;
/** Workspace folder the mounted form was rendered for. A live refresh for a
 *  different folder would otherwise repaint the status card while the form still
 *  edits the previous workspace. Empty until the first full render. */
let renderedWorkspaceFolder = '';
/** @type {object | null} */
let lastStats = null;
/** @type {ReturnType<typeof setInterval> | null} */
let dashTimer = null;
let runtimePollInFlight = false;
let lastRuntimePollAt = 0;
/** Todo id → title for the live cycle rows. Fetched with the stats; an empty
 *  map degrades to the short id, never a blank label. */
let todoTitles = new Map();
/** Monotonic refresh generation. A live event and a save can overlap; when a
 *  fetch resolves it must check that no newer refresh started, or an older
 *  response would overwrite fresher state. */
let refreshSeq = 0;
/** Bumped every time `lastView` is replaced (a refresh result or an optimistic
 *  save). An optimistic-save rollback only restores its snapshot while the
 *  cache still holds that same generation, so a newer refresh always wins. */
let viewSeq = 0;

/**
 * @param {string} id
 * @returns {string}
 */
function getTodoTitle(id) {
  return todoTitles.get(String(id || '').trim()) || '';
}

/**
 * Open a chat from a dashboard link. The settings chunk does not statically own
 * the chat module, so it is imported lazily on click; a failure to load or a
 * chat that no longer exists is swallowed (the link is a convenience).
 *
 * @param {string} chatId
 */
async function openWatcherChat(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  try {
    const mod = await import('../../chat.js');
    if (typeof mod.selectChat === 'function') mod.selectChat(id);
  } catch {
    // Chat module unavailable — leave the settings panel as-is.
  }
}

/**
 * @param {object | null | undefined} watcher
 * @returns {string}
 */
function formatActiveCyclesSummary(watcher) {
  const cycles = Array.isArray(watcher?.activeCycles) && watcher.activeCycles.length
    ? watcher.activeCycles
    : (watcher?.activeCycle ? [watcher.activeCycle] : []);
  if (!cycles.length) return '-';
  return cycles.map((cycle) => (
    `${String(cycle.cycleId || '').slice(0, 8)} · chat ${String(cycle.chatId || '').slice(0, 8)}`
  )).join('; ');
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function watcherApi(path, options = {}) {
  // Every watcher call is workspace-scoped: without an explicit folder the
  // server answers for its own "current cwd", which can be a different
  // workspace than the one the operator opened Settings for.
  const scoped = scopeWatcherRequestToWorkspace(path, options, getWatcherWorkspaceFolder());
  if (isWorkspaceWatcherRead(scoped.path, scoped.options)) return getWorkspaceWatcherView(scoped.path);
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (scoped.options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers,
    credentials: 'include',
    body: scoped.options.body !== undefined ? JSON.stringify(scoped.options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

export function initWorkspaceWatcherSettingsPanel() {
  const root = document.getElementById('settings-watcher-root');
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  window.addEventListener('cretli:workspace-watcher-changed', () => {
    const panel = document.getElementById('settings-watcher-root');
    if (!panel || panel.dataset.bound !== 'true') return;
    // A live change must not rebuild the form (that would erase unsaved policy
    // edits); repaint only the dashboard subroot.
    void refreshWorkspaceWatcherSettingsPanel({ full: false });
  });
  // Switching the active workspace changes which watcher row the form edits.
  // Leaving the previous workspace's policy on screen is one Save away from
  // writing it to the wrong workspace, so a switch rebuilds the form. While the
  // watcher settings pane is hidden the refresh is deferred to the next open
  // (see `syncWorkspaceWatcherSettingsTab`).
  const refreshOnActiveWorkspaceChange = () => {
    const panel = document.getElementById('settings-watcher-root');
    if (!panel || panel.dataset.bound !== 'true' || panel.dataset.rendered !== 'true') return;
    if (!watcherWorkspaceScopeChanged(renderedWorkspaceFolder)) return;
    const section = document.querySelector('.settings-section[data-settings-tab="watcher"]');
    if (section && section.hidden) return;
    void refreshWorkspaceWatcherSettingsPanel();
  };
  window.addEventListener('cretli-active-workspace-changed', refreshOnActiveWorkspaceChange);
  window.addEventListener('cretli-workspace-updated', refreshOnActiveWorkspaceChange);
  window.addEventListener('cr-lang-changed', () => {
    const panel = document.getElementById('settings-watcher-root');
    if (!panel || panel.dataset.bound !== 'true') return;
    paintWatcherDashboard(panel);
    paintWatcherRuntimeControl(panel);
    paintScoutSchedule(panel);
  });
  // The per-second ticker is pure background work while the document is hidden;
  // stop it and let the next visible refresh rebind it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopWatcherTicker();
  });
  void refreshWorkspaceWatcherSettingsPanel();
}

export async function refreshWorkspaceWatcherSettingsPanel(options = {}) {
  const root = document.getElementById('settings-watcher-root');
  if (!root) return;
  // Until the panel has rendered its form once, force a full render even for a
  // "live" call, so a change event that races the initial load can't leave the
  // form unmounted (the superseded full render would otherwise be dropped). A
  // workspace switch also forces the full path: the live path must never leave
  // the previous workspace's policy editable.
  const full = options.full !== false
    || root.dataset.rendered !== 'true'
    || watcherWorkspaceScopeChanged(renderedWorkspaceFolder);
  const seq = ++refreshSeq;
  if (full) root.innerHTML = `<p class="settings-hint">${escapeHtml(t('settings.watcherLoading'))}</p>`;
  // The harness catalog is only needed to build the form (full path); fetch it
  // alongside the watcher view so the checkbox list renders synchronously.
  const [res, catalog, runtime] = await Promise.all([
    watcherApi('/api/workspace-watcher'),
    full ? watcherApi('/api/harness-catalog/harnesses') : Promise.resolve(null),
    watcherApi('/api/workspace-watcher/runtime-control'),
  ]);
  // A newer refresh (a save, or another live event) already owns the paint.
  if (seq !== refreshSeq) return;
  if (catalog?.json?.ok && Array.isArray(catalog.json.items)) {
    harnessOptions = catalog.json.items
      .map((row) => ({ id: String(row?.id ?? '').trim(), label: String(row?.label ?? row?.id ?? '').trim() }))
      .filter((row) => row.id);
  }
  if (!res.json?.ok) {
    if (full) root.innerHTML = `<p class="message" data-tone="error">${escapeHtml(res.json?.error || t('settings.watcherLoadError'))}</p>`;
    return;
  }
  lastView = {
    ...res.json,
    runtimeControl: runtime?.json?.runtimeControl || { statusUnavailable: true },
  };
  viewSeq += 1;
  // Only the full path rebuilds the root (form + status card + dashboard
  // container). The live path leaves the operator's form untouched.
  if (full) {
    renderWatcherPanel(root, lastView);
    root.dataset.rendered = 'true';
    renderedWorkspaceFolder = String(res.json.workspaceFolder || res.json.cwd || '').trim();
  } else {
    paintWatcherRuntimeControl(root);
  }
  // The dashboard is additive: a stats/todos failure degrades to "no data" /
  // short ids, it must never blank out the already-rendered status/form.
  await Promise.all([loadWatcherStats(seq), loadTodoTitles(seq)]);
  if (seq !== refreshSeq) return;
  const container = root.querySelector('#watcher-dashboard');
  if (!container) return;
  paintWatcherDashboard(root);
}

/**
 * Fetch the workspace todo titles once per refresh so active cycles render a
 * human title next to the id. A failure keeps the previous map.
 */
async function loadTodoTitles(seq) {
  try {
    const res = await watcherApi('/api/todos');
    if (seq != null && seq !== refreshSeq) return;
    const items = Array.isArray(res.json?.items) ? res.json.items : [];
    const next = new Map();
    for (const item of items) {
      const id = String(item?.id || '').trim();
      if (!id) continue;
      next.set(id, String(item?.title || '').trim());
    }
    todoTitles = next;
  } catch {
    // Keep whatever we had.
  }
}

/**
 * Fetch the aggregated monitoring stats into `lastStats`. Errors leave the
 * previous value so a transient failure does not empty the dashboard. A stale
 * (superseded) response is dropped so it cannot overwrite fresher state.
 */
async function loadWatcherStats(seq) {
  try {
    const res = await watcherApi('/api/workspace-watcher/stats');
    if (seq != null && seq !== refreshSeq) return;
    if (res.json?.ok) lastStats = res.json;
  } catch {
    // Keep whatever we had.
  }
}

const CLOCK_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * Whether a stored quiet-hours pair reads back as "enabled" — both bounds must
 * be well-formed HH:MM. The server has no `enabled` flag: an empty/invalid pair
 * already means "no quiet window" in the guardrails, so the toggle is derived
 * from the values rather than a separate persisted field.
 *
 * @param {{ start?: unknown, end?: unknown }} [quiet]
 * @returns {boolean}
 */
function quietHoursActive(quiet) {
  const start = String(quiet?.start ?? '').trim();
  const end = String(quiet?.end ?? '').trim();
  return CLOCK_RE.test(start) && CLOCK_RE.test(end) && start !== end;
}

/**
 * Render a cooldown duration in ms as the unit the slider trades in: seconds
 * under a minute, otherwise minutes (one decimal, trailing zero trimmed).
 *
 * @param {number} ms
 * @returns {string}
 */
function formatCooldownLabel(ms) {
  const value = Number(ms) || 0;
  if (value < 60_000) {
    // The slider stores seconds as milliseconds, so sub-minute values must be
    // divided down; rendering the raw ms value produced "30000 s".
    const seconds = value / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} ${t('settings.watcherSecondUnit')}`;
  }
  const minutes = value / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} ${t('settings.watcherMinuteUnit')}`;
}

/**
 * The status card is isolated from the editable form so a live watcher change or
 * an optimistic save can repaint it without rebuilding the form below (which
 * would drop unsaved edits).
 *
 * @param {object} data
 * @returns {string}
 */
function renderWatcherStatusCardHtml(data) {
  const watcher = data.watcher || {};
  return `
    <div class="cr-row watcher-status-row">
      <span class="watcher-badge" data-mode="${escapeAttr(watcher.mode || 'off')}">${escapeHtml(String(watcher.mode || 'off').toUpperCase())}</span>
      <span class="cr-hint">${escapeHtml(t('settings.watcherGuardrail'))}: <strong>${escapeHtml(data.guardrails?.kind || '-')}</strong> (${escapeHtml(data.guardrails?.reason || '-')})</span>
      ${watcher.paused ? `<span class="watcher-badge" data-mode="paused">${escapeHtml(t('settings.watcherPausedBadge'))}</span>` : ''}
    </div>
    <p class="cr-hint">${escapeHtml(t('settings.watcherCyclesToday'))}: ${Number(data.guardrails?.usedToday) || 0} / ${Number(data.guardrails?.maxCyclesPerDay) || 0} · ${escapeHtml(t('settings.watcherCyclesTotal'))}: ${Number(watcher.cycleCount) || 0}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherLastTick'))}: ${escapeHtml(watcher.lastTickAt || '-')} · ${escapeHtml(t('settings.watcherLastCycle'))}: ${escapeHtml(watcher.lastCycleAt || '-')}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherSnapshot'))}: ready=${Number(data.snapshot?.readyTodoCount) || 0} active=${Number(data.snapshot?.activeAgentCount) || 0} scout=${Number(data.snapshot?.scoutAgentCount) || 0} unknown=${Number(data.snapshot?.unknownAgentCount) || 0}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherStopReason'))}: ${escapeHtml(watcher.stopReason || '-')} · ${escapeHtml(t('settings.watcherBackoff'))}: ${escapeHtml(watcher.backoffUntil || '-')}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherActiveCycles'))}: ${escapeHtml(formatActiveCyclesSummary(watcher))}</p>
    <p class="cr-hint">${escapeHtml(t('settings.watcherFindings'))}: hash=${escapeHtml(watcher.findings?.hash || '-')} streak=${Number(watcher.findings?.streak) || 0}</p>
  `;
}

/**
 * Human label for a Scout block reason (`scan_interval`, `daily_budget`, …).
 * Falls back to the raw server reason when the dictionary has no entry yet.
 *
 * @param {unknown} reason
 * @returns {string}
 */
function scoutReasonText(reason) {
  const key = String(reason || '').trim();
  if (!key) return '';
  const i18nKey = `settings.watcherScoutReason_${key}`;
  const text = t(i18nKey);
  return text === i18nKey ? key : text;
}

/**
 * Schedule card for the Scout tab. `nextScanAt` is computed server-side from the
 * same eligibility gate the heartbeat uses, so the countdown cannot drift from
 * the real schedule. The countdown node is repainted per second by
 * `tickWatcherTimes` while the Scout tab is visible.
 *
 * @param {object} scout
 * @param {number} now
 * @returns {string}
 */
function renderScoutScheduleHtml(scout = {}, now = Date.now()) {
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

/**
 * Repaint only the Scout schedule card from the cached view. No-op on the paths
 * where the Scout tab was never rendered.
 *
 * @param {HTMLElement} root
 */
function paintScoutSchedule(root) {
  const node = root.querySelector('#watcher-scout-schedule-info');
  if (!node || !lastView) return;
  node.innerHTML = renderScoutScheduleHtml(lastView.scout || {}, Date.now());
}

/** @param {object} runtime */
function renderWatcherRuntimeControlHtml(runtime = {}) {
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

/** @param {HTMLElement} root */
function paintWatcherRuntimeControl(root) {
  const panel = root.querySelector('#watcher-runtime-control');
  if (!panel || !lastView) return;
  panel.innerHTML = `<h4 class="watcher-section-title">${escapeHtml(t('settings.watcherRuntimeTitle'))}</h4>${renderWatcherRuntimeControlHtml(lastView.runtimeControl || {})}`;
  const toggle = panel.querySelector('#watcher-runtime-disabled');
  toggle?.addEventListener('change', async () => {
    toggle.disabled = true;
    const res = await watcherApi('/api/workspace-watcher/runtime-control', {
      method: 'PATCH',
      body: { startsEnabled: !toggle.checked },
    });
    if (!res.json?.ok) {
      toggle.checked = !toggle.checked;
      const status = panel.querySelector('#watcher-runtime-status');
      if (status) status.textContent = res.json?.error || t('settings.watcherActionError');
      toggle.disabled = false;
      return;
    }
    await refreshWorkspaceWatcherSettingsPanel({ full: false });
  });
}

/** Refresh the global drain count without rebuilding the editable settings form. */
async function refreshWatcherRuntimeControl(root) {
  if (runtimePollInFlight || !lastView) return;
  runtimePollInFlight = true;
  lastRuntimePollAt = Date.now();
  try {
    const res = await watcherApi('/api/workspace-watcher/runtime-control');
    if (!res.json?.ok || !root.isConnected || !lastView) return;
    lastView = { ...lastView, runtimeControl: res.json.runtimeControl || { statusUnavailable: true } };
    paintWatcherRuntimeControl(root);
  } catch {
    // A transient status fetch failure must not interrupt the dashboard timer.
  } finally {
    runtimePollInFlight = false;
  }
}

/**
 * Repaint only the status card from the cached view (used by the live path and
 * by an optimistic save). No-op when the panel has not rendered the form yet.
 *
 * @param {HTMLElement} root
 */
function paintWatcherStatusCard(root) {
  const card = root.querySelector('#watcher-status-card');
  if (!card || !lastView) return;
  card.innerHTML = renderWatcherStatusCardHtml(lastView);
}

/** @returns {string} */
function activeWatcherTab() {
  return WATCHER_TABS.includes(dashState.tab) ? dashState.tab : 'status';
}

/** Read the settings-nav sub-tab into the panel state. */
function syncWatcherTabFromSettings() {
  const settingsTab = document.getElementById('settings-panel')?.dataset.activeSettingsTab || '';
  const next = WATCHER_SETTINGS_TAB[settingsTab];
  if (next) dashState.tab = next;
}

/**
 * @param {string} id
 * @returns {string}
 */
function watcherPanelAttrs(id) {
  const on = activeWatcherTab() === id;
  return `id="watcher-panel-${id}" class="watcher-tab-panel" data-watcher-panel="${id}"${on ? '' : ' hidden'}`;
}

/**
 * Show one section and keep the others mounted, so an unsaved policy edit
 * survives a tab change and a live dashboard repaint.
 *
 * @param {HTMLElement} root
 */
function applyWatcherTab(root) {
  const tab = activeWatcherTab();
  dashState.tab = tab;
  for (const panel of root.querySelectorAll('[data-watcher-panel]')) {
    panel.hidden = panel.getAttribute('data-watcher-panel') !== tab;
  }
  const savebar = root.querySelector('#watcher-savebar');
  if (savebar) savebar.hidden = tab !== 'settings' && tab !== 'scout';
  // Both the monitoring dashboard and the Scout schedule card render a live
  // countdown, so the per-second ticker follows either of them.
  if (tab === 'monitor' || tab === 'scout') {
    ensureWatcherTicker(root);
    tickWatcherTimes(root);
  } else {
    stopWatcherTicker();
  }
}

/** Follow the settings-nav sub-tab without rebuilding the form. */
export function syncWorkspaceWatcherSettingsTab() {
  const root = document.getElementById('settings-watcher-root');
  if (!root || root.dataset.rendered !== 'true') return;
  // The active workspace may have moved while the pane was hidden (the change
  // event is skipped there); re-open on a full refresh instead of showing the
  // previous workspace's policy.
  if (watcherWorkspaceScopeChanged(renderedWorkspaceFolder)) {
    void refreshWorkspaceWatcherSettingsPanel();
    return;
  }
  syncWatcherTabFromSettings();
  applyWatcherTab(root);
}

/**
 * @param {HTMLElement} root
 * @param {object} data
 */
function renderWatcherPanel(root, data) {
  const watcher = data.watcher || {};
  const policy = watcher.policy || {};
  const quiet = policy.quietHours || {};
  const orchestrator = policy.orchestrator || {};
  const quietEnabled = quietHoursActive(quiet);
  const roleChecks = PICK_ROLES.map((role) => (
    `<label class="cr-check"><input type="checkbox" data-pick-role="${role}"${(policy.pickRoles || []).includes(role) ? ' checked' : ''}> ${escapeHtml(role)}</label>`
  )).join('');
  const modeRadios = MODES.map((mode) => (
    `<label class="cr-check watcher-mode-radio"><input type="radio" name="watcher-mode" value="${mode}"${watcher.mode === mode ? ' checked' : ''}> ${escapeHtml(t(`settings.watcherMode_${mode}`))}</label>`
  )).join('');
  // Cooldown slider: extend the max so an unusually large saved value never
  // gets silently lowered when the operator saves without touching the control.
  const cooldownMs = Number(policy.cooldownMs) || 0;
  const cooldownMax = Math.max(COOLDOWN_MAX_MS, Math.ceil(cooldownMs / COOLDOWN_STEP_MS) * COOLDOWN_STEP_MS);
  // Harness checkboxes come from the catalog, with any already-allowed id the
  // catalog no longer lists appended so a save can never silently drop it.
  const allowedHarnesses = Array.isArray(policy.allowedHarnesses) ? policy.allowedHarnesses.map(String) : [];
  const scoutAllowedHarnesses = Array.isArray(policy.scoutAllowedHarnesses) && policy.scoutAllowedHarnesses.length
    ? policy.scoutAllowedHarnesses.map(String)
    : allowedHarnesses;
  const seenHarness = new Set();
  const harnessRows = [];
  for (const opt of harnessOptions) {
    if (!opt.id || seenHarness.has(opt.id)) continue;
    seenHarness.add(opt.id);
    harnessRows.push({ id: opt.id, label: opt.label || opt.id });
  }
  for (const id of [...allowedHarnesses, ...scoutAllowedHarnesses]) {
    if (!id || seenHarness.has(id)) continue;
    seenHarness.add(id);
    harnessRows.push({ id, label: id });
  }
  const harnessChecks = harnessRows.length
    ? harnessRows.map((row) => (
      `<label class="cr-check"><input type="checkbox" data-harness="${escapeAttr(row.id)}"${allowedHarnesses.includes(row.id) ? ' checked' : ''}> ${escapeHtml(row.label)}</label>`
    )).join('')
    : `<span class="cr-hint">${escapeHtml(t('settings.watcherNoHarnesses'))}</span>`;
  const scoutHarnessChecks = harnessRows.length
    ? harnessRows.map((row) => (
      `<label class="cr-check"><input type="checkbox" data-scout-harness="${escapeAttr(row.id)}"${scoutAllowedHarnesses.includes(row.id) ? ' checked' : ''}> ${escapeHtml(row.label)}</label>`
    )).join('')
    : `<span class="cr-hint">${escapeHtml(t('settings.watcherNoHarnesses'))}</span>`;
  const scoutCats = Array.isArray(policy.scoutCategories) && policy.scoutCategories.length
    ? policy.scoutCategories.map(String)
    : SCOUT_CATEGORIES;
  const scoutCatChecks = SCOUT_CATEGORIES.map((cat) => (
    `<label class="cr-check"><input type="checkbox" data-scout-category="${cat}"${scoutCats.includes(cat) ? ' checked' : ''}> ${escapeHtml(t(`settings.watcherCat_${cat}`))}</label>`
  )).join('');
  const scoutInterval = Math.min(24, Math.max(1, Math.round(Number(policy.scoutIntervalHours) || DEFAULT_POLICY.scoutIntervalHours)));
  const decisions = Array.isArray(watcher.decisions) ? watcher.decisions.slice(-10).reverse() : [];
  const decisionRows = decisions.length === 0
    ? `<li class="settings-hint">${escapeHtml(t('settings.watcherNoDecisions'))}</li>`
    : decisions.map((d) => (
      `<li><code>${escapeHtml(d.at || '')}</code> <strong>${escapeHtml(d.kind || '')}</strong> · ${escapeHtml(d.reason || '')} · ready=${Number(d.readyTodoCount) || 0} active=${Number(d.activeAgentCount) || 0}</li>`
    )).join('');
  const failures = watcher.failures && Object.keys(watcher.failures).length
    ? Object.entries(watcher.failures).map(([id, n]) => `<li>${escapeHtml(String(id).slice(0, 8))}: ${Number(n) || 0}</li>`).join('')
    : `<li class="settings-hint">${escapeHtml(t('settings.watcherNone'))}</li>`;
  const planRequests = Object.entries(watcher.planRequests || {})
    .map(([id, at]) => `<li>${escapeHtml(String(id).slice(0, 8))} · ${escapeHtml(String(at))}</li>`).join('')
    || `<li class="settings-hint">${escapeHtml(t('settings.watcherNone'))}</li>`;
  const workspaceFolder = String(data.workspaceFolder || data.cwd || watcher.workspaceFolder || '').trim();

  syncWatcherTabFromSettings();
  const savebarHidden = activeWatcherTab() === 'settings' || activeWatcherTab() === 'scout' ? '' : ' hidden';
  root.innerHTML = `
    <div ${watcherPanelAttrs('status')}>
      <div id="watcher-runtime-control" class="cr-card watcher-status-card"><h4 class="watcher-section-title">${escapeHtml(t('settings.watcherRuntimeTitle'))}</h4>${renderWatcherRuntimeControlHtml(data.runtimeControl || {})}</div>
      <div id="watcher-status-card" class="cr-card watcher-status-card">${renderWatcherStatusCardHtml(data)}</div>
    </div>

    <div ${watcherPanelAttrs('monitor')}>
      <div id="watcher-dashboard" class="watcher-dashboard"></div>
    </div>

    <div ${watcherPanelAttrs('settings')}>
    <div class="cr-card watcher-form">
      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherGeneral'))}</h4>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherMode'))}</span>
          <div class="watcher-mode-list">${modeRadios}</div>
        </div>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherWorkspaceFolder'))}</span>
          <code class="watcher-folder">${escapeHtml(workspaceFolder || '-')}</code>
        </div>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherLimits'))}</h4>
        <div class="watcher-grid">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxCyclesPerDay'))}</span><input id="watcher-max-cycles" type="number" min="0" value="${Number(policy.maxCyclesPerDay) || 0}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxParallel'))}</span><input id="watcher-max-parallel" type="number" min="1" max="5" value="${Number(policy.maxParallel) || 1}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxFailures'))}</span><input id="watcher-max-failures" type="number" min="0" value="${Number(policy.maxConsecutiveFailures) || 0}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxSameFindings'))}</span><input id="watcher-max-findings" type="number" min="0" value="${Number(policy.maxSameFindings) || 0}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherBackoffBaseMs'))}</span><input id="watcher-backoff-base" type="number" min="0" value="${Number(policy.backoffBaseMs) || 0}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherBackoffCapMs'))}</span><input id="watcher-backoff-cap" type="number" min="0" value="${Number(policy.backoffCapMs) || 0}"></label>
          <label class="cr-field watcher-wide"><span class="cr-field-label">${escapeHtml(t('settings.watcherCooldown'))} · <span id="watcher-cooldown-out" class="watcher-slider-out">${escapeHtml(formatCooldownLabel(cooldownMs))}</span></span><input id="watcher-cooldown" type="range" min="${COOLDOWN_MIN_MS}" max="${cooldownMax}" step="${COOLDOWN_STEP_MS}" value="${cooldownMs}"></label>
        </div>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherQuietHours'))}</h4>
        <label class="cr-check"><input type="checkbox" id="watcher-quiet-enabled"${quietEnabled ? ' checked' : ''}> ${escapeHtml(t('settings.watcherQuietEnabled'))}</label>
        <div class="watcher-grid watcher-quiet-fields">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherQuietStart'))}</span><input id="watcher-quiet-start" type="time" step="60" value="${escapeAttr(quiet.start || '')}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherQuietEnd'))}</span><input id="watcher-quiet-end" type="time" step="60" value="${escapeAttr(quiet.end || '')}"></label>
        </div>
        <p class="cr-hint">${escapeHtml(t('settings.watcherQuietWrapHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherPlanGate'))}</h4>
        <label class="cr-check"><input type="checkbox" id="watcher-require-plan"${policy.requirePlanApproval !== false ? ' checked' : ''}> ${escapeHtml(t('settings.watcherRequirePlan'))}</label>
        <div class="watcher-plan-scope-row${policy.requirePlanApproval === false ? ' is-disabled' : ''}">
          <label class="cr-radio"><input type="radio" name="watcher-plan-scope" value="leaf"${policy.planApprovalScope !== 'root' ? ' checked' : ''}> ${escapeHtml(t('settings.watcherPlanScopeLeaf'))}</label>
          <label class="cr-radio"><input type="radio" name="watcher-plan-scope" value="root"${policy.planApprovalScope === 'root' ? ' checked' : ''}> ${escapeHtml(t('settings.watcherPlanScopeRoot'))}</label>
        </div>
        <p class="cr-hint${policy.requirePlanApproval === false ? ' is-disabled' : ''}">${escapeHtml(t(policy.planApprovalScope === 'root' ? 'settings.watcherPlanScopeRootHint' : 'settings.watcherPlanScopeLeafHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherAllowedHarnesses'))}</h4>
        <p class="cr-hint">${escapeHtml(t('settings.watcherAllowedHarnessesHint'))}</p>
        <div class="watcher-check-list">${harnessChecks}</div>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherOrchestrator'))}</h4>
        <div class="watcher-grid">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherOrchestratorHarness'))}</span><input id="watcher-orch-harness" type="text" placeholder="(auto cheap implement pick)" value="${escapeAttr(orchestrator.harness || '')}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherOrchestratorModel'))}</span><input id="watcher-orch-model" type="text" value="${escapeAttr(orchestrator.model || '')}"></label>
        </div>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherPickRoles'))}</span>
          <div class="watcher-role-list">${roleChecks}</div>
        </div>
      </section>
    </div>
    </div>

    <div ${watcherPanelAttrs('scout')}>
    <div class="cr-card watcher-form">
      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherScoutScheduleTitle'))}</h4>
        <div id="watcher-scout-schedule-info">${renderScoutScheduleHtml(data.scout || {}, Date.now())}</div>
        <div class="cr-row watcher-actions watcher-scout-run-row">
          <cr-bar-button id="watcher-scout-run"${data.scout?.enabled === true ? '' : ' disabled'}>${escapeHtml(t('settings.watcherScoutRunNow'))}</cr-bar-button>
          <span id="watcher-scout-run-status" class="cr-status"></span>
        </div>
        <p class="cr-hint">${escapeHtml(t('settings.watcherScoutRunHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherScoutSection'))}</h4>
        <label class="cr-check"><input type="checkbox" id="watcher-scout-enabled"${policy.scoutEnabled === true ? ' checked' : ''}> ${escapeHtml(t('settings.watcherScoutEnabled'))}</label>
        <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherScoutMaxParallel'))}</span><input id="watcher-scout-max-parallel" type="number" min="1" max="5" value="${Number(policy.scoutMaxParallel) || 1}"></label>
        <p class="cr-hint">${escapeHtml(t('settings.watcherScoutMaxParallelHint'))}</p>
        <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherScoutMaxPerDay'))}</span><input id="watcher-scout-max-per-day" type="number" min="0" step="1" value="${Number.isFinite(Number(policy.scoutMaxPerDay)) ? Math.floor(Number(policy.scoutMaxPerDay)) : DEFAULT_POLICY.scoutMaxPerDay}"></label>
        <p class="cr-hint">${escapeHtml(t('settings.watcherScoutMaxPerDayHint'))}</p>
        <label class="cr-check"><input type="checkbox" id="watcher-scout-autocreate"${policy.scoutAutoCreate === true ? ' checked' : ''}> ${escapeHtml(t('settings.watcherScoutAutoCreate'))}</label>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherScoutHarnesses'))}</span>
          <p class="cr-hint">${escapeHtml(t('settings.watcherScoutHarnessesHint'))}</p>
          <div class="watcher-check-list">${scoutHarnessChecks}</div>
        </div>
        <label class="cr-field watcher-scout-interval"><span class="cr-field-label">${escapeHtml(t('settings.watcherScoutInterval'))} · <span id="watcher-scout-interval-out" class="watcher-slider-out">${scoutInterval} ${escapeHtml(t('settings.watcherHourUnit'))}</span></span><input id="watcher-scout-interval" type="range" min="1" max="24" step="1" value="${scoutInterval}"></label>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherScoutCategories'))}</span>
          <div class="watcher-check-list">${scoutCatChecks}</div>
        </div>
      </section>

    </div>
    </div>

    <div id="watcher-savebar" class="cr-card watcher-form watcher-savebar"${savebarHidden}>
      <p id="watcher-form-error" class="message watcher-form-error" data-tone="error" hidden></p>
      <div class="cr-row watcher-actions">
        <cr-bar-button variant="primary" id="watcher-save">${escapeHtml(t('settings.watcherSave'))}</cr-bar-button>
        <cr-bar-button id="watcher-reset">${escapeHtml(t('settings.watcherResetDefaults'))}</cr-bar-button>
        <span id="watcher-save-status" class="cr-status"></span>
      </div>
    </div>

    <div ${watcherPanelAttrs('actions')}>
    <div class="cr-card watcher-form">
      <div class="cr-row watcher-actions">
        <cr-bar-button id="watcher-stop">${escapeHtml(t('settings.watcherStop'))}</cr-bar-button>
        <cr-bar-button id="watcher-tick">${escapeHtml(t('settings.watcherTick'))}</cr-bar-button>
        <cr-bar-button id="watcher-run-cycle">${escapeHtml(t('settings.watcherRunCycle'))}</cr-bar-button>
        <cr-bar-button id="watcher-pause">${escapeHtml(watcher.paused ? t('settings.watcherResume') : t('settings.watcherPause'))}</cr-bar-button>
        <cr-bar-button id="watcher-clear-stop">${escapeHtml(t('settings.watcherClearStop'))}</cr-bar-button>
        <cr-bar-button id="watcher-clear-backoff">${escapeHtml(t('settings.watcherClearBackoff'))}</cr-bar-button>
      </div>
      <div class="cr-row watcher-actions">
        <input id="watcher-claim-chat" type="text" placeholder="${escapeAttr(t('settings.watcherClaimChatPlaceholder'))}">
        <cr-bar-button id="watcher-claim">${escapeHtml(t('settings.watcherClaim'))}</cr-bar-button>
        <cr-bar-button id="watcher-reset-plan">${escapeHtml(t('settings.watcherResetPlan'))}</cr-bar-button>
        <input id="watcher-findings-hash" type="text" placeholder="${escapeAttr(t('settings.watcherFindingsPlaceholder'))}">
        <cr-bar-button id="watcher-record-findings">${escapeHtml(t('settings.watcherRecordFindings'))}</cr-bar-button>
        <span id="watcher-action-status" class="cr-status"></span>
      </div>
    </div>

    <div class="watcher-lists">
      <div class="cr-card"><h4>${escapeHtml(t('settings.watcherFailures'))}</h4><ul class="watcher-list">${failures}</ul></div>
      <div class="cr-card"><h4>${escapeHtml(t('settings.watcherPlanRequests'))}</h4><ul class="watcher-list">${planRequests}</ul></div>
      <div class="cr-card watcher-wide"><h4>${escapeHtml(t('settings.watcherDecisions'))}</h4><ul class="watcher-list watcher-decisions">${decisionRows}</ul></div>
    </div>
    </div>
  `;

  paintWatcherRuntimeControl(root);

  const cooldownInput = root.querySelector('#watcher-cooldown');
  cooldownInput?.addEventListener('input', () => {
    const out = root.querySelector('#watcher-cooldown-out');
    if (out) out.textContent = formatCooldownLabel(Number(cooldownInput.value) || 0);
  });
  const scoutIntervalInput = root.querySelector('#watcher-scout-interval');
  scoutIntervalInput?.addEventListener('input', () => {
    const out = root.querySelector('#watcher-scout-interval-out');
    if (out) out.textContent = `${scoutIntervalInput.value} ${t('settings.watcherHourUnit')}`;
  });
  // Quiet hours gate the time inputs: disabled and greyed unless the toggle is on.
  const quietToggle = root.querySelector('#watcher-quiet-enabled');
  const syncQuietFields = () => {
    const on = quietToggle?.checked === true;
    for (const id of ['#watcher-quiet-start', '#watcher-quiet-end']) {
      const field = root.querySelector(id);
      if (field) field.disabled = !on;
    }
    root.querySelectorAll('.watcher-quiet-fields').forEach((wrap) => {
      wrap.classList.toggle('is-disabled', !on);
    });
  };
  quietToggle?.addEventListener('change', syncQuietFields);
  syncQuietFields();

  root.querySelector('#watcher-save')?.addEventListener('click', () => saveWatcher(root));
  root.querySelector('#watcher-reset')?.addEventListener('click', () => resetWatcherForm(root));
  root.querySelector('#watcher-tick')?.addEventListener('click', () => watcherAction(root, 'tick'));
  root.querySelector('#watcher-run-cycle')?.addEventListener('click', () => watcherAction(root, 'run_cycle'));
  // One-click global pause: keeps failures/backoff/findings and any active cycle, so resume continues.
  root.querySelector('#watcher-pause')?.addEventListener('click', () => saveWatcher(root, { paused: watcher.paused !== true }));
  root.querySelector('#watcher-stop')?.addEventListener('click', () => saveWatcher(root, { stopReason: t('settings.watcherStoppedReason') }));
  root.querySelector('#watcher-clear-stop')?.addEventListener('click', () => saveWatcher(root, { stopReason: '' }));
  root.querySelector('#watcher-clear-backoff')?.addEventListener('click', () => saveWatcher(root, { failures: {}, backoffUntil: '' }));
  root.querySelector('#watcher-claim')?.addEventListener('click', () => watcherAction(root, 'claim_next'));
  root.querySelector('#watcher-reset-plan')?.addEventListener('click', () => watcherAction(root, 'reset_plan_requests'));
  root.querySelector('#watcher-record-findings')?.addEventListener('click', () => watcherAction(root, 'record_findings'));
  root.querySelector('#watcher-scout-run')?.addEventListener('click', () => runScoutNow(root));
  bindWatcherDashboard(root);
  applyWatcherTab(root);
}

/**
 * @param {HTMLElement} root
 * @returns {{ mode: string, policy: object }}
 */
function readWatcherForm(root) {
  const roles = [...root.querySelectorAll('[data-pick-role]:checked')].map((el) => el.getAttribute('data-pick-role'));
  const harnesses = [...root.querySelectorAll('[data-harness]:checked')].map((el) => el.getAttribute('data-harness'));
  const scoutHarnesses = [...root.querySelectorAll('[data-scout-harness]:checked')].map((el) => el.getAttribute('data-scout-harness'));
  const scoutCats = [...root.querySelectorAll('[data-scout-category]:checked')].map((el) => el.getAttribute('data-scout-category'));
  const scoutMaxPerDay = Number(root.querySelector('#watcher-scout-max-per-day')?.value);
  const quietEnabled = root.querySelector('#watcher-quiet-enabled')?.checked === true;
  const quietStart = String(root.querySelector('#watcher-quiet-start')?.value || '').trim();
  const quietEnd = String(root.querySelector('#watcher-quiet-end')?.value || '').trim();
  return {
    mode: root.querySelector('input[name="watcher-mode"]:checked')?.value || 'off',
    policy: {
      maxParallel: Number(root.querySelector('#watcher-max-parallel')?.value) || 1,
      maxCyclesPerDay: Number(root.querySelector('#watcher-max-cycles')?.value) || 0,
      maxConsecutiveFailures: Number(root.querySelector('#watcher-max-failures')?.value) || 0,
      maxSameFindings: Number(root.querySelector('#watcher-max-findings')?.value) || 0,
      cooldownMs: Number(root.querySelector('#watcher-cooldown')?.value) || 0,
      backoffBaseMs: Number(root.querySelector('#watcher-backoff-base')?.value) || 0,
      backoffCapMs: Number(root.querySelector('#watcher-backoff-cap')?.value) || 0,
      requirePlanApproval: root.querySelector('#watcher-require-plan')?.checked !== false,
      planApprovalScope: root.querySelector('input[name="watcher-plan-scope"]:checked')?.value === 'root' ? 'root' : 'leaf',
      // With quiet hours off the pair is sent empty; the guardrails already read
      // an empty/invalid window as "no quiet hours", so no server `enabled` flag
      // is needed and the persisted default shape stays { start, end }.
      quietHours: quietEnabled ? { start: quietStart, end: quietEnd } : { start: '', end: '' },
      orchestrator: {
        harness: String(root.querySelector('#watcher-orch-harness')?.value || '').trim(),
        model: String(root.querySelector('#watcher-orch-model')?.value || '').trim(),
      },
      allowedHarnesses: harnesses,
      pickRoles: roles.length ? roles : PICK_ROLES.slice(),
      scoutEnabled: root.querySelector('#watcher-scout-enabled')?.checked === true,
      scoutMaxParallel: Number(root.querySelector('#watcher-scout-max-parallel')?.value) || 1,
      scoutMaxPerDay: Number.isInteger(scoutMaxPerDay) && scoutMaxPerDay >= 0
        ? scoutMaxPerDay
        : DEFAULT_POLICY.scoutMaxPerDay,
      scoutIntervalHours: Number(root.querySelector('#watcher-scout-interval')?.value) || DEFAULT_POLICY.scoutIntervalHours,
      scoutAutoCreate: root.querySelector('#watcher-scout-autocreate')?.checked === true,
      scoutAllowedHarnesses: scoutHarnesses,
      // Unchecking every category would be a footgun (scout would never propose);
      // the server falls back to all categories for an empty list too.
      scoutCategories: scoutCats.length ? scoutCats : [...SCOUT_CATEGORIES],
    },
  };
}

/**
 * @param {HTMLElement} root
 * @param {string[] | null} messages
 */
function showFormError(root, messages) {
  const el = root.querySelector('#watcher-form-error');
  if (!el) return;
  if (messages && messages.length) {
    el.textContent = messages.join(' · ');
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

/**
 * Client-side guardrails that mirror the server normalization, so an obviously
 * invalid edit is reported before a PATCH round-trip. Bounds here match what
 * `normalizeWorkspaceWatcherPolicy` clamps to (maxParallel 1..5).
 *
 * @param {HTMLElement} root
 * @returns {string[]}
 */
function validateWatcherForm(root) {
  const errors = [];
  const maxParallel = Number(root.querySelector('#watcher-max-parallel')?.value);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 5) {
    errors.push(t('settings.watcherValidationMaxParallel'));
  }
  if (root.querySelector('#watcher-quiet-enabled')?.checked === true) {
    const start = String(root.querySelector('#watcher-quiet-start')?.value || '').trim();
    const end = String(root.querySelector('#watcher-quiet-end')?.value || '').trim();
    if (!CLOCK_RE.test(start) || !CLOCK_RE.test(end) || start === end) {
      errors.push(t('settings.watcherValidationQuiet'));
    }
  }
  if (root.querySelector('#watcher-scout-enabled')?.checked === true) {
    const scoutMaxParallel = Number(root.querySelector('#watcher-scout-max-parallel')?.value);
    if (!Number.isInteger(scoutMaxParallel) || scoutMaxParallel < 1 || scoutMaxParallel > 5) {
      errors.push(t('settings.watcherValidationMaxParallel'));
    }
    const interval = Number(root.querySelector('#watcher-scout-interval')?.value);
    if (!Number.isFinite(interval) || interval < 1 || interval > 24) {
      errors.push(t('settings.watcherValidationScoutInterval'));
    }
  }
  const scoutMaxPerDay = Number(root.querySelector('#watcher-scout-max-per-day')?.value);
  if (!Number.isInteger(scoutMaxPerDay) || scoutMaxPerDay < 0) {
    errors.push(t('settings.watcherValidationScoutMaxPerDay'));
  }
  return errors;
}

/**
 * Fill every editor control with the client mirror of the server defaults. This
 * is form-only: it does not PATCH, so an accidental click cannot silently flip a
 * live autopilot workspace. The operator presses Save to persist.
 *
 * @param {HTMLElement} root
 */
function resetWatcherForm(root) {
  const set = (id, value) => {
    const el = root.querySelector(`#${id}`);
    if (el) el.value = String(value);
  };
  const check = (id, on) => {
    const el = root.querySelector(`#${id}`);
    if (el) el.checked = !!on;
  };
  const offRadio = root.querySelector('input[name="watcher-mode"][value="off"]');
  if (offRadio) offRadio.checked = true;
  set('watcher-max-cycles', DEFAULT_POLICY.maxCyclesPerDay);
  set('watcher-max-parallel', DEFAULT_POLICY.maxParallel);
  set('watcher-max-failures', DEFAULT_POLICY.maxConsecutiveFailures);
  set('watcher-max-findings', DEFAULT_POLICY.maxSameFindings);
  set('watcher-backoff-base', DEFAULT_POLICY.backoffBaseMs);
  set('watcher-backoff-cap', DEFAULT_POLICY.backoffCapMs);
  set('watcher-cooldown', DEFAULT_POLICY.cooldownMs);
  const cooldownOut = root.querySelector('#watcher-cooldown-out');
  if (cooldownOut) cooldownOut.textContent = formatCooldownLabel(DEFAULT_POLICY.cooldownMs);
  check('watcher-require-plan', DEFAULT_POLICY.requirePlanApproval);
  const defaultScopeRadio = root.querySelector(`input[name="watcher-plan-scope"][value="${DEFAULT_POLICY.planApprovalScope}"]`);
  if (defaultScopeRadio) defaultScopeRadio.checked = true;
  check('watcher-quiet-enabled', false);
  set('watcher-quiet-start', '');
  set('watcher-quiet-end', '');
  for (const id of ['#watcher-quiet-start', '#watcher-quiet-end']) {
    const field = root.querySelector(id);
    if (field) field.disabled = true;
  }
  root.querySelectorAll('.watcher-quiet-fields').forEach((wrap) => wrap.classList.add('is-disabled'));
  for (const el of root.querySelectorAll('[data-harness]')) el.checked = false;
  for (const el of root.querySelectorAll('[data-scout-harness]')) el.checked = false;
  for (const el of root.querySelectorAll('[data-pick-role]')) {
    el.checked = DEFAULT_POLICY.pickRoles.includes(el.getAttribute('data-pick-role'));
  }
  check('watcher-scout-enabled', DEFAULT_POLICY.scoutEnabled);
  set('watcher-scout-max-parallel', DEFAULT_POLICY.scoutMaxParallel);
  set('watcher-scout-max-per-day', DEFAULT_POLICY.scoutMaxPerDay);
  check('watcher-scout-autocreate', DEFAULT_POLICY.scoutAutoCreate);
  set('watcher-scout-interval', DEFAULT_POLICY.scoutIntervalHours);
  const scoutOut = root.querySelector('#watcher-scout-interval-out');
  if (scoutOut) scoutOut.textContent = `${DEFAULT_POLICY.scoutIntervalHours} ${t('settings.watcherHourUnit')}`;
  for (const el of root.querySelectorAll('[data-scout-category]')) el.checked = true;
  set('watcher-orch-harness', '');
  set('watcher-orch-model', '');
  showFormError(root, []);
}

const ACTION_ENDPOINTS = {
  tick: '/api/workspace-watcher/tick',
  run_cycle: '/api/workspace-watcher/run-cycle',
  claim_next: '/api/workspace-watcher/claim-next',
  reset_plan_requests: '/api/workspace-watcher/reset-plan-requests',
  record_findings: '/api/workspace-watcher/findings',
};

/**
 * Build the PATCH body for a save. A full save writes the editable form
 * (mode + policy); a targeted override — the pause toggle, emergency stop or
 * clear-stop — sends *only* the override keys. In particular stop/clear-stop
 * must never read or commit the unsaved mode radio or any dirty policy field.
 *
 * @param {{ [key: string]: unknown } | null} override
 * @param {{ mode: string, policy: object } | null} form
 * @returns {{ [key: string]: unknown }}
 */
function buildWatcherPatchBody(override, form) {
  return override ? { ...override } : { mode: form.mode, policy: form.policy };
}

async function saveWatcher(root, override = null) {
  // Targeted overrides must not touch the form at all: reading it here is what
  // let an emergency stop carry a dirty, unsaved mode into the PATCH.
  const form = override ? null : readWatcherForm(root);
  const body = buildWatcherPatchBody(override, form);
  // Full-form saves validate before the round-trip; overrides (pause/stop/clear)
  // carry no editable fields and go straight through.
  if (!override) {
    const errors = validateWatcherForm(root);
    if (errors.length) {
      showFormError(root, errors);
      return;
    }
    showFormError(root, []);
  }
  // Optimistic: reflect the new mode/policy in the cached view and repaint only
  // the status card (never the form, which would drop edits). The authoritative
  // refresh after a successful PATCH corrects any divergence.
  const prevView = lastView;
  const prevViewSeq = viewSeq;
  let optimisticViewSeq = prevViewSeq;
  if (!override && lastView) {
    lastView = {
      ...lastView,
      watcher: {
        ...lastView.watcher,
        mode: form.mode,
        policy: { ...(lastView.watcher?.policy || {}), ...form.policy },
      },
    };
    optimisticViewSeq = ++viewSeq;
    paintWatcherStatusCard(root);
  }
  const saveBtn = root.querySelector('#watcher-save');
  if (saveBtn) saveBtn.setAttribute('disabled', 'true');
  setWatcherStatus(root, t('settings.watcherWorking'));
  let res;
  try {
    res = await watcherApi('/api/workspace-watcher', { method: 'PATCH', body });
  } catch {
    res = { json: null };
  } finally {
    if (saveBtn) saveBtn.removeAttribute('disabled');
  }
  if (!res.json?.ok) {
    // Only roll back the optimistic paint while the cached view is still the
    // generation this save wrote. A refresh that resolved during the PATCH is
    // fresher and must not be replaced by our stale snapshot.
    if (viewSeq === optimisticViewSeq) {
      lastView = prevView;
      viewSeq += 1;
    }
    paintWatcherStatusCard(root);
    const message = res.json?.error || t('settings.watcherSaveError');
    setWatcherStatus(root, message);
    if (!override) showFormError(root, [message]);
    return;
  }
  await refreshWorkspaceWatcherSettingsPanel();
}

function setWatcherStatus(root, text) {
  for (const sel of ['#watcher-save-status', '#watcher-action-status']) {
    const node = root.querySelector(sel);
    if (node) node.textContent = text;
  }
}

async function watcherAction(root, action) {
  const path = ACTION_ENDPOINTS[action];
  if (!path) return;
  /** @type {Record<string, unknown>} */
  const body = {};
  if (action === 'claim_next') body.claimedByChatId = String(root.querySelector('#watcher-claim-chat')?.value || '').trim();
  if (action === 'record_findings') body.hash = String(root.querySelector('#watcher-findings-hash')?.value || '').trim();
  setWatcherStatus(root, t('settings.watcherWorking'));
  const res = await watcherApi(path, { method: 'POST', body });
  if (!res.json?.ok) {
    setWatcherStatus(root, res.json?.error || t('settings.watcherActionError'));
    return;
  }
  await refreshWorkspaceWatcherSettingsPanel();
}

/**
 * Manual Scout trigger. The server bypasses the scan interval for an explicit
 * run but still respects the mode, quiet hours and the per-day budget, so a
 * blocked answer is reported as a reason (not an error). A non-full refresh
 * keeps the operator's unsaved policy edits and the status line intact.
 *
 * @param {HTMLElement} root
 */
async function runScoutNow(root) {
  const button = root.querySelector('#watcher-scout-run');
  if (button) button.setAttribute('disabled', 'true');
  const status = root.querySelector('#watcher-scout-run-status');
  if (status) status.textContent = t('settings.watcherWorking');
  let res;
  try {
    res = await watcherApi('/api/workspace-watcher/scout', { method: 'POST', body: { action: 'run' } });
  } catch {
    res = { json: null };
  } finally {
    if (button) button.removeAttribute('disabled');
  }
  const json = res.json || null;
  const blockedReason = scoutReasonText(json?.reason);
  if (!json?.ok || json.scanned === false) {
    // Refresh first: the schedule card may show a spent budget or a blocker.
    await refreshWorkspaceWatcherSettingsPanel({ full: false });
    paintScoutSchedule(root);
    const liveStatus = root.querySelector('#watcher-scout-run-status');
    if (liveStatus) liveStatus.textContent = blockedReason || json?.error || t('settings.watcherScoutRunError');
    return;
  }
  await refreshWorkspaceWatcherSettingsPanel({ full: false });
  paintScoutSchedule(root);
  // A full re-render (workspace switch) replaces the node, so re-query it.
  const liveStatus = root.querySelector('#watcher-scout-run-status');
  if (liveStatus) liveStatus.textContent = t('settings.watcherScoutRunStarted', { n: Number(json.added) || 0 });
}

/**
 * Assemble the dashboard block from the cached view + stats and the local UI
 * state (range / decisions filter / selected cycle). Rendering is pure string
 * building via `watcherDashboard.js` / `watcherTimeline.js`.
 *
 * @param {HTMLElement} root
 */
function paintWatcherDashboard(root) {
  const container = root.querySelector('#watcher-dashboard');
  if (!container) return;
  // The status card sits alongside the dashboard and reflects the same cached
  // view, so repaint it here too — used by both the live path and optimistic
  // saves. This never touches the editable form.
  paintWatcherStatusCard(root);
  const view = lastView || { watcher: {} };
  const stats = lastStats || {};
  const now = Date.now();
  container.innerHTML = ''
    + '<h3 class="watcher-dashboard-title">' + escapeHtml(t('settings.watcherDashboardTitle')) + '</h3>'
    + '<p class="cr-hint">' + escapeHtml(t('settings.watcherDashboardHint')) + '</p>'
    + renderWatcherAlertsHtml(view, { now })
    + renderWatcherLiveHtml(view, { stats, getTodoTitle, now })
    + renderWatcherTimelineHtml(stats, view, {
      now,
      rangeKey: dashState.range,
      selectedId: dashState.selectedCycleId,
      getTodoTitle,
    })
    + renderWatcherStatsHtml(stats)
    + renderWatcherDecisionsHtml(view.watcher?.decisions || [], {
      kinds: stats.decisionKinds,
      filterKind: dashState.decisionsFilter,
    });
  tickWatcherTimes(root);
}

/**
 * Whether the dashboard is actually on screen. The settings watcher `<section>`
 * is `hidden` when another tab is active, and a hidden subtree reports a null
 * `offsetParent`; a detached container is never visible. Both cases mean the
 * ticker is doing invisible work and should stop.
 *
 * @param {Element | null} container
 * @returns {boolean}
 */
function dashboardIsVisible(container) {
  return !!container && container.isConnected && container.offsetParent !== null;
}

/** Start the per-second ticker once. A hidden monitoring tab must not restart it. */
function ensureWatcherTicker(root) {
  if (dashTimer) return;
  dashTimer = setInterval(() => tickWatcherTimes(root), 1000);
  if (typeof dashTimer.unref === 'function') dashTimer.unref();
}

/** Clear the per-second repaint timer so a hidden/unmounted panel stops. */
function stopWatcherTicker() {
  if (dashTimer) {
    clearInterval(dashTimer);
    dashTimer = null;
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
function tickWatcherTimes(root) {
  const container = root.querySelector('#watcher-dashboard');
  const scoutSchedule = root.querySelector('#watcher-scout-schedule-info');
  // Either countdown surface keeps the ticker alive; when neither is on screen
  // (a hidden tab, a detached panel) the ticker stops instead of spinning.
  if (!dashboardIsVisible(container) && !dashboardIsVisible(scoutSchedule)) {
    stopWatcherTicker();
    return;
  }
  if (Date.now() - lastRuntimePollAt >= 5_000) void refreshWatcherRuntimeControl(root);
  const now = Date.now();
  for (const node of root.querySelectorAll('[data-watcher-countdown]')) {
    const until = Number(node.getAttribute('data-watcher-countdown'));
    if (!Number.isFinite(until)) continue;
    node.textContent = formatCountdown(until, now);
  }
  for (const node of root.querySelectorAll('[data-watcher-duration]')) {
    const started = Number(node.getAttribute('data-watcher-duration'));
    if (!Number.isFinite(started) || started <= 0) continue;
    node.textContent = formatDuration(now - started);
  }
}

/**
 * Bind delegated handlers onto the dashboard container and start the countdown
 * ticker. Called once per panel render (the container element is fresh each
 * time, so listeners never accumulate).
 *
 * @param {HTMLElement} root
 */
function bindWatcherDashboard(root) {
  const container = root.querySelector('#watcher-dashboard');
  if (!container) return;
  container.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-watcher-range],[data-watcher-tl-select],[data-watcher-open-chat],[data-watcher-action]') : null;
    if (!target) return;
    if (target.hasAttribute('data-watcher-range')) {
      const key = String(target.getAttribute('data-watcher-range') || '24h');
      if (WATCHER_TIMELINE_RANGES.some((r) => r.key === key)) {
        dashState.range = key;
        paintWatcherDashboard(root);
      }
      return;
    }
    if (target.matches('[data-watcher-tl-select]')) {
      const id = String(target.getAttribute('data-cycle-id') || target.getAttribute('data-chat-id') || '').trim();
      dashState.selectedCycleId = dashState.selectedCycleId === id ? '' : id;
      paintWatcherDashboard(root);
      return;
    }
    if (target.hasAttribute('data-watcher-open-chat')) {
      void openWatcherChat(String(target.getAttribute('data-watcher-open-chat') || ''));
      return;
    }
    if (String(target.getAttribute('data-watcher-action') || '') === 'clear-stop') {
      void saveWatcher(root, { stopReason: '' });
    }
  });
  container.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-watcher-decisions-filter]') : null;
    if (!target) return;
    dashState.decisionsFilter = String(target.value || 'all');
    paintWatcherDashboard(root);
  });
  if (dashboardIsVisible(container)) ensureWatcherTicker(root);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
