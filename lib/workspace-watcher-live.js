/**
 * Live fan-out for Workspace Watcher state.
 *
 * The watcher reuses two channels the browser already maintains, so autopilot
 * status never needs its own socket:
 *   - `chat-list-updates` (`chatsChanged`) tells every list/panel to refetch.
 *   - `agent-presence-bus` (`agentPresence`) carries a compact per-workspace
 *     watcher summary for the sidebar badge.
 *
 * Every export is fire-and-forget: a watcher write or tick must never fail
 * because no browser is connected or a push threw.
 */

import { broadcastChatListChanged } from './chat-list-updates.js';
import { markAgentPresenceDirty } from './agent-presence-hooks.js';
import {
  getWorkspaceWatcherActiveCycles,
  loadWorkspaceWatchers,
  WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES,
} from './persist/workspace-watchers-persist.js';

/**
 * Compact, client-safe watcher summary. Disabled (`off`) rows are dropped unless
 * they still carry a pinned chat: the sidebar "Workspace" section lists those so
 * its per-workspace toggle can turn the watcher back on. An off workspace without
 * a pinned chat never grows a row (and therefore never a badge).
 *
 * @param {object[]} watchers
 * @returns {object[]}
 */
export function workspaceWatcherPresenceRows(watchers = []) {
  return (Array.isArray(watchers) ? watchers : [])
    .filter((row) => row && (
      String(row.mode || '') !== 'off' || String(row.pinnedChatId || '').trim()
    ))
    .map((row) => {
      const cycles = getWorkspaceWatcherActiveCycles(row);
      const primary = cycles[0] || null;
      return {
        workspaceFolder: String(row.workspaceFolder || ''),
        mode: String(row.mode || 'off'),
        paused: row.paused === true,
        stopReason: String(row.stopReason || ''),
        pinnedChatId: String(row.pinnedChatId || ''),
        activeCycleCount: cycles.length,
        activeCycleChatId: String(primary?.chatId || ''),
        activeCycleTodoIds: Array.isArray(primary?.todoIds)
          ? primary.todoIds.map((id) => String(id || '')).filter(Boolean).slice(0, 10)
          : [],
        activeCycleChatIds: cycles
          .map((cycle) => String(cycle.chatId || '').trim())
          .filter(Boolean)
          .slice(0, WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES),
        updatedAt: String(row.updatedAt || ''),
      };
    })
    .sort((a, b) => a.workspaceFolder.localeCompare(b.workspaceFolder));
}

/**
 * Stable fingerprint for the watcher slice so the presence bus sends only on a
 * real change (mode, pause, stop, active cycle).
 *
 * @param {object[]} rows
 * @returns {string}
 */
export function workspaceWatcherPresenceKey(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => [
      row.workspaceFolder,
      row.mode,
      row.paused ? '1' : '0',
      row.stopReason,
      row.pinnedChatId,
      row.activeCycleChatId,
      (row.activeCycleTodoIds || []).join(','),
      String(row.activeCycleCount ?? 0),
      (row.activeCycleChatIds || []).join(','),
    ].join('\u0000'))
    .join('\u0001');
}

/**
 * Read the current watcher presence rows. Kept here (not in the bus) so tests
 * can drive the bus without touching the real data dir.
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function loadWorkspaceWatcherPresence(options = {}) {
  try {
    return workspaceWatcherPresenceRows(loadWorkspaceWatchers(options));
  } catch {
    return [];
  }
}

/**
 * Announce a watcher state change on the existing chat-list channel and nudge
 * the coalesced presence fan-out so the sidebar badge repaints.
 *
 * @param {{ reason?: string, chatId?: string | null }} [payload]
 * @returns {void}
 */
export function broadcastWorkspaceWatcherChanged(payload = {}) {
  try {
    broadcastChatListChanged({ reason: 'workspace-watcher', chatId: payload.chatId || null });
  } catch {
    // Never let a broadcast break a watcher write.
  }
  try {
    // No chat ids: refreshes every presence scope without triggering the
    // autopilot nudge (which only reacts to concrete chat ids).
    markAgentPresenceDirty();
  } catch {
    // The presence bus may not be initialized (tests, CLI); that is fine.
  }
}
