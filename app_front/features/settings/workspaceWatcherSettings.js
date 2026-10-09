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
  renderWatcherScheduleHtml,
  scheduleNextValueHtml,
  formatCountdown,
  formatDuration,
} from '../watcher/watcherDashboard.js';
import { renderWatcherTimelineHtml, WATCHER_TIMELINE_RANGES } from '../watcher/watcherTimeline.js';
import {
  SCOUT_PROFILE_ACTIONS,
  nextScoutProfileName,
  renderScoutProfilesHtml,
  scoutReasonText,
  scoutRunResultText,
} from '../watcher/scoutProfilesView.js';
import {
  SCOUT_EDITOR_ACTIONS,
  applyDraftEdit,
  draftFromProfile,
  draftFromTemplate,
  renderScoutEditorHtml,
  renderScoutPreviewHtml,
  renderScoutRestoreHtml,
  renderScoutTemplatesHtml,
  scoutEditorAdvancedFieldError,
  scoutEditorFieldErrors,
} from '../watcher/scoutProfileEditorView.js';
import {
  SCOUT_HISTORY_ACTIONS,
  SCOUT_HISTORY_PAGE_SIZE,
  renderScoutHistoryHtml,
  scoutScanCapacityExceeded,
} from '../watcher/scoutHistoryView.js';
import {
  SCOUT_INBOX_ACTIONS,
  SCOUT_INBOX_PAGE_SIZE,
  SCOUT_INBOX_SOURCE_PAGE_SIZE,
  renderScoutInboxHtml,
} from '../watcher/scoutFindingsInboxView.js';
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
/** Mirror of `WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS` on the server. */
const SCOUT_PENDING_FINDINGS_CAPACITY = 200;
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
  // Execution folder default plus the worktree layout. The server ships an empty
  // layout and refuses a `worktree` start until the operator fills it in, so the
  // reset mirror must stay empty too.
  executionMode: 'project',
  worktree: { root: '', namespace: '', branchPrefix: '', directoryPrefix: '', prepareCommand: [] },
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
/** Scout profile list state (stage 5.1). Kept module-scoped so a management
 *  action can repaint only the list, never the editable policy form. */
const EMPTY_SCOUT_PROFILES_STATE = {
  loading: true,
  error: '',
  profiles: [],
  busy: false,
  busyId: '',
  busyAction: '',
  confirmArchiveId: '',
  message: '',
  messageTone: 'ok',
};
let scoutProfilesState = { ...EMPTY_SCOUT_PROFILES_STATE };
/** Scout scan history (stage 5.3). Repainted independently of the policy form. */
const EMPTY_SCOUT_HISTORY_STATE = {
  loading: true,
  error: '',
  history: [],
  total: 0,
  scoutId: '',
  max: SCOUT_HISTORY_PAGE_SIZE,
  busy: false,
  message: '',
  messageTone: 'ok',
};
let scoutHistoryState = { ...EMPTY_SCOUT_HISTORY_STATE };
/** Shared Scout proposal inbox (stage 5.3). */
const EMPTY_SCOUT_INBOX_STATE = {
  loading: true,
  error: '',
  findings: [],
  total: 0,
  scoutId: '',
  category: '',
  status: '',
  max: SCOUT_INBOX_PAGE_SIZE,
  busy: false,
  busyId: '',
  expandedSources: {},
  capacityExceeded: false,
  message: '',
  messageTone: 'ok',
};
let scoutInboxState = { ...EMPTY_SCOUT_INBOX_STATE };
/** Scout profile editor state (stage 5.2). Module-scoped and completely separate
 *  from the list state: a live refresh may repaint the list without ever
 *  overwriting an unsaved draft when `dirty === true`. */
const EMPTY_SCOUT_EDITOR_STATE = {
  mode: null,
  draft: null,
  originalProfile: null,
  templates: [],
  preview: null,
  previewError: '',
  restoreDiff: null,
  restoreMeta: null,
  restoreError: '',
  fieldErrors: {},
  casConflict: false,
  busy: false,
  dirty: false,
  error: '',
  selectedId: '',
  /** Kept here, not in the DOM: a repaint rebuilds the `<details>` element. */
  advancedOpen: false,
};
let scoutEditorState = { ...EMPTY_SCOUT_EDITOR_STATE };
/** Index of the glob row a pending `remove-include`/`remove-exclude` click
 *  targets. Set by the delegated click binder right before dispatch. */
let scoutEditorRemoveIndex = -1;

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
    paintScoutProfiles(panel);
    paintScoutHistory(panel);
    paintScoutInbox(panel);
    paintScoutEditorLive(panel);
    paintScoutSchedule(panel);
    paintWatcherSchedule(panel);
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
  if (full) {
    root.innerHTML = `<p class="settings-hint">${escapeHtml(t('settings.watcherLoading'))}</p>`;
    // A full render is a fresh start for the list: drop a stale confirmation and
    // show the loading state until the fetch resolves.
    scoutProfilesState = { ...EMPTY_SCOUT_PROFILES_STATE };
    scoutHistoryState = { ...EMPTY_SCOUT_HISTORY_STATE };
    scoutInboxState = { ...EMPTY_SCOUT_INBOX_STATE };
    // A workspace switch must not leave the previous workspace's profile draft
    // on screen; within one workspace the draft survives a full render.
    if (watcherWorkspaceScopeChanged(renderedWorkspaceFolder)) {
      scoutEditorState = { ...EMPTY_SCOUT_EDITOR_STATE };
    }
  }
  const scoutHistoryPath = full
    ? `/api/workspace-watcher/scout/history?max=${SCOUT_HISTORY_PAGE_SIZE}`
    : null;
  const scoutInboxPath = full
    ? `/api/workspace-watcher/scout?max=${SCOUT_INBOX_PAGE_SIZE}`
    : null;
  // The harness catalog is only needed to build the form (full path); fetch it
  // alongside the watcher view so the checkbox list renders synchronously. The
  // profile list is additive: a failure degrades to an error card, it must never
  // reject the whole refresh and blank the rest of the panel.
  const [res, catalog, runtime, profilesRes, historyRes, inboxRes] = await Promise.all([
    watcherApi(full ? '/api/workspace-watcher?suggest=1' : '/api/workspace-watcher'),
    full ? watcherApi('/api/harness-catalog/harnesses') : Promise.resolve(null),
    watcherApi('/api/workspace-watcher/runtime-control'),
    full ? watcherApi('/api/workspace-watcher/scout/profiles').catch(() => null) : Promise.resolve(null),
    full && scoutHistoryPath ? watcherApi(scoutHistoryPath).catch(() => null) : Promise.resolve(null),
    full && scoutInboxPath ? watcherApi(scoutInboxPath).catch(() => null) : Promise.resolve(null),
  ]);
  // A newer refresh (a save, or another live event) already owns the paint.
  if (seq !== refreshSeq) return;
  if (catalog?.json?.ok && Array.isArray(catalog.json.items)) {
    harnessOptions = catalog.json.items
      .map((row) => ({ id: String(row?.id ?? '').trim(), label: String(row?.label ?? row?.id ?? '').trim() }))
      .filter((row) => row.id);
  }
  if (full) {
    applyScoutProfilesResponse(profilesRes);
    applyScoutHistoryResponse(historyRes);
    applyScoutInboxResponse(inboxRes, res.json?.scout);
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
/** Absolute path on POSIX (`/...`) or Windows (`C:\...` / `C:/...`). */
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/)/;

/**
 * The worktree `prepareCommand` is an argv array, never a shell string. Each
 * non-empty line of the textarea is one argument, so a quoted or spaced value
 * cannot be reinterpreted by a shell.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function prepareCommandLines(value) {
  if (Array.isArray(value)) return value.map((part) => String(part ?? '').trim()).filter(Boolean);
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * One argv argument per line for the textarea editor.
 *
 * @param {unknown} value
 * @returns {string}
 */
function prepareCommandText(value) {
  return prepareCommandLines(value).join('\n');
}

/**
 * @param {HTMLElement} root
 * @returns {string[]}
 */
function readPrepareCommandLines(root) {
  return prepareCommandLines(root.querySelector('#watcher-worktree-prepare')?.value || '');
}

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

/**
 * Store one profiles response as the new server truth. Busy/confirmation state
 * is always cleared here: the list is authoritative again.
 *
 * @param {{ status?: number, json?: object | null } | null} res
 */
function applyScoutProfilesResponse(res) {
  const next = { ...scoutProfilesState, loading: false, busy: false, busyId: '', busyAction: '' };
  if (res?.json?.ok === true && Array.isArray(res.json.profiles)) {
    scoutProfilesState = { ...next, error: '', profiles: res.json.profiles };
    return;
  }
  scoutProfilesState = {
    ...next,
    error: res?.json?.error || t('settings.watcherScoutProfilesError'),
    profiles: [],
  };
}

/** @param {HTMLElement} root */
function paintScoutProfiles(root) {
  const node = root.querySelector('#watcher-scout-profiles');
  if (!node) return;
  node.innerHTML = renderScoutProfilesHtml({ ...scoutProfilesState, now: Date.now() });
}

/**
 * Re-read the profile list and repaint only that card. Used after every mutation
 * so the UI reflects server truth (revision, counters, archived flag) instead of
 * an optimistic guess, and the editable policy form is never rebuilt.
 *
 * @param {HTMLElement | null} [root]
 */
async function reloadScoutProfiles(root = null) {
  const panel = root || document.getElementById('settings-watcher-root');
  scoutProfilesState = {
    ...scoutProfilesState,
    loading: true,
    error: '',
    busy: false,
    busyId: '',
    busyAction: '',
  };
  if (panel) paintScoutProfiles(panel);
  let res;
  try {
    res = await watcherApi('/api/workspace-watcher/scout/profiles');
  } catch {
    res = null;
  }
  applyScoutProfilesResponse(res);
  if (panel) paintScoutProfiles(panel);
}

/**
 * @param {string} text
 * @param {'ok' | 'error'} [tone]
 */
function setScoutProfilesMessage(text, tone = 'ok') {
  scoutProfilesState = {
    ...scoutProfilesState,
    message: String(text ?? '').trim(),
    messageTone: tone === 'error' ? 'error' : 'ok',
  };
}

/**
 * Strip server-owned fields and the additive `state` before an update PATCH, so
 * the payload carries exactly the user-editable configuration.
 *
 * @param {object | null | undefined} profile
 * @returns {object}
 */
function stripScoutProfileState(profile) {
  const body = { ...(profile && typeof profile === 'object' ? profile : {}) };
  for (const field of ['state', 'id', 'revision', 'createdAt', 'updatedAt']) delete body[field];
  return body;
}

/**
 * @param {string} action
 * @returns {string}
 */
function scoutProfileSuccessMessage(action) {
  if (action === 'create') return t('settings.watcherScoutCreated');
  if (action === 'duplicate') return t('settings.watcherScoutDuplicated');
  if (action === 'archive-confirm') return t('settings.watcherScoutArchived');
  return t('settings.watcherScoutUpdated');
}

/**
 * Perform the API call behind one list action.
 *
 * @param {string} action
 * @param {object | null} profile
 * @param {string} scoutId
 * @returns {Promise<{ status?: number, json?: object | null }>}
 */
async function scoutProfileMutation(action, profile, scoutId) {
  const encoded = encodeURIComponent(scoutId);
  if (action === 'create') {
    return watcherApi('/api/workspace-watcher/scout/profiles', {
      method: 'POST',
      body: {
        profile: {
          name: nextScoutProfileName(scoutProfilesState.profiles.map((row) => row?.name)),
          objective: t('settings.watcherScoutNewDefaultObjective'),
          enabled: false,
          schedule: { mode: 'manual' },
          categories: [...SCOUT_CATEGORIES],
        },
      },
    });
  }
  if (action === 'duplicate') {
    return watcherApi(`/api/workspace-watcher/scout/profiles/${encoded}/duplicate`, {
      method: 'POST',
      body: {},
    });
  }
  if (action === 'archive-confirm') {
    return watcherApi(`/api/workspace-watcher/scout/profiles/${encoded}/archive`, {
      method: 'POST',
      body: {},
    });
  }
  if (action === 'run') {
    return watcherApi(`/api/workspace-watcher/scout/profiles/${encoded}/run`, {
      method: 'POST',
      body: {},
    });
  }
  if (action === 'toggle') {
    const nextProfile = stripScoutProfileState(profile);
    nextProfile.enabled = profile?.enabled !== true;
    return watcherApi(`/api/workspace-watcher/scout/profiles/${encoded}`, {
      method: 'PATCH',
      body: {
        expectedRevision: Math.max(1, Math.floor(Number(profile?.revision) || 1)),
        profile: nextProfile,
      },
    });
  }
  return { status: 400, json: { ok: false, error: t('settings.watcherActionError') } };
}

/**
 * Dispatch one management action from the profile list. A mutation marks the
 * row busy, calls the API, reports a readable message (including the 409 CAS
 * conflict) and then re-reads the list from the server. The editable policy form
 * is only ever repainted through `#watcher-scout-profiles`.
 *
 * @param {HTMLElement} root
 * @param {string} action
 * @param {string} scoutId
 */
async function runScoutProfileAction(root, action, scoutId) {
  // The editor surface has its own action namespace; route it to the editor
  // dispatcher so a rendered editor button is never treated as a list action.
  if (SCOUT_EDITOR_ACTIONS.includes(action)) {
    await runScoutEditorAction(root, action, scoutId);
    return;
  }
  if (action === 'archive') {
    scoutProfilesState = { ...scoutProfilesState, confirmArchiveId: scoutId, message: '', messageTone: 'ok' };
    paintScoutProfiles(root);
    return;
  }
  if (action === 'archive-cancel') {
    scoutProfilesState = { ...scoutProfilesState, confirmArchiveId: '' };
    paintScoutProfiles(root);
    return;
  }
  if (action === 'reload') {
    await reloadScoutProfiles(root);
    return;
  }
  const profile = scoutProfilesState.profiles.find((row) => String(row?.id ?? '') === scoutId) || null;
  if (action !== 'create' && !profile) return;
  scoutProfilesState = {
    ...scoutProfilesState,
    busy: true,
    busyId: scoutId,
    busyAction: action,
    confirmArchiveId: '',
    message: '',
    messageTone: 'ok',
  };
  paintScoutProfiles(root);
  let res;
  try {
    res = await scoutProfileMutation(action, profile, scoutId);
  } catch {
    res = { status: 0, json: null };
  }
  const conflict = res?.status === 409;
  if (action === 'run') {
    // A blocked manual run answers HTTP 200 with ok:false and a reason.
    const started = res?.json?.ok === true && res?.json?.scanned !== false;
    if (started) {
      setScoutProfilesMessage(
        t('settings.watcherScoutRunStarted', { n: Number(res.json.added) || 0 }),
        'ok',
      );
    } else {
      setScoutProfilesMessage(
        scoutRunResultText(res?.json),
        res?.json?.reason === 'no_files_in_scope' ? 'ok' : 'error',
      );
    }
  } else if (res?.json?.ok === true) {
    setScoutProfilesMessage(scoutProfileSuccessMessage(action), 'ok');
  } else {
    setScoutProfilesMessage(
      conflict ? t('settings.watcherScoutCasConflict') : (res?.json?.error || t('settings.watcherActionError')),
      'error',
    );
  }
  // Always re-read: it resolves a stale revision (409) and reflects the real
  // counters after a manual run.
  await reloadScoutProfiles(root);
  if (action === 'run' && res?.json?.ok === true && res?.json?.scanned !== false) {
    await refreshScoutHistoryAndInbox(root, res.json?.scout);
  }
}

/* -------------------------------------------------------------------------- */
/* Scout scan history + shared inbox (stage 5.3)                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object | null | undefined} scoutMeta
 * @param {object[] | undefined} history
 * @returns {boolean}
 */
function scoutInboxCapacityFlag(scoutMeta, history) {
  if (Array.isArray(history) && history.some((entry) => scoutScanCapacityExceeded(entry))) return true;
  return Number(scoutMeta?.pendingFindings) >= SCOUT_PENDING_FINDINGS_CAPACITY;
}

/**
 * @param {{ status?: number, json?: object | null } | null} res
 */
function applyScoutHistoryResponse(res) {
  const next = { ...scoutHistoryState, loading: false, busy: false };
  if (res?.json?.ok === true && Array.isArray(res.json.history)) {
    scoutHistoryState = {
      ...next,
      error: '',
      history: res.json.history,
      total: Number(res.json.total) || res.json.history.length,
    };
    scoutInboxState = {
      ...scoutInboxState,
      capacityExceeded: scoutInboxCapacityFlag(lastView?.scout, scoutHistoryState.history),
    };
    return;
  }
  scoutHistoryState = {
    ...next,
    error: res?.json?.error || t('settings.watcherScoutHistoryError'),
    history: [],
    total: 0,
  };
}

/**
 * @param {{ status?: number, json?: object | null } | null} res
 * @param {object | null | undefined} [scoutMeta]
 */
function applyScoutInboxResponse(res, scoutMeta) {
  const next = { ...scoutInboxState, loading: false, busy: false, busyId: '' };
  if (res?.json?.ok === true && Array.isArray(res.json.findings)) {
    scoutInboxState = {
      ...next,
      error: '',
      findings: res.json.findings,
      total: Number(res.json.total) || res.json.findings.length,
      capacityExceeded: scoutInboxCapacityFlag(scoutMeta ?? lastView?.scout, scoutHistoryState.history),
    };
    return;
  }
  scoutInboxState = {
    ...next,
    error: res?.json?.error || t('settings.watcherScoutInboxError'),
    findings: [],
    total: 0,
  };
}

/**
 * @returns {string}
 */
function scoutHistoryFetchPath() {
  const params = new URLSearchParams();
  const scoutId = String(scoutHistoryState.scoutId || '').trim();
  if (scoutId) params.set('scoutId', scoutId);
  const max = Math.max(SCOUT_HISTORY_PAGE_SIZE, Math.floor(Number(scoutHistoryState.max) || SCOUT_HISTORY_PAGE_SIZE));
  params.set('max', String(max));
  const query = params.toString();
  return query
    ? `/api/workspace-watcher/scout/history?${query}`
    : `/api/workspace-watcher/scout/history?max=${max}`;
}

/**
 * @returns {string}
 */
function scoutInboxFetchPath() {
  const params = new URLSearchParams();
  const scoutId = String(scoutInboxState.scoutId || '').trim();
  const category = String(scoutInboxState.category || '').trim();
  const status = String(scoutInboxState.status || '').trim();
  if (scoutId) params.set('scoutId', scoutId);
  if (category) params.set('category', category);
  if (status) params.set('status', status);
  const max = Math.max(SCOUT_INBOX_PAGE_SIZE, Math.floor(Number(scoutInboxState.max) || SCOUT_INBOX_PAGE_SIZE));
  params.set('max', String(max));
  return `/api/workspace-watcher/scout?${params.toString()}`;
}

/** @param {HTMLElement} root */
function paintScoutHistory(root) {
  const node = root.querySelector('#watcher-scout-history');
  if (!node) return;
  node.innerHTML = renderScoutHistoryHtml({
    ...scoutHistoryState,
    profiles: scoutProfilesState.profiles,
  });
}

/** @param {HTMLElement} root */
function paintScoutInbox(root) {
  const node = root.querySelector('#watcher-scout-inbox');
  if (!node) return;
  const policy = lastView?.policy || {};
  node.innerHTML = renderScoutInboxHtml({
    ...scoutInboxState,
    profiles: scoutProfilesState.profiles,
    autoCreate: policy.scoutAutoCreate === true,
    getTodoTitle,
  });
}

/**
 * @param {HTMLElement | null} [root]
 */
async function reloadScoutHistory(root = null) {
  const panel = root || document.getElementById('settings-watcher-root');
  scoutHistoryState = { ...scoutHistoryState, loading: true, error: '', busy: false };
  if (panel) paintScoutHistory(panel);
  let res;
  try {
    res = await watcherApi(scoutHistoryFetchPath());
  } catch {
    res = null;
  }
  applyScoutHistoryResponse(res);
  if (panel) {
    paintScoutHistory(panel);
    paintScoutInbox(panel);
  }
}

/**
 * @param {HTMLElement | null} [root]
 * @param {object | null | undefined} [scoutMeta]
 */
async function reloadScoutInbox(root = null, scoutMeta) {
  const panel = root || document.getElementById('settings-watcher-root');
  scoutInboxState = { ...scoutInboxState, loading: true, error: '', busy: false, busyId: '' };
  if (panel) paintScoutInbox(panel);
  let res;
  try {
    res = await watcherApi(scoutInboxFetchPath());
  } catch {
    res = null;
  }
  applyScoutInboxResponse(res, scoutMeta);
  if (panel) paintScoutInbox(panel);
}

/**
 * @param {HTMLElement} root
 * @param {object | null | undefined} [scoutMeta]
 */
async function refreshScoutHistoryAndInbox(root, scoutMeta) {
  await Promise.all([reloadScoutHistory(root), reloadScoutInbox(root, scoutMeta)]);
}

/**
 * @param {HTMLElement} root
 * @param {string} action
 */
async function runScoutHistoryAction(root, action) {
  if (action === 'history-reload') {
    scoutHistoryState = { ...scoutHistoryState, max: SCOUT_HISTORY_PAGE_SIZE, message: '', messageTone: 'ok' };
    await reloadScoutHistory(root);
    return;
  }
  if (action !== 'history-more') return;
  const base = Math.max(SCOUT_HISTORY_PAGE_SIZE, Math.floor(Number(scoutHistoryState.max) || SCOUT_HISTORY_PAGE_SIZE));
  scoutHistoryState = { ...scoutHistoryState, max: base + SCOUT_HISTORY_PAGE_SIZE, busy: true, message: '', messageTone: 'ok' };
  paintScoutHistory(root);
  await reloadScoutHistory(root);
}

/**
 * @param {string} todoId
 */
function openScoutLinkedTodo(todoId) {
  const id = String(todoId || '').trim();
  if (!id) return;
  document.dispatchEvent(new CustomEvent('cretli-open-todo', { detail: { todoId: id }, bubbles: true }));
}

/**
 * @param {HTMLElement} root
 * @param {string} action
 * @param {string} [findingId]
 * @param {string} [todoId]
 */
async function runScoutInboxAction(root, action, findingId = '', todoId = '') {
  if (action === 'inbox-reload') {
    scoutInboxState = {
      ...scoutInboxState,
      max: SCOUT_INBOX_PAGE_SIZE,
      expandedSources: {},
      message: '',
      messageTone: 'ok',
    };
    await reloadScoutInbox(root);
    return;
  }
  if (action === 'open-todo') {
    openScoutLinkedTodo(todoId);
    return;
  }
  if (action === 'inbox-sources-more') {
    const id = String(findingId || '').trim();
    if (!id) return;
    const prev = scoutInboxState.expandedSources[id] || SCOUT_INBOX_SOURCE_PAGE_SIZE;
    scoutInboxState = {
      ...scoutInboxState,
      expandedSources: { ...scoutInboxState.expandedSources, [id]: prev + SCOUT_INBOX_SOURCE_PAGE_SIZE },
    };
    paintScoutInbox(root);
    return;
  }
  if (action === 'inbox-more') {
    const base = Math.max(SCOUT_INBOX_PAGE_SIZE, Math.floor(Number(scoutInboxState.max) || SCOUT_INBOX_PAGE_SIZE));
    scoutInboxState = { ...scoutInboxState, max: base + SCOUT_INBOX_PAGE_SIZE, busy: true, message: '', messageTone: 'ok' };
    paintScoutInbox(root);
    await reloadScoutInbox(root);
    return;
  }
  if (action !== 'inbox-accept' && action !== 'inbox-reject') return;
  const id = String(findingId || '').trim();
  if (!id) return;
  scoutInboxState = { ...scoutInboxState, busy: true, busyId: id, message: '', messageTone: 'ok' };
  paintScoutInbox(root);
  let res;
  try {
    res = await watcherApi('/api/workspace-watcher/scout', {
      method: 'POST',
      body: { action: action === 'inbox-accept' ? 'accept' : 'reject', ids: [id] },
    });
  } catch {
    res = { status: 0, json: null };
  }
  if (res?.json?.ok === true) {
    scoutInboxState = {
      ...scoutInboxState,
      message: action === 'inbox-accept'
        ? t('settings.watcherScoutInboxAccepted')
        : t('settings.watcherScoutInboxRejected'),
      messageTone: 'ok',
    };
  } else {
    scoutInboxState = {
      ...scoutInboxState,
      message: res?.json?.error || t('settings.watcherActionError'),
      messageTone: 'error',
    };
  }
  await reloadScoutInbox(root);
  await reloadScoutProfiles(root);
}

/* -------------------------------------------------------------------------- */
/* Scout profile editor (stage 5.2)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Strip server-owned fields and the additive `state` before an editor save.
 *
 * @param {object | null | undefined} draft
 * @returns {object}
 */
function stripScoutEditorDraft(draft) {
  const body = { ...(draft && typeof draft === 'object' ? draft : {}) };
  for (const field of ['state', 'id', 'revision', 'createdAt', 'updatedAt']) delete body[field];
  return body;
}

/**
 * Overrides sent with `from-template`: everything the user edited except the
 * server-owned identity, the template link and the automation invariant
 * (`enabled`/`schedule` are forced by the control layer).
 *
 * @param {object} draft
 * @returns {object}
 */
function templateOverridesFromDraft(draft) {
  const body = stripScoutEditorDraft(draft);
  delete body.templateId;
  delete body.templateVersion;
  delete body.enabled;
  delete body.schedule;
  return body;
}

/**
 * @param {object | null | undefined} profile
 * @param {string} scoutId
 * @returns {object | null}
 */
function findScoutProfile(profile, scoutId) {
  if (profile && String(profile.id ?? '') === scoutId) return profile;
  return scoutProfilesState.profiles.find((row) => String(row?.id ?? '') === scoutId) || null;
}

/**
 * @param {string} templateId
 * @returns {string}
 */
function scoutTemplateName(templateId) {
  const id = String(templateId || '').trim();
  if (!id) return '';
  const template = scoutEditorState.templates.find((row) => String(row?.id ?? '') === id);
  return String(template?.name ?? '').trim();
}

/**
 * @param {HTMLElement} root
 * @returns {object}
 */
function restoreView() {
  const meta = scoutEditorState.restoreMeta || {};
  return {
    diff: scoutEditorState.restoreDiff,
    templateId: meta.templateId || '',
    templateVersion: meta.templateVersion || '',
    templateName: meta.templateName || '',
    scoutId: String(meta.scoutId || scoutEditorState.selectedId || '').trim(),
    error: scoutEditorState.restoreError,
    busy: scoutEditorState.busy,
  };
}

/**
 * Repaint the editor card, the template grid, the preview and the restore card
 * from the module state. The containers are replaced on every full render, so
 * the delegated listeners can never accumulate.
 *
 * @param {HTMLElement} root
 */
function paintScoutEditor(root) {
  const editorNode = root.querySelector('#watcher-scout-editor');
  if (editorNode) {
    editorNode.innerHTML = renderScoutEditorHtml({
      ...scoutEditorState,
      profiles: scoutProfilesState.profiles,
      now: Date.now(),
    });
  }
  const templatesNode = root.querySelector('#watcher-scout-templates');
  if (templatesNode) {
    templatesNode.innerHTML = renderScoutTemplatesHtml({
      templates: scoutEditorState.templates,
      busy: scoutEditorState.busy,
    });
  }
  const previewNode = root.querySelector('#watcher-scout-preview');
  if (previewNode) {
    previewNode.innerHTML = renderScoutPreviewHtml({
      preview: scoutEditorState.preview,
      error: scoutEditorState.previewError,
    });
  }
  const restoreNode = root.querySelector('#watcher-scout-restore');
  if (restoreNode) restoreNode.innerHTML = renderScoutRestoreHtml(restoreView());
}

/**
 * Live repaint rule: while a draft is dirty only the list card is repainted; the
 * editor form is left untouched so an unsaved edit survives a watcher change.
 *
 * @param {HTMLElement} root
 */
function paintScoutEditorLive(root) {
  if (scoutEditorState.dirty === true) {
    paintScoutProfiles(root);
    return;
  }
  paintScoutEditor(root);
}

/**
 * Read one editor input back into the draft. The draft is replaced immutably so
 * the original profile (and any template) is never mutated.
 *
 * @param {HTMLElement} root
 * @param {string} path
 * @param {unknown} rawValue
 */
function applyScoutEditorField(root, path, rawValue) {
  if (!scoutEditorState.draft) return;
  const numeric = path === 'schedule.intervalHours' || path.startsWith('limits.');
  const value = numeric ? (rawValue === '' ? '' : Number(rawValue)) : rawValue;
  let draft = applyDraftEdit(scoutEditorState.draft, path, value);
  // Typing an explicit harness/model is a mode switch: an explicit executor and
  // automatic selection are mutually exclusive, so a non-empty value leaves auto.
  if ((path === 'executor.harness' || path === 'executor.model') && String(value ?? '').trim() !== '') {
    draft = applyDraftEdit(draft, 'executor.auto', false);
    // Reflect the switch in the DOM without rebuilding the form, so focus and
    // caret stay where the operator is typing.
    const autoToggle = root.querySelector('#watcher-scout-editor [data-scout-editor-toggle="executor.auto"]');
    if (autoToggle instanceof HTMLInputElement) autoToggle.checked = false;
  }
  const fieldErrors = { ...scoutEditorState.fieldErrors };
  delete fieldErrors[path];
  scoutEditorState = {
    ...scoutEditorState,
    draft,
    fieldErrors,
    dirty: true,
    error: '',
  };
  const node = root.querySelector(`#watcher-scout-editor [data-scout-field-error="${path}"]`);
  if (node) node.remove();
}

/**
 * Rebuild one include/exclude list from all of its visible inputs.
 *
 * @param {HTMLElement} root
 * @param {string} listPath
 */
function applyScoutEditorListField(root, listPath) {
  if (!scoutEditorState.draft) return;
  const inputs = [...root.querySelectorAll(`#watcher-scout-editor [data-scout-editor-list-field="${listPath}"]`)];
  if (inputs.length === 0) return;
  const values = inputs.map((node) => String(node.value ?? ''));
  scoutEditorState = {
    ...scoutEditorState,
    draft: applyDraftEdit(scoutEditorState.draft, listPath, values),
    dirty: true,
    error: '',
  };
}

/**
 * Toggle one checkbox group or boolean flag in the draft. Categories are forced
 * non-empty: unchecking the last one keeps it and shows the inline error.
 *
 * @param {HTMLElement} root
 * @param {string} toggle
 * @param {string} value
 * @param {boolean} checked
 */
function applyScoutEditorToggle(root, toggle, value, checked) {
  const draft = scoutEditorState.draft;
  if (!draft) return;
  if (toggle === 'enabled' || toggle === 'executor.auto') {
    let nextDraft = applyDraftEdit(draft, toggle, checked);
    // Re-checking automatic selection clears the explicit executor the runner
    // would ignore, so a stored profile can never carry a stale value.
    if (toggle === 'executor.auto' && checked) {
      nextDraft = applyDraftEdit(nextDraft, 'executor.harness', '');
      nextDraft = applyDraftEdit(nextDraft, 'executor.model', '');
    }
    scoutEditorState = {
      ...scoutEditorState,
      draft: nextDraft,
      dirty: true,
      error: '',
    };
    // The explicit inputs enable or disable with the mode, so the DOM repaints.
    if (toggle === 'executor.auto') paintScoutEditor(root);
    return;
  }
  const path = toggle === 'executor.allowedHarnesses' ? 'executor.allowedHarnesses' : toggle;
  const current = toggle === 'executor.allowedHarnesses'
    ? [...(draft.executor?.allowedHarnesses || [])]
    : [...(toggle === 'sources' ? draft.sources : draft.categories)];
  const next = checked
    ? [...new Set([...current, value])]
    : current.filter((entry) => String(entry) !== String(value));
  if (toggle === 'categories' && next.length === 0) {
    scoutEditorState = {
      ...scoutEditorState,
      fieldErrors: {
        ...scoutEditorState.fieldErrors,
        categories: t('settings.watcherScoutFieldErrors_categoriesRequired'),
      },
      // The inline error lives inside the Advanced section; keep it visible.
      advancedOpen: true,
    };
    paintScoutEditor(root);
    return;
  }
  const fieldErrors = { ...scoutEditorState.fieldErrors };
  if (toggle === 'categories') delete fieldErrors.categories;
  scoutEditorState = {
    ...scoutEditorState,
    draft: applyDraftEdit(draft, path, next),
    fieldErrors,
    dirty: true,
    error: '',
  };
  paintScoutEditor(root);
}

/**
 * One editor action. Every branch keeps the draft on screen on a validation
 * error, and only clears it after the server confirmed a save.
 *
 * @param {HTMLElement} root
 * @param {string} action
 * @param {string} scoutId
 */
async function runScoutEditorAction(root, action, scoutId) {
  const selectedId = String(scoutId || scoutEditorState.selectedId || '').trim();
  const profile = findScoutProfile(scoutEditorState.originalProfile, selectedId);
  const removeIndex = scoutEditorRemoveIndex;
  scoutEditorRemoveIndex = -1;

  if (action === 'new-profile') {
    scoutEditorState = {
      ...EMPTY_SCOUT_EDITOR_STATE,
      templates: scoutEditorState.templates,
      selectedId,
      mode: 'create',
      draft: applyDraftEdit(draftFromProfile(null), 'name',
        nextScoutProfileName(scoutProfilesState.profiles.map((row) => row?.name))),
      dirty: false,
    };
    scoutEditorState.draft = applyDraftEdit(
      scoutEditorState.draft,
      'objective',
      t('settings.watcherScoutNewDefaultObjective'),
    );
    paintScoutEditor(root);
    return;
  }
  if (action === 'edit') {
    if (!profile) return;
    scoutEditorState = {
      ...EMPTY_SCOUT_EDITOR_STATE,
      templates: scoutEditorState.templates,
      selectedId,
      mode: 'edit',
      draft: draftFromProfile(profile),
      originalProfile: profile,
    };
    paintScoutEditor(root);
    return;
  }
  if (action === 'from-template') {
    scoutEditorState = { ...scoutEditorState, busy: true, error: '' };
    paintScoutEditor(root);
    let templates = scoutEditorState.templates;
    if (templates.length === 0) {
      const res = await watcherApi('/api/workspace-watcher/scout/templates').catch(() => null);
      if (res?.json?.ok && Array.isArray(res.json.templates)) {
        templates = res.json.templates;
        scoutEditorState = { ...scoutEditorState, templates, busy: false, error: '' };
      } else {
        scoutEditorState = {
          ...scoutEditorState,
          busy: false,
          error: res?.json?.error || t('settings.watcherScoutEditorFromTemplateError'),
        };
      }
    } else {
      scoutEditorState = { ...scoutEditorState, busy: false };
    }
    paintScoutEditor(root);
    return;
  }
  if (action === 'template-pick') {
    const template = scoutEditorState.templates.find((row) => String(row?.id ?? '') === selectedId) || null;
    if (!template) return;
    scoutEditorState = {
      ...EMPTY_SCOUT_EDITOR_STATE,
      templates: scoutEditorState.templates,
      selectedId,
      mode: 'from-template',
      draft: draftFromTemplate(template),
    };
    paintScoutEditor(root);
    return;
  }
  if (action === 'cancel' || action === 'close') {
    scoutEditorState = {
      ...EMPTY_SCOUT_EDITOR_STATE,
      templates: scoutEditorState.templates,
      selectedId,
    };
    paintScoutEditor(root);
    return;
  }
  if (action === 'add-include' || action === 'add-exclude') {
    const listPath = action === 'add-include' ? 'scope.include' : 'scope.exclude';
    const current = action === 'add-include'
      ? [...(scoutEditorState.draft?.scope?.include || [])]
      : [...(scoutEditorState.draft?.scope?.exclude || [])];
    current.push('');
    scoutEditorState = {
      ...scoutEditorState,
      draft: applyDraftEdit(scoutEditorState.draft, listPath, current),
      dirty: true,
      error: '',
    };
    paintScoutEditor(root);
    return;
  }
  if (action === 'remove-include' || action === 'remove-exclude') {
    const listPath = action === 'remove-include' ? 'scope.include' : 'scope.exclude';
    const index = Math.max(0, Math.floor(Number(removeIndex) || 0));
    const current = action === 'remove-include'
      ? [...(scoutEditorState.draft?.scope?.include || [])]
      : [...(scoutEditorState.draft?.scope?.exclude || [])];
    current.splice(index, 1);
    scoutEditorState = {
      ...scoutEditorState,
      draft: applyDraftEdit(scoutEditorState.draft, listPath, current),
      dirty: true,
      error: '',
    };
    paintScoutEditor(root);
    return;
  }
  if (action === 'preview') {
    const draft = scoutEditorState.draft;
    let res;
    if (draft) {
      res = await watcherApi('/api/workspace-watcher/scout/profiles/preview-draft', {
        method: 'POST',
        body: { profile: stripScoutEditorDraft(draft) },
      }).catch(() => null);
    } else {
      if (!selectedId) return;
      res = await watcherApi(`/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}/preview`)
        .catch(() => null);
    }
    if (res?.json?.ok) {
      scoutEditorState = { ...scoutEditorState, preview: res.json, previewError: '' };
    } else {
      scoutEditorState = {
        ...scoutEditorState,
        preview: null,
        previewError: res?.json?.error || t('settings.watcherScoutEditorPreviewError'),
      };
    }
    paintScoutEditor(root);
    return;
  }
  if (action === 'restore-diff') {
    if (!selectedId) {
      scoutEditorState = { ...scoutEditorState, restoreError: t('settings.watcherScoutEditorNoRestoreTemplate') };
      paintScoutEditor(root);
      return;
    }
    const target = findScoutProfile(scoutEditorState.originalProfile, selectedId);
    if (!target || !String(target.templateId || '').trim()) {
      scoutEditorState = { ...scoutEditorState, restoreError: t('settings.watcherScoutEditorNoRestoreTemplate') };
      paintScoutEditor(root);
      return;
    }
    scoutEditorState = { ...scoutEditorState, busy: true, restoreError: '' };
    paintScoutEditor(root);
    const res = await watcherApi(
      `/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}/restore-diff`,
    ).catch(() => null);
    if (res?.json?.ok) {
      const templateId = String(res.json.templateId || target.templateId || '').trim();
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        restoreError: '',
        restoreDiff: Array.isArray(res.json.diff) ? res.json.diff : [],
        restoreMeta: {
          templateId,
          templateVersion: String(res.json.templateVersion || ''),
          templateName: scoutTemplateName(templateId) || templateId,
          scoutId: selectedId,
        },
      };
    } else {
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        restoreDiff: null,
        restoreMeta: null,
        restoreError: res?.json?.error || t('settings.watcherScoutEditorRestoreDiffError'),
      };
    }
    paintScoutEditor(root);
    return;
  }
  if (action === 'restore-cancel') {
    scoutEditorState = {
      ...scoutEditorState,
      restoreDiff: null,
      restoreMeta: null,
      restoreError: '',
    };
    paintScoutEditor(root);
    return;
  }
  if (action === 'restore-confirm') {
    if (!profile) return;
    scoutEditorState = { ...scoutEditorState, busy: true, restoreError: '' };
    paintScoutEditor(root);
    const res = await watcherApi(
      `/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}/restore`,
      {
        method: 'POST',
        body: {
          expectedRevision: Math.max(1, Math.floor(Number(profile.revision) || 1)),
          confirm: true,
        },
      },
    ).catch(() => null);
    if (res?.json?.ok) {
      setScoutProfilesMessage(t('settings.watcherScoutEditorRestoreApplied'), 'ok');
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        restoreDiff: null,
        restoreMeta: null,
        restoreError: '',
        casConflict: false,
        dirty: false,
        draft: scoutEditorState.draft ? draftFromProfile(res.json.profile) : scoutEditorState.draft,
        originalProfile: res.json.profile || scoutEditorState.originalProfile,
      };
      await reloadScoutProfiles(root);
    } else if (res?.status === 409) {
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        restoreError: t('settings.watcherScoutEditorCasConflict'),
      };
    } else {
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        restoreError: res?.json?.error || t('settings.watcherScoutEditorRestoreError'),
      };
    }
    paintScoutEditor(root);
    return;
  }
  if (action === 'reload-profile') {
    if (!selectedId) return;
    scoutEditorState = { ...scoutEditorState, busy: true, error: '' };
    paintScoutEditor(root);
    const res = await watcherApi(`/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}`)
      .catch(() => null);
    if (res?.json?.ok && res.json.profile) {
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        casConflict: false,
        error: '',
        dirty: false,
        fieldErrors: {},
        mode: 'edit',
        originalProfile: res.json.profile,
        draft: draftFromProfile(res.json.profile),
      };
    } else {
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        casConflict: false,
        error: res?.json?.error || t('settings.watcherScoutEditorProfileError'),
      };
    }
    paintScoutEditor(root);
    return;
  }
  if (action === 'overwrite') {
    const draft = scoutEditorState.draft;
    if (!draft || !selectedId) return;
    scoutEditorState = { ...scoutEditorState, busy: true, error: '' };
    paintScoutEditor(root);
    const fresh = await watcherApi(`/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}`)
      .catch(() => null);
    if (!(fresh?.json?.ok && fresh.json.profile)) {
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        error: fresh?.json?.error || t('settings.watcherScoutEditorProfileError'),
      };
      paintScoutEditor(root);
      return;
    }
    const revision = Math.max(1, Math.floor(Number(fresh.json.profile.revision) || 1));
    const res = await watcherApi(
      `/api/workspace-watcher/scout/profiles/${encodeURIComponent(selectedId)}`,
      {
        method: 'PATCH',
        body: { expectedRevision: revision, profile: stripScoutEditorDraft({ ...draft, revision }) },
      },
    ).catch(() => null);
    if (res?.json?.ok) {
      setScoutProfilesMessage(t('settings.watcherScoutEditorSaved'), 'ok');
      scoutEditorState = {
        ...EMPTY_SCOUT_EDITOR_STATE,
        templates: scoutEditorState.templates,
        selectedId,
      };
      await reloadScoutProfiles(root);
      if (res.json.profile) {
        scoutEditorState = {
          ...scoutEditorState,
          mode: 'edit',
          originalProfile: res.json.profile,
          draft: draftFromProfile(res.json.profile),
        };
      }
    } else if (res?.status === 409) {
      scoutEditorState = { ...scoutEditorState, busy: false, casConflict: true, error: '' };
    } else {
      scoutEditorState = {
        ...scoutEditorState,
        busy: false,
        error: res?.json?.error || t('settings.watcherScoutEditorOverwriteError'),
      };
    }
    paintScoutEditor(root);
    return;
  }
  if (action === 'save') {
    const draft = scoutEditorState.draft;
    if (!draft) return;
    const fieldErrors = scoutEditorFieldErrors(draft);
    if (Object.keys(fieldErrors).length > 0) {
      scoutEditorState = {
        ...scoutEditorState,
        fieldErrors,
        error: '',
        casConflict: false,
        dirty: true,
        // A rejected Advanced field must reveal the section that owns it.
        advancedOpen: scoutEditorAdvancedFieldError(fieldErrors) || scoutEditorState.advancedOpen === true,
      };
      paintScoutEditor(root);
      return;
    }
    const mode = scoutEditorState.mode;
    scoutEditorState = { ...scoutEditorState, busy: true, error: '', fieldErrors: {}, casConflict: false };
    paintScoutEditor(root);
    let res;
    if (mode === 'from-template') {
      res = await watcherApi('/api/workspace-watcher/scout/profiles/from-template', {
        method: 'POST',
        body: { templateId: draft.templateId, overrides: templateOverridesFromDraft(draft) },
      }).catch(() => null);
    } else if (mode === 'create') {
      res = await watcherApi('/api/workspace-watcher/scout/profiles', {
        method: 'POST',
        body: { profile: stripScoutEditorDraft(draft) },
      }).catch(() => null);
    } else {
      const id = String(draft.id || scoutEditorState.originalProfile?.id || '').trim();
      res = await watcherApi(`/api/workspace-watcher/scout/profiles/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: {
          expectedRevision: Math.max(1, Math.floor(Number(draft.revision) || 1)),
          profile: stripScoutEditorDraft(draft),
        },
      }).catch(() => null);
    }
    if (res?.status === 409) {
      scoutEditorState = { ...scoutEditorState, busy: false, casConflict: true, error: '' };
      paintScoutEditor(root);
      return;
    }
    if (res?.json?.ok === true) {
      setScoutProfilesMessage(t('settings.watcherScoutEditorSaved'), 'ok');
      scoutEditorState = {
        ...EMPTY_SCOUT_EDITOR_STATE,
        templates: scoutEditorState.templates,
        selectedId,
      };
      await reloadScoutProfiles(root);
      paintScoutEditor(root);
      return;
    }
    scoutEditorState = {
      ...scoutEditorState,
      busy: false,
      error: res?.json?.error || t('settings.watcherActionError'),
    };
    paintScoutEditor(root);
  }
}

/**
 * Bind the editor's input/change delegation. The editor container is replaced on
 * every full render, so the listeners never accumulate; a draft edit never
 * rebuilds the form, so typing cannot lose focus.
 *
 * @param {HTMLElement} root
 */
function bindScoutEditor(root) {
  const container = root.querySelector('#watcher-scout-editor');
  if (!container) return;
  container.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const path = target.getAttribute('data-scout-editor-field');
    if (path) {
      applyScoutEditorField(root, path, target.value);
      return;
    }
    const listPath = target.getAttribute('data-scout-editor-list-field');
    if (listPath) applyScoutEditorListField(root, listPath);
  });
  container.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('[data-scout-editor-select]')) {
      scoutEditorState = { ...scoutEditorState, selectedId: String(target.value || '').trim() };
      paintScoutEditor(root);
      return;
    }
    const path = target.getAttribute('data-scout-editor-field');
    if (path) {
      applyScoutEditorField(root, path, target.value);
      return;
    }
    const toggle = target.getAttribute('data-scout-editor-toggle');
    if (toggle) applyScoutEditorToggle(root, toggle, target.value, target.checked === true);
  });
  // `<details>` fires `toggle`, but the event does not bubble; a capture-phase
  // listener on the container is the only way to record the open state before a
  // repaint rebuilds the element.
  container.addEventListener('toggle', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('details.watcher-scout-editor-advanced')) {
      scoutEditorState = { ...scoutEditorState, advancedOpen: target.open === true };
    }
  }, true);
}

/**
 * Repaint only the cycle schedule card from the cached view. No-op on the paths
 * where the Settings tab was never rendered.
 *
 * @param {HTMLElement} root
 */
function paintWatcherSchedule(root) {
  const node = root.querySelector('#watcher-schedule-info');
  if (!node || !lastView) return;
  node.innerHTML = renderWatcherScheduleHtml(lastView.schedule || {}, Date.now());
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
  // The monitoring dashboard, the Scout schedule card and the cycle schedule
  // card all render a live countdown, so the per-second ticker follows them.
  if (tab === 'monitor' || tab === 'scout' || tab === 'status') {
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
  const worktree = policy.worktree && typeof policy.worktree === 'object' ? policy.worktree : {};
  const worktreeDefault = String(policy.executionMode || '').trim() === 'worktree';
  // The server suggests a safe layout derived from the workspace (Git root,
  // folder name, lockfile) so an empty record does not render as blank
  // placeholders. A stored value always wins; the suggestion fills only gaps.
  const suggested = data.executionSuggest && typeof data.executionSuggest === 'object' ? data.executionSuggest : null;
  const suggestedWorktree = suggested?.worktree && typeof suggested.worktree === 'object' ? suggested.worktree : {};
  const worktreeText = (key) => {
    const stored = String(worktree[key] ?? '').trim();
    return stored || String(suggestedWorktree[key] ?? '').trim();
  };
  const storedPrepare = Array.isArray(worktree.prepareCommand) ? worktree.prepareCommand.filter(Boolean) : [];
  const worktreePrepare = storedPrepare.length
    ? storedPrepare
    : (Array.isArray(suggestedWorktree.prepareCommand) ? suggestedWorktree.prepareCommand : []);
  const worktreeSuggested = Boolean(suggested?.available) && !String(worktree.root ?? '').trim();
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
    <div class="cr-card watcher-status-card">
      <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherScheduleTitle'))}</h4>
      <p class="cr-hint">${escapeHtml(t('settings.watcherScheduleHint'))}</p>
      <div id="watcher-schedule-info">${renderWatcherScheduleHtml(data.schedule || {}, Date.now())}</div>
    </div>
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
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherWorktree'))}</h4>
        <p class="cr-hint">${escapeHtml(t('settings.watcherWorktreeHint'))}</p>
        <div class="cr-field">
          <span class="cr-field-label">${escapeHtml(t('settings.watcherExecutionMode'))}</span>
          <div class="watcher-mode-list">
            <label class="cr-check"><input type="radio" name="watcher-execution-mode" value="project"${worktreeDefault ? '' : ' checked'}> ${escapeHtml(t('settings.watcherExecutionModeProject'))}</label>
            <label class="cr-check"><input type="radio" name="watcher-execution-mode" value="worktree"${worktreeDefault ? ' checked' : ''}> ${escapeHtml(t('settings.watcherExecutionModeWorktree'))}</label>
          </div>
        </div>
        <div class="watcher-grid">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherWorktreeRoot'))}</span><input id="watcher-worktree-root" type="text" placeholder="/var/lib/cretli/worktrees" value="${escapeAttr(worktreeText('root'))}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherWorktreeNamespace'))}</span><input id="watcher-worktree-namespace" type="text" placeholder="my-workspace" value="${escapeAttr(worktreeText('namespace'))}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherWorktreeBranchPrefix'))}</span><input id="watcher-worktree-branch-prefix" type="text" placeholder="cretli/todo/" value="${escapeAttr(worktreeText('branchPrefix'))}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherWorktreeDirectoryPrefix'))}</span><input id="watcher-worktree-directory-prefix" type="text" placeholder="t-" value="${escapeAttr(worktreeText('directoryPrefix'))}"></label>
        </div>
        <label class="cr-field watcher-wide"><span class="cr-field-label">${escapeHtml(t('settings.watcherWorktreePrepare'))}</span><textarea id="watcher-worktree-prepare" rows="3" placeholder="npm&#10;ci">${escapeHtml(prepareCommandText(worktreePrepare))}</textarea></label>
        ${worktreeSuggested ? `<p class="cr-hint">${escapeHtml(t('settings.watcherWorktreeSuggestedHint'))} <code>${escapeHtml(suggested?.repoRoot || '')}</code></p>` : ''}
        <p class="cr-hint">${escapeHtml(t('settings.watcherWorktreePrepareHint'))}</p>
      </section>

      <section class="watcher-section">
        <h4 class="watcher-section-title">${escapeHtml(t('settings.watcherLimits'))}</h4>
        <div class="watcher-grid">
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxCyclesPerDay'))}</span><input id="watcher-max-cycles" type="number" min="0" value="${Number(policy.maxCyclesPerDay) || 0}"></label>
          <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherMaxParallel'))}</span><input id="watcher-max-parallel" type="number" min="1" max="10" value="${Number(policy.maxParallel) || 1}"></label>
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
    <div id="watcher-scout-editor">${renderScoutEditorHtml({ ...scoutEditorState, profiles: scoutProfilesState.profiles, now: Date.now() })}</div>
    <div id="watcher-scout-templates">${renderScoutTemplatesHtml({ templates: scoutEditorState.templates, busy: scoutEditorState.busy })}</div>
    <div id="watcher-scout-profiles">${renderScoutProfilesHtml({ ...scoutProfilesState, now: Date.now() })}</div>
    <div id="watcher-scout-history">${renderScoutHistoryHtml({ ...scoutHistoryState, profiles: scoutProfilesState.profiles })}</div>
    <div id="watcher-scout-inbox">${renderScoutInboxHtml({
      ...scoutInboxState,
      profiles: scoutProfilesState.profiles,
      autoCreate: policy.scoutAutoCreate === true,
      getTodoTitle,
    })}</div>
    <div id="watcher-scout-preview">${renderScoutPreviewHtml({ preview: scoutEditorState.preview, error: scoutEditorState.previewError })}</div>
    <div id="watcher-scout-restore">${renderScoutRestoreHtml(restoreView())}</div>
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
        <label class="cr-field"><span class="cr-field-label">${escapeHtml(t('settings.watcherScoutMaxParallel'))}</span><input id="watcher-scout-max-parallel" type="number" min="1" max="10" value="${Number(policy.scoutMaxParallel) || 1}"></label>
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
  // Clear-stop is a real loop-stop reset (wipes failures/backoff/unblocks parked
  // todos) on the server, not a plain PATCH that only clears stopReason — route
  // it to the dedicated endpoint so a human resume does not immediately re-stop.
  root.querySelector('#watcher-clear-stop')?.addEventListener('click', () => watcherAction(root, 'clear_stop'));
  root.querySelector('#watcher-clear-backoff')?.addEventListener('click', () => saveWatcher(root, { failures: {}, backoffUntil: '' }));
  root.querySelector('#watcher-claim')?.addEventListener('click', () => watcherAction(root, 'claim_next'));
  root.querySelector('#watcher-reset-plan')?.addEventListener('click', () => watcherAction(root, 'reset_plan_requests'));
  root.querySelector('#watcher-record-findings')?.addEventListener('click', () => watcherAction(root, 'record_findings'));
  root.querySelector('#watcher-scout-run')?.addEventListener('click', () => runScoutNow(root));
  bindScoutProfiles(root);
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
      executionMode: root.querySelector('input[name="watcher-execution-mode"]:checked')?.value === 'worktree' ? 'worktree' : 'project',
      worktree: {
        root: String(root.querySelector('#watcher-worktree-root')?.value || '').trim(),
        namespace: String(root.querySelector('#watcher-worktree-namespace')?.value || '').trim(),
        branchPrefix: String(root.querySelector('#watcher-worktree-branch-prefix')?.value || '').trim(),
        directoryPrefix: String(root.querySelector('#watcher-worktree-directory-prefix')?.value || '').trim(),
        prepareCommand: readPrepareCommandLines(root),
      },
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
 * `normalizeWorkspaceWatcherPolicy` clamps to (maxParallel 1..10).
 *
 * @param {HTMLElement} root
 * @returns {string[]}
 */
function validateWatcherForm(root) {
  const errors = [];
  const maxParallel = Number(root.querySelector('#watcher-max-parallel')?.value);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) {
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
    if (!Number.isInteger(scoutMaxParallel) || scoutMaxParallel < 1 || scoutMaxParallel > 10) {
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
  // A `worktree` default (or a half-filled layout the operator is preparing)
  // must be complete and safe before it can ever reach a start. The server is
  // fail-closed too, so this only makes the refusal readable in the form.
  const executionMode = root.querySelector('input[name="watcher-execution-mode"]:checked')?.value === 'worktree'
    ? 'worktree'
    : 'project';
  const layout = {
    root: String(root.querySelector('#watcher-worktree-root')?.value || '').trim(),
    namespace: String(root.querySelector('#watcher-worktree-namespace')?.value || '').trim(),
    branchPrefix: String(root.querySelector('#watcher-worktree-branch-prefix')?.value || '').trim(),
    directoryPrefix: String(root.querySelector('#watcher-worktree-directory-prefix')?.value || '').trim(),
  };
  const layoutStarted = Object.values(layout).some((value) => value !== '');
  if (executionMode === 'worktree' || layoutStarted) {
    if (!layout.root || !layout.namespace || !layout.branchPrefix || !layout.directoryPrefix) {
      // The server backfills a missing layout from the workspace suggestion, so
      // "enable worktree mode and save" is enough. Only a workspace with no
      // suggestion (no Git repository) must be refused before the round-trip.
      if (lastView?.executionSuggest?.available !== true) {
        errors.push(t('settings.watcherValidationWorktree'));
      }
    } else {
      if (!ABSOLUTE_PATH_RE.test(layout.root)) {
        errors.push(t('settings.watcherValidationWorktreeRoot'));
      }
      if (/[\\/]/.test(layout.namespace) || layout.namespace === '.' || layout.namespace === '..') {
        errors.push(t('settings.watcherValidationWorktreeNamespace'));
      }
    }
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
  const defaultExecutionRadio = root.querySelector(`input[name="watcher-execution-mode"][value="${DEFAULT_POLICY.executionMode}"]`);
  if (defaultExecutionRadio) defaultExecutionRadio.checked = true;
  // Keep the worktree fields usable after a reset: prefer the workspace-derived
  // suggestion, so the operator never lands on an empty layout that only the
  // server could complete.
  const resetWorktree = lastView?.executionSuggest?.worktree && typeof lastView.executionSuggest.worktree === 'object'
    ? lastView.executionSuggest.worktree
    : DEFAULT_POLICY.worktree;
  set('watcher-worktree-root', resetWorktree.root);
  set('watcher-worktree-namespace', resetWorktree.namespace);
  set('watcher-worktree-branch-prefix', resetWorktree.branchPrefix);
  set('watcher-worktree-directory-prefix', resetWorktree.directoryPrefix);
  set('watcher-worktree-prepare', (Array.isArray(resetWorktree.prepareCommand) ? resetWorktree.prepareCommand : []).join('\n'));
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
  clear_stop: '/api/workspace-watcher/clear-stop',
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
  const blockedReason = scoutRunResultText(json);
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
  await refreshScoutHistoryAndInbox(root, json?.scout);
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
  paintWatcherSchedule(root);
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
  const statusCard = root.querySelector('#watcher-status-card');
  const scheduleInfo = root.querySelector('#watcher-schedule-info');
  const scoutProfiles = root.querySelector('#watcher-scout-profiles');
  // Any countdown surface keeps the ticker alive; when none is on screen
  // (a hidden tab, a detached panel) the ticker stops instead of spinning.
  if (!dashboardIsVisible(container) && !dashboardIsVisible(scoutSchedule)
    && !dashboardIsVisible(statusCard)
    && !dashboardIsVisible(scoutProfiles)
    && !dashboardIsVisible(scheduleInfo)) {
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
 * Bind one delegated click handler onto the Scout profile list container. The
 * container is replaced on every full render, so listeners never accumulate.
 * Every rendered action (see `SCOUT_PROFILE_ACTIONS`) is dispatched here, so a
 * button in the list is never a dead action.
 *
 * @param {HTMLElement} root
 */
function bindScoutProfiles(root) {
  // One delegated click listener per swapped container: the main profile list
  // (SCOUT_PROFILE_ACTIONS) plus the stage-5.2 editor surfaces
  // (SCOUT_EDITOR_ACTIONS). Every rendered action is declared in one of the two
  // sets, so a button can never be a dead action.
  const containers = [
    root.querySelector('#watcher-scout-profiles'),
    root.querySelector('#watcher-scout-history'),
    root.querySelector('#watcher-scout-inbox'),
    root.querySelector('#watcher-scout-editor'),
    root.querySelector('#watcher-scout-templates'),
    root.querySelector('#watcher-scout-restore'),
  ].filter(Boolean);
  for (const container of containers) {
    container.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('[data-scout-action],[data-scout-editor-action],[data-scout-history-action],[data-scout-inbox-action]')
        : null;
      if (!target || target.disabled === true) return;
      const historyAction = String(target.getAttribute('data-scout-history-action') || '').trim();
      if (historyAction) {
        if (!SCOUT_HISTORY_ACTIONS.includes(historyAction)) return;
        void runScoutHistoryAction(root, historyAction);
        return;
      }
      const inboxAction = String(target.getAttribute('data-scout-inbox-action') || '').trim();
      if (inboxAction) {
        if (!SCOUT_INBOX_ACTIONS.includes(inboxAction)) return;
        void runScoutInboxAction(
          root,
          inboxAction,
          String(target.getAttribute('data-scout-finding-id') || '').trim(),
          String(target.getAttribute('data-scout-todo-id') || '').trim(),
        );
        return;
      }
      const editorAction = String(target.getAttribute('data-scout-editor-action') || '').trim();
      if (editorAction) {
        if (!SCOUT_EDITOR_ACTIONS.includes(editorAction)) return;
        scoutEditorRemoveIndex = Number(target.getAttribute('data-scout-editor-index'));
        void runScoutProfileAction(root, editorAction, String(target.getAttribute('data-scout-id') || '').trim());
        return;
      }
      const action = String(target.getAttribute('data-scout-action') || '').trim();
      if (!SCOUT_PROFILE_ACTIONS.includes(action)) return;
      const scoutId = String(target.getAttribute('data-scout-id') || '').trim();
      void runScoutProfileAction(root, action, scoutId);
    });
  }
  bindScoutHistoryInboxFilters(root);
  bindScoutEditor(root);
}

/**
 * Server-side filter changes for history and inbox (native `<select>` controls).
 *
 * @param {HTMLElement} root
 */
function bindScoutHistoryInboxFilters(root) {
  root.querySelector('#watcher-scout-history')?.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute('data-scout-history-filter') !== 'scoutId') return;
    scoutHistoryState = {
      ...scoutHistoryState,
      scoutId: String(target.value || '').trim(),
      max: SCOUT_HISTORY_PAGE_SIZE,
      message: '',
      messageTone: 'ok',
    };
    void reloadScoutHistory(root);
  });
  root.querySelector('#watcher-scout-inbox')?.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const filter = String(target.getAttribute('data-scout-inbox-filter') || '').trim();
    if (!filter || !['scoutId', 'category', 'status'].includes(filter)) return;
    scoutInboxState = {
      ...scoutInboxState,
      [filter]: String(target.value || '').trim(),
      max: SCOUT_INBOX_PAGE_SIZE,
      message: '',
      messageTone: 'ok',
    };
    void reloadScoutInbox(root);
  });
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
      void watcherAction(root, 'clear_stop');
      return;
    }
    if (String(target.getAttribute('data-watcher-action') || '') === 'clear-backoff') {
      // Same reset the Actions tab button performs: drop the failure counts and
      // release the backoff timer in one PATCH.
      void saveWatcher(root, { failures: {}, backoffUntil: '' });
    }
  });
  // The cycle-schedule card (Settings tab) sits outside the dashboard container,
  // so its inline clear-backoff button needs its own delegated listener.
  root.querySelector('#watcher-schedule-info')?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-watcher-action="clear-backoff"]') : null;
    if (target) void saveWatcher(root, { failures: {}, backoffUntil: '' });
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
