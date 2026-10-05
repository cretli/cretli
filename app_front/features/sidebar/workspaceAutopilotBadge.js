/**
 * Sidebar Workspace Watcher badge.
 *
 * The sidebar already receives a coalesced `agentPresence` frame on the chat-list
 * WebSocket. That frame now carries a compact per-workspace watcher summary, so
 * an active autopilot is visible on the workspace header without any extra
 * socket or polling. This module is a tiny client-side store fed from
 * `chat.js` and read by `sidebarView.js`.
 */

import { t } from '../../i18n/index.js';

/** @type {Map<string, { mode: string, paused: boolean, stopReason: string, pinnedChatId: string, activeCycleCount: number, activeCycleChatId: string, activeCycleChatIds: string[], activeCycleTodoIds: string[] }>} */
const watchersByFolder = new Map();
let revision = 0;

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeFolder(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

/**
 * Normalize one presence row's live-cycle summary. `activeCycleCount` is the
 * authoritative number when present; older frames only ship the slot-0 fields.
 *
 * @param {object} row
 * @returns {{ activeCycleCount: number, activeCycleChatId: string, activeCycleChatIds: string[], activeCycleTodoIds: string[] }}
 */
function normalizeCyclePresence(row) {
  const chatIds = Array.isArray(row?.activeCycleChatIds)
    ? row.activeCycleChatIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const primary = String(row?.activeCycleChatId || chatIds[0] || '').trim();
  const declared = Number(row?.activeCycleCount);
  const count = Number.isFinite(declared) && declared > 0
    ? Math.floor(declared)
    : (chatIds.length || (primary ? 1 : 0));
  return {
    activeCycleCount: count,
    activeCycleChatId: primary,
    activeCycleChatIds: chatIds,
    activeCycleTodoIds: Array.isArray(row?.activeCycleTodoIds)
      ? row.activeCycleTodoIds.map((value) => String(value || '')).filter(Boolean)
      : [],
  };
}

/**
 * Replace the watcher store from one presence frame. Returns true when the
 * content actually changed, so the caller can skip a sidebar repaint.
 *
 * @param {object[]} rows
 * @returns {boolean}
 */
export function applyWorkspaceWatcherPresence(rows) {
  /** @type {Map<string, object>} */
  const next = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const folder = normalizeFolder(row?.workspaceFolder);
    if (!folder) continue;
    next.set(folder, {
      mode: String(row.mode || 'off'),
      paused: row.paused === true,
      stopReason: String(row.stopReason || ''),
      pinnedChatId: String(row.pinnedChatId || '').trim(),
      ...normalizeCyclePresence(row),
    });
  }
  const unchanged = next.size === watchersByFolder.size
    && [...next].every(([folder, row]) => {
      const prev = watchersByFolder.get(folder);
      return prev
        && prev.mode === row.mode
        && prev.paused === row.paused
        && prev.stopReason === row.stopReason
        && prev.pinnedChatId === row.pinnedChatId
        && prev.activeCycleCount === row.activeCycleCount
        && prev.activeCycleChatId === row.activeCycleChatId
        && prev.activeCycleChatIds.join('\u0000') === row.activeCycleChatIds.join('\u0000');
    });
  watchersByFolder.clear();
  for (const [folder, row] of next) watchersByFolder.set(folder, row);
  if (!unchanged) revision += 1;
  return !unchanged;
}

/**
 * Monotonic content revision; folded into the sidebar render signature so a
 * watcher change alone repaints the workspace headers.
 *
 * @returns {number}
 */
export function workspaceWatcherPresenceRevision() {
  return revision;
}

/**
 * @param {unknown} folder
 * @returns {{ mode: string, paused: boolean, stopReason: string, pinnedChatId: string, activeCycleCount: number, activeCycleChatId: string, activeCycleChatIds: string[], activeCycleTodoIds: string[] } | null}
 */
export function getWorkspaceWatcherBadge(folder) {
  return watchersByFolder.get(normalizeFolder(folder)) || null;
}

/**
 * Optimistic local mode flip after a successful sidebar toggle, so the row
 * repaints before the next `agentPresence` frame reconciles it. A workspace that
 * has never had a watcher row gets a minimal synthetic one; the next presence
 * frame replaces the whole map, so it never outlives the round-trip. Returns true
 * when the stored state changed.
 *
 * @param {string} folder
 * @param {string} mode
 * @returns {boolean}
 */
export function applyWorkspaceWatcherModeLocal(folder, mode) {
  const key = normalizeFolder(folder);
  if (!key) return false;
  const nextMode = String(mode || 'off');
  const existing = watchersByFolder.get(key);
  if (existing && existing.mode === nextMode) return false;
  const row = existing || {
    mode: 'off',
    paused: false,
    stopReason: '',
    pinnedChatId: '',
    activeCycleCount: 0,
    activeCycleChatId: '',
    activeCycleChatIds: [],
    activeCycleTodoIds: [],
  };
  watchersByFolder.set(key, { ...row, mode: nextMode });
  revision += 1;
  return true;
}

/**
 * Every workspace that has a durable pinned chat, ordered by folder. The sidebar
 * renders these in its dedicated "Workspace" section, outside the normal chat
 * list. Disabled (`off`) workspaces with a pinned chat are included too, so the
 * "show all" view can turn the watcher back on; the default view uses
 * `listEnabledWorkspaceWatcherPinnedChats()` to hide them.
 *
 * @returns {Array<{ workspaceFolder: string, pinnedChatId: string, mode: string, stopReason: string, paused: boolean }>}
 */
export function listWorkspaceWatcherPinnedChats() {
  return [...watchersByFolder.entries()]
    .filter(([, row]) => Boolean(row.pinnedChatId))
    .map(([workspaceFolder, row]) => ({
      workspaceFolder,
      pinnedChatId: row.pinnedChatId,
      mode: row.mode,
      stopReason: row.stopReason,
      paused: row.paused,
    }))
    .sort((a, b) => a.workspaceFolder.localeCompare(b.workspaceFolder));
}

/**
 * The pinned watcher chats whose watcher is actually running (`observe` or
 * `autopilot`). The sidebar's default view lists exactly these; disabled (`off`)
 * rows only appear in "show all workspaces" mode, where the switch can flip them
 * back on.
 *
 * @returns {Array<{ workspaceFolder: string, pinnedChatId: string, mode: string, stopReason: string, paused: boolean }>}
 */
export function listEnabledWorkspaceWatcherPinnedChats() {
  return listWorkspaceWatcherPinnedChats().filter(
    (row) => String(row.mode || '') !== 'off',
  );
}

/**
 * A workspace group may cover several folders; return the first folder with an
 * enabled watcher. Disabled (`off`) rows are skipped so a pinned-but-off folder
 * never shadows an active one behind the header badge.
 *
 * A clone (`isClone`) is a single-folder view of a multi-folder workspace file,
 * so only its own folder counts. Falling back to the source file's other folders
 * leaked the parent workspace's autopilot badge onto an unrelated clone (e.g.
 * "cretli • Cretli - landing page" showing the `cretli` watcher).
 *
 * @param {object | null | undefined} workspace
 * @param {string} [preferredFolder]
 * @returns {{ mode: string, paused: boolean, stopReason: string, activeCycleCount: number, activeCycleChatId: string, activeCycleChatIds: string[], activeCycleTodoIds: string[] } | null}
 */
export function resolveWorkspaceWatcherBadge(workspace, preferredFolder = '') {
  const folders = Array.isArray(workspace?.folders) ? workspace.folders : [];
  const candidates = workspace?.isClone === true
    ? [preferredFolder]
    : [
      preferredFolder,
      workspace?.workspaceDir,
      workspace?.workspaceFolder,
      ...folders.map((entry) => entry?.resolvedPath || entry?.path || entry?.folder || entry),
    ];
  for (const candidate of candidates) {
    const badge = getWorkspaceWatcherBadge(candidate);
    if (badge && String(badge.mode || '') !== 'off') return badge;
  }
  return null;
}

/**
 * @param {{ mode?: string, paused?: boolean, stopReason?: string, activeCycleCount?: number, activeCycleChatId?: string, activeCycleChatIds?: string[] } | null | undefined} badge
 * @returns {{ state: string, label: string, title: string, count: number } | null}
 */
export function formatWorkspaceAutopilotBadge(badge) {
  if (!badge || String(badge.mode || '') !== 'autopilot') return null;
  const stopReason = String(badge.stopReason || '').trim();
  const chatIds = Array.isArray(badge.activeCycleChatIds)
    ? badge.activeCycleChatIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const declared = Number(badge.activeCycleCount);
  const count = Number.isFinite(declared) && declared > 0
    ? Math.floor(declared)
    : (chatIds.length || (String(badge.activeCycleChatId || '').trim() ? 1 : 0));
  // More than one live slot must be visible, never collapsed to slot 0.
  const cycleStatus = count > 1 ? ` — ${t('sidebar.watcherAutopilotCycles', { count })}` : '';
  if (badge.paused === true) {
    return {
      state: 'paused',
      label: t('sidebar.watcherAutopilotPaused'),
      title: t('sidebar.watcherAutopilotTitle', { mode: 'autopilot', status: ` — ${t('todo.watcherStatusPaused')}${cycleStatus}` }),
      count,
    };
  }
  if (stopReason) {
    return {
      state: 'stopped',
      label: t('sidebar.watcherAutopilotStopped'),
      title: t('sidebar.watcherAutopilotTitle', { mode: 'autopilot', status: ` — ${stopReason}${cycleStatus}` }),
      count,
    };
  }
  return {
    state: 'active',
    label: count > 1 ? t('sidebar.watcherAutopilotCount', { count }) : t('sidebar.watcherAutopilot'),
    title: t('sidebar.watcherAutopilotTitle', { mode: 'autopilot', status: cycleStatus }),
    count,
  };
}

/**
 * @param {object | null | undefined} workspace
 * @param {string} preferredFolder
 * @param {(value: string) => string} escapeHtml
 * @returns {string}
 */
export function renderWorkspaceAutopilotBadgeHtml(workspace, preferredFolder, escapeHtml) {
  const formatted = formatWorkspaceAutopilotBadge(resolveWorkspaceWatcherBadge(workspace, preferredFolder));
  if (!formatted) return '';
  return '<span class="sidebar-workspace-autopilot" data-state="' + escapeHtml(formatted.state) + '" data-cycle-count="' + escapeHtml(String(formatted.count)) + '" title="' + escapeHtml(formatted.title) + '">'
    + '<span class="mdi mdi-robot-outline" aria-hidden="true"></span>'
    + '<span class="sidebar-workspace-autopilot-label">' + escapeHtml(formatted.label) + '</span>'
    + '</span>';
}

/**
 * Tests only.
 * @returns {void}
 */
export function __resetWorkspaceWatcherBadgeForTest() {
  watchersByFolder.clear();
  revision = 0;
}
