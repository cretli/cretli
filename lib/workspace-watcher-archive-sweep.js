/**
 * Workspace Watcher — periodic archive sweep of closed cycle families.
 *
 * Lives in its own leaf module (not `workspace-watcher.js` and not
 * `workspace-watcher-cycle.js`) because BOTH must call it: the boot reconcile
 * and the live autopilot pass. `workspace-watcher-cycle.js` imports
 * `workspace-watcher.js`, so putting it in either would create an import cycle.
 *
 * Why a live sweep is required: `archiveChatFamilyAsync` enforces the mandated
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
import { peekChatsAsync, peekChatsByIdsAsync } from './persist/chats-persist.js';
import {
  loadWorkspaceWatchers,
  normalizeWorkspaceFolder,
  workspaceWatcherClosedCycleChatIds,
  workspaceWatcherCycleChatIds,
} from './persist/workspace-watchers-persist.js';
import { archiveChatFamilyAsync, buildChatFamilyIndex, isChatAlreadyArchived } from './chat-archive-policy.js';
import { createChatArchiveIdleProbe } from './chat-archive-idle.js';
import { archiveChatsAsync } from './persist/chats-persist.js';
import { collectArchivedAncestorIds } from './chat-tree.js';

const YIELD_EVERY_FAMILIES = 16;
const YIELD_SLICE_MS = 20;

/**
 * Archive the orchestrator families of already-closed cycles through the shared
 * `archiveChatFamilyAsync` gate. Shared by the boot reconcile and the live autopilot
 * pass so the two can never drift.
 *
 * A row's `cycleChats` entry that still has a live slot on ANY row is never a
 * target. The gate itself re-checks pinned / already-archived / grace / unknown
 * idle / terminal-and-slot-free delegation children / fork descendants.
 *
 * @param {{
 *   dataDir?: string,
 *   now?: number,
 *   deps?: Record<string, any>,
 *   rows?: Record<string, any>[],
 *   workspaceFolders?: string[],
 *   yieldEvery?: number,
 * }} [options]
 * @returns {Promise<{ considered: number, archived: string[] }>}
 */
export async function sweepClosedWorkspaceWatcherCycles(options = {}) {
  const dataDir = String(options.dataDir ?? '').trim() || resolveDataPath();
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};
  const only = Array.isArray(options.workspaceFolders)
    ? new Set(options.workspaceFolders.map((folder) => normalizeWorkspaceFolder(folder)))
    : null;
  /** @type {Record<string, any>[]} */
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

  // Read-only lookups: the sweep never mutates rows, so it reads only the cycle chats it may clean
  // through the shared no-copy view instead of copying the whole chat list on every tick. Fully
  // archived trees skip the gate, but an archived parent with later live descendants must be revisited;
  // that needs a descendant scan, done lazily (and still copy-free) only when a candidate is archived.
  /** @type {Map<string, Record<string, any>>} */
  const chatsById = new Map();
  /** @type {Set<string> | null} */
  let archivedAncestorIds = null;
  const injected = typeof deps.loadChats === 'function';
  /** @type {readonly Record<string, any>[] | null} */
  let injectedChats = null;
  try {
    if (injected) {
      const loaded = await deps.loadChats();
      injectedChats = Array.isArray(loaded) ? loaded : [];
      for (const chat of injectedChats) {
        const chatId = String(chat?.id || '').trim();
        if (chatId) chatsById.set(chatId, chat);
      }
    } else {
      for (const chat of await peekChatsByIdsAsync(candidates)) {
        const chatId = String(chat?.id || '').trim();
        if (chatId) chatsById.set(chatId, chat);
      }
    }
  } catch {
    chatsById.clear();
  }
  const ancestorIds = async () => {
    if (archivedAncestorIds) return archivedAncestorIds;
    try {
      const rows = injectedChats ?? await peekChatsAsync();
      archivedAncestorIds = collectArchivedAncestorIds(/** @type {Record<string, any>[]} */ (rows));
    } catch {
      archivedAncestorIds = new Set();
    }
    return archivedAncestorIds;
  };
  const chatOf = (id) => chatsById.get(id);
  // The archive gate only reads the list (writes go through `updateChat` by id), so by default it gets the
  // no-copy view too; an injected `deps.loadChats` still wins.
  // The whole sweep shares ONE chat list snapshot, one parent->children index and one `done` set (the snapshot is
  // not refreshed after a write, `done` keeps already-archived members from being written again by a later family).
  /** @type {readonly Record<string, any>[] | null} */
  let sharedChats = injectedChats;
  if (!sharedChats) {
    try { sharedChats = await peekChatsAsync(); } catch { sharedChats = null; }
  }
  const index = sharedChats ? buildChatFamilyIndex(/** @type {Record<string, any>[]} */ (sharedChats)) : undefined;
  const done = new Set();
  // One idle probe per sweep: it reads the recovery run registry once instead of once per family.
  const idleProbe = typeof deps.isChatRunConfirmedIdle === 'function' ? deps.isChatRunConfirmedIdle : createChatArchiveIdleProbe();
  const gateDeps = {
    ...deps,
    isChatRunConfirmedIdle: idleProbe,
    ...(injected || !sharedChats ? {} : { loadChats: () => sharedChats }),
  };
  const yieldEvery = Number.isFinite(options.yieldEvery) && options.yieldEvery > 0 ? Number(options.yieldEvery) : YIELD_EVERY_FAMILIES;
  let lastYield = Date.now();

  /** @type {string[]} */
  const archived = [];
  // With the real store, cover-root archives of many families are flushed in ONE write per slice
  // (the store cascades each root over its fork subtree). An injected updateChat keeps per-member writes.
  const batchWrites = typeof deps.updateChat !== 'function' || typeof deps.archiveChats === 'function';
  const archiveBatch = typeof deps.archiveChats === 'function' ? deps.archiveChats : archiveChatsAsync;
  /** @type {{ roots: string[], archived: string[] }[]} */
  let pending = [];
  const flush = async () => {
    const batch = pending;
    pending = [];
    const roots = batch.flatMap((entry) => entry.roots);
    if (!roots.length) return;
    let applied = new Set();
    try {
      const result = await archiveBatch(roots);
      applied = new Set(Array.isArray(result?.archived) ? result.archived : []);
    } catch { /* best-effort: nothing is reported as archived */ }
    for (const entry of batch) {
      if (entry.roots.every((root) => applied.has(root))) archived.push(...entry.archived);
    }
  };
  let processed = 0;
  for (const id of candidates) {
    // Never hold the event loop for long: yield every N families or once the time slice is used up.
    processed += 1;
    if (processed % yieldEvery === 0 || Date.now() - lastYield >= YIELD_SLICE_MS) {
      if (batchWrites) await flush();
      await new Promise((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
    const chat = chatOf(id);
    if (!chat) continue;
    if (isChatAlreadyArchived(chat) && !(await ancestorIds()).has(id)) continue;
    try {
      const summary = await archiveChatFamilyAsync(id, { now, deps: /** @type {any} */ (gateDeps), index, done, deferWrites: batchWrites ? pending : undefined });
      // In batch mode the ids are credited by `flush` once the store confirms the write.
      if (!batchWrites && Array.isArray(summary?.archived) && summary.archived.length) {
        archived.push(...summary.archived);
      }
    } catch { /* best-effort per family: one bad read never breaks the sweep */ }
  }
  if (batchWrites) await flush();
  return { considered: candidates.length, archived };
}
