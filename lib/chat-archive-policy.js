/**
 * Shared chat-archive policy — the single "canArchive" criterion and the
 * family (portfolio) collector used by BOTH the idle-Scout sweep
 * (`archiveIdleScoutChats`) and the Workspace Watcher orchestrator archive
 * (report / reconcile / boot in `workspace-watcher-cycle.js` and
 * `workspace-watcher.js`).
 *
 * Why this exists: `updateChat(id, { archived: true })` cascades the whole
 * fork subtree in the store and its rejector (`chat-archive-guard.js`) only
 * blocks a *live run* — it never checks `watcherPinned`, the delegation slot,
 * or the idle grace. So the orchestrator used to hide a still-busy child (a
 * delegated child that still holds a run slot, or a pinned chat) simply by
 * archiving its parent. This module is the gate that must run BEFORE
 * `updateChat`, and it deliberately takes precedence over the store
 * rejector rather than a replacement for it.
 *
 * The module imports only low-level stores/services
 * (`persist/chats-persist.js`, `persist/delegations-persist.js`,
 * `chat-run-service.js`, `delegation-status.js`,
 * `workspace-watcher-cycle-close.js`) and never imports the Scout, cycle or
 * watcher modules, so no ESM import cycle is introduced. Everything is
 * dependency-injected so unit tests run without a chat store, a delegation
 * store or a model.
 */

import { loadChatsAsync, updateChatAsync } from './persist/chats-persist.js';
import { listDelegationsForController } from './persist/delegations-persist.js';
import { createChatArchiveIdleProbe } from './chat-archive-idle.js';
import { isDelegationSlotOccupied, isTerminalDelegationStatus } from './delegation-status.js';
import { hasActiveWorkspaceWatcherCycleChildren } from './workspace-watcher-cycle-close.js';

/**
 * Idle grace before a finished chat may be archived (15 min). This is the
 * canonical definition; `workspace-watcher-scout.js` re-exports it as
 * `WORKSPACE_SCOUT_ARCHIVE_GRACE_MS` so neither side has to duplicate the
 * number.
 */
export const CHAT_ARCHIVE_GRACE_MS = 15 * 60_000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * True when a chat is already in the archive (either flag set).
 *
 * @param {Record<string, any> | null | undefined} chat
 * @returns {boolean}
 */
export function isChatAlreadyArchived(chat) {
  return chat?.archived === true || Boolean(asString(chat?.archivedAt));
}

/**
 * Builds the per-run `canArchive` predicate (requirement A). Fail-closed:
 * unproven liveness, unparseable `updatedAt` or a throwing probe keeps the chat
 * visible. Cold rooms require a readable recovery registry without unfinished
 * runs. `includeArchived` lets automatic
 * family repair validate an archived ancestor that received later children.
 * `activityMs` replaces `updatedAt` as the start of the grace window; the
 * `updatedAt` check above it stays, so a corrupt row is still kept visible.
 *
 * @param {{
 *   now?: number,
 *   isChatRunConfirmedIdle?: (input: { chatId: string }) => boolean,
 *   graceMs?: number,
 *   includeArchived?: boolean,
 *   activityMs?: (chat: Record<string, any>) => number,
 * }} [options]
 * @returns {(chat: Record<string, any> | null | undefined) => boolean}
 */
export function createChatArchivable(options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const graceMs = Number.isFinite(options.graceMs) ? Number(options.graceMs) : CHAT_ARCHIVE_GRACE_MS;
  const idleFn = typeof options.isChatRunConfirmedIdle === 'function'
    ? options.isChatRunConfirmedIdle
    : createChatArchiveIdleProbe();
  return function chatArchivable(chat) {
    if (!chat || typeof chat !== 'object') return false;
    if (chat.watcherPinned === true || chat.operatorChat === true) return false;
    if (isChatAlreadyArchived(chat) && options.includeArchived !== true) return false;
    const updatedMs = Date.parse(asString(chat.updatedAt));
    if (!Number.isFinite(updatedMs)) return false;
    const activityMs = typeof options.activityMs === 'function' ? options.activityMs(chat) : updatedMs;
    if (now - activityMs < graceMs) return false;
    try {
      // Pass the row itself: without it the probe re-reads every chat per call,
      // which makes a sweep over N chats cost N full chat-list loads.
      return idleFn({ chatId: asString(chat.id), chat }) === true;
    } catch {
      return false;
    }
  };
}

/**
 * Builds the family collector for one chat snapshot (requirements B and C).
 * `collect(rootChat)` returns the members parent-first, or `null` when ANY
 * member fails the gate — so the caller refuses the whole portfolio rather
 * than archiving a parent that would drag a busy/pinned/slot-holding child
 * into the archive through the store's fork cascade.
 *
 * A delegation child must be terminal AND slot-free. Deleted children are
 * ignored; archived children must still be traversed because new descendants
 * may have been created after their archive. A corrupt
 * fork/delegation cycle is broken by the `visiting` set instead of recursing
 * forever. A failed delegation read is fail-closed (`null`).
 *
 * `index` (from {@link buildChatFamilyIndex}) is reused only when it was built from the very same `chats`
 * array; any other value is ignored and rebuilt, so a stale index can never leak into a different list.
 *
 * @param {{
 *   chats?: Record<string, any>[],
 *   index?: ReturnType<typeof buildChatFamilyIndex>,
 *   chatArchivable?: (chat: Record<string, any>) => boolean,
 *   listDelegationsForController?: (parentChatId: string) => Record<string, any>[],
 *   isTerminalDelegationStatus?: (status: unknown) => boolean,
 *   isDelegationSlotOccupied?: (row: Record<string, any>, nowMs: number) => boolean,
 *   now?: number,
 * }} input
 * @returns {{ collect: (rootChat: Record<string, any>) => Record<string, any>[] | null, byId: Map<string, Record<string, any>> }}
 */
export function createFamilyCollector(input = {}) {
  const chats = Array.isArray(input.chats) ? input.chats : [];
  const index = input.index && input.index.chats === chats ? input.index : buildChatFamilyIndex(chats);
  const chatArchivable = typeof input.chatArchivable === 'function' ? input.chatArchivable : () => false;
  const listChildrenFn = typeof input.listDelegationsForController === 'function'
    ? input.listDelegationsForController
    : listDelegationsForController;
  const terminalFn = typeof input.isTerminalDelegationStatus === 'function'
    ? input.isTerminalDelegationStatus
    : isTerminalDelegationStatus;
  const slotOccupiedFn = typeof input.isDelegationSlotOccupied === 'function'
    ? input.isDelegationSlotOccupied
    : isDelegationSlotOccupied;
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();

  const { byId, forksByParent } = index;
  const directForks = (parentId) => forksByParent.get(parentId) || [];

  const delegationsOf = (parentId) => {
    try {
      const rows = listChildrenFn(parentId);
      if (!Array.isArray(rows)) return null;
      return rows;
    } catch {
      return null;
    }
  };

  const collect = (chat, visiting, collected, members, childrenById) => {
    const id = asString(chat?.id);
    if (!id || visiting.has(id)) return false;
    if (collected.has(id)) return true;
    if (!chatArchivable(chat)) return null;
    visiting.add(id);
    members.push(chat);
    const children = new Set();
    childrenById.set(id, children);
    for (const fork of directForks(id)) {
      const childId = asString(fork?.id);
      if (childId) children.add(childId);
      if (!collect(fork, visiting, collected, members, childrenById)) {
        visiting.delete(id);
        return false;
      }
    }
    const delegationRows = delegationsOf(id);
    if (delegationRows === null) {
      visiting.delete(id);
      return false;
    }
    for (const row of delegationRows) {
      if (!terminalFn(row?.status) || slotOccupiedFn(row, now)) {
        visiting.delete(id);
        return false;
      }
      const childId = asString(row?.childChatId);
      if (!childId) continue;
      const child = byId.get(childId);
      // Archived children can still connect the family to later live descendants.
      if (!child) continue;
      children.add(childId);
      if (!collect(child, visiting, collected, members, childrenById)) {
        visiting.delete(id);
        return false;
      }
    }
    visiting.delete(id);
    collected.add(id);
    return true;
  };

  return {
    collect: (rootChat) => {
      const members = [];
      const childrenById = new Map();
      const ok = collect(rootChat, new Set(), new Set(), members, childrenById);
      if (!ok) return null;

      // A stable parent-first topological order keeps every shared descendant
      // after all of its parents, so reversing the list still archives children first.
      const indegree = new Map(members.map((member) => [asString(member.id), 0]));
      for (const children of childrenById.values()) {
        for (const childId of children) {
          if (indegree.has(childId)) indegree.set(childId, indegree.get(childId) + 1);
        }
      }
      const ready = members
        .map((member) => asString(member.id))
        .filter((id) => indegree.get(id) === 0);
      const orderedIds = [];
      for (let index = 0; index < ready.length; index += 1) {
        const id = ready[index];
        orderedIds.push(id);
        for (const childId of childrenById.get(id) || []) {
          if (!indegree.has(childId)) continue;
          const next = indegree.get(childId) - 1;
          indegree.set(childId, next);
          if (next === 0) ready.push(childId);
        }
      }
      if (orderedIds.length !== members.length) return null;
      const memberById = new Map(members.map((member) => [asString(member.id), member]));
      return orderedIds.map((id) => memberById.get(id));
    },
    byId,
  };
}

/**
 * The parent->children (fork) index and id lookup for one chat list. Building it is O(n), so a sweep over many
 * families builds it once and shares it through `createFamilyCollector({ index })` / `archiveChatFamily({ index })`.
 *
 * @param {Record<string, any>[]} chats
 * @returns {{ chats: Record<string, any>[], byId: Map<string, Record<string, any>>, forksByParent: Map<string, Record<string, any>[]> }}
 */
export function buildChatFamilyIndex(chats) {
  const list = Array.isArray(chats) ? chats : [];
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  /** @type {Map<string, Record<string, any>[]>} */
  const forksByParent = new Map();
  for (const chat of list) {
    const id = asString(chat?.id);
    if (id) byId.set(id, chat);
    const parentId = asString(chat?.forkParentChatId);
    if (!parentId) continue;
    const forks = forksByParent.get(parentId);
    if (forks) forks.push(chat);
    else forksByParent.set(parentId, [chat]);
  }
  return { chats: list, byId, forksByParent };
}

/**
 * Archive a collected family children-before-parent (requirement C). Best
 * effort: a store write failure leaves that chat in place and never rethrows.
 * `done` dedupes across multiple calls over one chat snapshot. Existing archive
 * timestamps are preserved by writing only members that are not yet archived.
 *
 * A failed child write ABORTS the rest of the family instead of continuing to
 * its ancestors. Delegation children are real fork children (`forkParentChatId`
 * + `forkKind: 'delegation'`), and the store's `archived` write cascades over
 * that whole subtree; archiving the parent after a child write failed would let
 * the cascade hide the very child the direct write could not reach.
 *
 * @param {Record<string, any>[]} members parent-first family from `createFamilyCollector`
 * @param {{
 *   updateChat?: (id: string, updates: Record<string, any>) => unknown,
 *   beforeArchive?: (member: Record<string, any>) => boolean | Promise<boolean>,
 *   done?: Set<string>,
 *   cascade?: boolean,
 *   deferWrites?: { roots: string[], archived: string[] }[],
 * }} [options] `deferWrites` (cascade mode) collects the writes instead of performing them; `cascade` writes only the members that no other archivable member covers by fork ancestry
 * @returns {Promise<{ archived: string[], skipped: number }>}
 */
export async function archiveFamilyMembers(members, options = {}) {
  const updateChatFn = typeof options.updateChat === 'function' ? options.updateChat : updateChatAsync;
  const beforeArchive = typeof options.beforeArchive === 'function' ? options.beforeArchive : null;
  const done = options.done instanceof Set ? options.done : new Set();
  // The store archives a chat together with its whole fork subtree, so a family needs one write per cover root.
  const cascade = options.cascade === true;
  const summary = { archived: [], skipped: 0 };

  if (!cascade) {
    // Per-member mode: each gate runs after the previous member's write, so it observes that write.
    for (let i = members.length - 1; i >= 0; i -= 1) {
      const memberId = asString(members[i]?.id);
      if (!memberId || done.has(memberId) || isChatAlreadyArchived(members[i])) continue;
      try {
        if (beforeArchive && await beforeArchive(members[i]) !== true) {
          summary.skipped += 1;
          break;
        }
        await updateChatFn(memberId, { archived: true });
        done.add(memberId);
        summary.archived.push(memberId);
      } catch {
        summary.skipped += 1;
        break;
      }
    }
    return summary;
  }

  // Cascade mode: gate pass, children first: `ready` is the prefix of pending members that may be archived.
  /** @type {Record<string, any>[]} */
  const ready = [];
  for (let i = members.length - 1; i >= 0; i -= 1) {
    const memberId = asString(members[i]?.id);
    if (!memberId || done.has(memberId) || isChatAlreadyArchived(members[i])) continue;
    try {
      if (beforeArchive && await beforeArchive(members[i]) !== true) {
        summary.skipped += 1;
        break;
      }
    } catch {
      summary.skipped += 1;
      break;
    }
    ready.push(members[i]);
  }

  // The topmost ready fork ancestor of each member is the write that covers it (itself when none).
  const readyIds = new Set(ready.map((member) => asString(member.id)));
  const memberById = new Map(members.map((member) => [asString(member?.id), member]));
  const coverOf = (member) => {
    const seen = new Set();
    let cover = asString(member.id);
    let parentId = asString(member.forkParentChatId);
    while (parentId && !seen.has(parentId)) {
      if (readyIds.has(parentId)) cover = parentId;
      seen.add(parentId);
      parentId = asString(memberById.get(parentId)?.forkParentChatId);
    }
    return cover;
  };
  const covers = new Map(ready.map((member) => [asString(member.id), coverOf(member)]));
  const written = new Set();
  const deferred = Array.isArray(options.deferWrites) ? options.deferWrites : null;
  if (deferred) {
    // The caller flushes the cover roots of many families in one store write and owns failure accounting.
    const roots = ready.map((member) => asString(member.id)).filter((memberId) => covers.get(memberId) === memberId);
    for (const memberId of roots) written.add(memberId);
    deferred.push({ roots, archived: ready.map((member) => asString(member.id)) });
  }
  for (const member of deferred ? [] : ready) {
    const memberId = asString(member.id);
    if (covers.get(memberId) !== memberId) continue;
    try {
      await updateChatFn(memberId, { archived: true });
      written.add(memberId);
    } catch {
      // A failed write aborts the rest: a later ancestor write would cascade over the child that could not be reached.
      summary.skipped += 1;
      break;
    }
  }
  for (const member of ready) {
    const memberId = asString(member.id);
    if (!written.has(covers.get(memberId))) continue;
    done.add(memberId);
    summary.archived.push(memberId);
  }
  return summary;
}

export const archiveFamilyMembersAsync = archiveFamilyMembers;

/**
 * The orchestrator archive gate: given one root chat id (the orchestrator
 * whose cycle just closed), archive its whole archivable family — terminal
 * delegated children first, the orchestrator last — and refuse everything when
 * any member fails. Re-checks the delegation store at archive time so a child
 * that grabbed a slot after the cycle closed cannot be hidden (requirement D).
 *
 * Fully best-effort and never throws: any read failure is a skip, so archiving
 * can never take down a report, a reconcile or the boot sweep.
 *
 * @param {string} rootChatId
 * @param {{
 *   now?: number,
 *   deps?: {
 *     loadChats?: () => Record<string, any>[],
 *     updateChat?: (id: string, updates: Record<string, any>) => unknown,
 *     listDelegationsForController?: (parentChatId: string) => Record<string, any>[],
 *     isChatRunConfirmedIdle?: (input: { chatId: string }) => boolean,
 *     isDelegationSlotOccupied?: (row: Record<string, any>, nowMs: number) => boolean,
 *     isTerminalDelegationStatus?: (status: unknown) => boolean,
 *     hasActiveWorkspaceWatcherCycleChildren?: (chatId: string, delegations: Record<string, any>[]) => boolean,
 *   },
 *   index?: ReturnType<typeof buildChatFamilyIndex>,
 *   done?: Set<string>,
 *   deferWrites?: { roots: string[], archived: string[] }[],
 * }} [options] `index`/`done` are shared by a sweep over one chat list snapshot
 * @returns {Promise<{ archived: string[], skipped: number, reason: string }>}
 */
export async function archiveChatFamily(rootChatId, options = {}) {
  const prep = prepareArchiveFamily(rootChatId, options, { loadChats: loadChatsAsync, updateChat: updateChatAsync });
  if (prep.summary) return prep.summary;
  let chats;
  try {
    chats = await prep.loadChatsFn();
  } catch {
    return { archived: [], skipped: 1, reason: 'load_failed' };
  }
  const collected = collectArchiveFamily(rootChatId, chats, prep, options.index);
  if (collected.summary) return collected.summary;
  const deps = /** @type {Record<string, any>} */ (options.deps && typeof options.deps === 'object' ? options.deps : {});
  const result = await archiveFamilyMembers(collected.family, {
    updateChat: prep.updateChatFn,
    done: options.done instanceof Set ? options.done : new Set(),
    // An injected updateChat keeps the per-member contract; the real store cascades, so it gets one write per family.
    cascade: typeof deps.updateChat !== 'function' || deps.cascadeArchive === true,
    deferWrites: typeof deps.updateChat !== 'function' || deps.cascadeArchive === true ? options.deferWrites : undefined,
  });
  return finishArchiveSummary(result);
}

export const archiveChatFamilyAsync = archiveChatFamily;

/**
 * @param {{ archived: string[], skipped: number }} result
 * @returns {{ archived: string[], skipped: number, reason: string }}
 */
function finishArchiveSummary(result) {
  return {
    archived: result.archived,
    skipped: result.skipped,
    reason: result.archived.length ? 'archived' : 'nothing_to_archive',
  };
}

/**
 * Resolves the injected collaborators and runs the cycle-children gate (requirement D). Returns `summary` when the
 * archive is already decided (no chat / active cycle children), otherwise the resolved collaborators.
 *
 * @param {string} rootChatId
 * @param {Parameters<typeof archiveChatFamily>[1]} options
 * @param {{ loadChats: Function, updateChat: Function }} [defaults]
 * @returns {any}
 */
function prepareArchiveFamily(rootChatId, options, defaults = { loadChats: loadChatsAsync, updateChat: updateChatAsync }) {
  const id = asString(rootChatId);
  if (!id) return { summary: { archived: [], skipped: 1, reason: 'no_chat' } };
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};

  const loadChatsFn = typeof deps.loadChats === 'function' ? deps.loadChats : defaults.loadChats;
  const updateChatFn = typeof deps.updateChat === 'function' ? deps.updateChat : defaults.updateChat;
  const listChildrenFn = typeof deps.listDelegationsForController === 'function'
    ? deps.listDelegationsForController
    : listDelegationsForController;
  const idleFn = typeof deps.isChatRunConfirmedIdle === 'function'
    ? deps.isChatRunConfirmedIdle
    : createChatArchiveIdleProbe();
  const slotOccupiedFn = typeof deps.isDelegationSlotOccupied === 'function'
    ? deps.isDelegationSlotOccupied
    : isDelegationSlotOccupied;
  const terminalFn = typeof deps.isTerminalDelegationStatus === 'function'
    ? deps.isTerminalDelegationStatus
    : isTerminalDelegationStatus;
  const activeChildrenFn = typeof deps.hasActiveWorkspaceWatcherCycleChildren === 'function'
    ? deps.hasActiveWorkspaceWatcherCycleChildren
    : hasActiveWorkspaceWatcherCycleChildren;

  try {
    // Requirement D: leave the whole portfolio alone while the orchestrator
    // still has a delegated child holding a run slot, even if the cycle closed.
    const ownRows = listChildrenFn(id);
    if (activeChildrenFn(id, Array.isArray(ownRows) ? ownRows : [])) {
      return { summary: { archived: [], skipped: 1, reason: 'cycle_children_active' } };
    }
  } catch {
    return { summary: { archived: [], skipped: 1, reason: 'cycle_children_active' } };
  }
  return { id, now, loadChatsFn, updateChatFn, listChildrenFn, idleFn, slotOccupiedFn, terminalFn };
}

/**
 * Collects the archivable family of the root chat from a loaded chat list.
 *
 * @param {string} rootChatId
 * @param {unknown} chats
 * @param {any} prep result of {@link prepareArchiveFamily}
 * @param {ReturnType<typeof buildChatFamilyIndex>} [index]
 * @returns {{ summary?: { archived: string[], skipped: number, reason: string }, family?: Record<string, any>[] }}
 */
function collectArchiveFamily(rootChatId, chats, prep, index) {
  if (!Array.isArray(chats)) return { summary: { archived: [], skipped: 1, reason: 'load_failed' } };
  const chatArchivable = createChatArchivable({ now: prep.now, isChatRunConfirmedIdle: prep.idleFn, includeArchived: true });
  const { collect, byId } = createFamilyCollector({
    chats,
    index,
    chatArchivable,
    listDelegationsForController: prep.listChildrenFn,
    isTerminalDelegationStatus: prep.terminalFn,
    isDelegationSlotOccupied: prep.slotOccupiedFn,
    now: prep.now,
  });
  const root = byId.get(prep.id);
  if (!root) return { summary: { archived: [], skipped: 1, reason: 'chat_missing' } };
  const family = collect(root);
  if (!family) return { summary: { archived: [], skipped: 1, reason: 'family_blocked' } };
  return { family };
}
