/**
 * Workspace Watcher — periodic archive sweep of closed cycle families.
 *
 * Lives in its own leaf module (not `workspace-watcher.js` and not
 * `workspace-watcher-cycle.js`) because BOTH must call it: the boot reconcile
 * and the live autopilot pass. `workspace-watcher-cycle.js` imports
 * `workspace-watcher.js`, so putting it in either would create an import cycle.
 *
 * Why a live sweep is required: `archiveChatFamily` enforces the mandated
 * 15-minute idle grace, but at report/reconcile time the orchestrator chat's
 * `updatedAt` is ~now, so the family is always refused there. The only other
 * retry was the boot `cycleChats` loop, which runs once per process start — so
 * a successful cycle used to keep its orchestrator and terminal delegated child
 * visible in the sidebar until a restart. The autopilot pass now revisits
 * closed cycles on every worker tick and archives them once they have been idle
 * past the grace.
 *
 * The sweep is fully best-effort: it never throws into a tick or the boot path,
 * never starts a cycle, and never touches `activeCycles`, the lease or the
 * `maxCyclesPerDay` budget.
 */

import { resolveDataPath } from './runtime-paths.js';
import { loadChats } from './persist/chats-persist.js';
import {
  loadWorkspaceWatchers,
  normalizeWorkspaceFolder,
  workspaceWatcherClosedCycleChatIds,
  workspaceWatcherCycleChatIds,
} from './persist/workspace-watchers-persist.js';
import { archiveChatFamily, isChatAlreadyArchived } from './chat-archive-policy.js';
import { collectArchivedAncestorIds } from './chat-tree.js';

/**
 * Archive the orchestrator families of already-closed cycles through the shared
 * `archiveChatFamily` gate. Shared by the boot reconcile and the live autopilot
 * pass so the two can never drift.
 *
 * A row's `cycleChats` entry that still has a live slot on ANY row is never a
 * target. The gate itself re-checks pinned / already-archived / grace / unknown
 * idle / terminal-and-slot-free delegation children / fork descendants.
 *
 * @param {{
 *   dataDir?: string,
 *   now?: number,
 *   deps?: object,
 *   rows?: object[],
 *   workspaceFolders?: string[],
 * }} [options]
 * @returns {{ considered: number, archived: string[] }}
 */
export function sweepClosedWorkspaceWatcherCycles(options = {}) {
  const dataDir = String(options.dataDir ?? '').trim() || resolveDataPath();
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};
  const only = Array.isArray(options.workspaceFolders)
    ? new Set(options.workspaceFolders.map((folder) => normalizeWorkspaceFolder(folder)))
    : null;
  /** @type {object[]} */
  let rows;
  if (Array.isArray(options.rows)) {
    rows = options.rows;
  } else {
    try {
      rows = loadWorkspaceWatchers({ dataDir });
    } catch {
      return { considered: 0, archived: [] };
    }
  }

  // A chat orchestrating a live cycle on any row stays untouched, even when
  // another row's bounded `cycleChats` window still lists it as closed.
  const live = new Set();
  for (const row of rows) {
    for (const id of workspaceWatcherCycleChatIds(row)) live.add(id);
  }
  /** @type {string[]} */
  const candidates = [];
  for (const row of rows) {
    if (only && !only.has(normalizeWorkspaceFolder(row.workspaceFolder))) continue;
    for (const id of workspaceWatcherClosedCycleChatIds(row)) {
      if (!live.has(id) && !candidates.includes(id)) candidates.push(id);
    }
  }
  if (!candidates.length) return { considered: 0, archived: [] };

  // One snapshot per sweep. Fully archived trees skip the gate, but an archived
  // parent with later live descendants must be revisited.
  /** @type {Map<string, object> | null} */
  let chatsById = null;
  let archivedAncestorIds = new Set();
  const chatOf = (id) => {
    if (chatsById === null) {
      let chats = [];
      try {
        chats = typeof deps.loadChats === 'function' ? deps.loadChats() : loadChats();
      } catch {
        chats = [];
      }
      chatsById = new Map();
      for (const chat of Array.isArray(chats) ? chats : []) {
        const chatId = String(chat?.id || '').trim();
        if (chatId) chatsById.set(chatId, chat);
      }
      archivedAncestorIds = collectArchivedAncestorIds(Array.isArray(chats) ? chats : []);
    }
    return chatsById.get(id);
  };

  /** @type {string[]} */
  const archived = [];
  for (const id of candidates) {
    const chat = chatOf(id);
    if (!chat || (isChatAlreadyArchived(chat) && !archivedAncestorIds.has(id))) continue;
    try {
      const summary = archiveChatFamily(id, { now, deps });
      if (Array.isArray(summary?.archived) && summary.archived.length) {
        archived.push(...summary.archived);
      }
    } catch { /* best-effort per family: one bad read never breaks the sweep */ }
  }
  return { considered: candidates.length, archived };
}
