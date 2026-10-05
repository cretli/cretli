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
 * `updateChat`, and it is deliberately NADRZĘDNY (overriding) the store
 * rejector rather than a replacement for it.
 *
 * The module is a LEAF: it imports only low-level stores/services
 * (`persist/chats-persist.js`, `persist/delegations-persist.js`,
 * `chat-run-service.js`, `delegation-status.js`,
 * `workspace-watcher-cycle-close.js`) and never imports the Scout, cycle or
 * watcher modules, so no ESM import cycle is introduced. Everything is
 * dependency-injected so unit tests run without a chat store, a delegation
 * store or a model.
 */

import { loadChats, updateChat } from './persist/chats-persist.js';
import { listDelegationsForParent } from './persist/delegations-persist.js';
import { isChatRunConfirmedIdle } from './chat-run-service.js';
import { isDelegationSlotOccupied, isTerminalDelegationStatus } from './delegation-status.js';
import { hasActiveWorkspaceWatcherCycleChildren } from './workspace-watcher-cycle-close.js';

/**
 * Idle grace before a finished chat may be archived (15 min). This is the
 * canonical definition; `workspace-watcher-scout.js` re-exports it under its
 * historical name so neither side has to duplicate the number.
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
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isChatAlreadyArchived(chat) {
  return chat?.archived === true || Boolean(asString(chat?.archivedAt));
}

/**
 * Builds the per-run `canArchive` predicate (requirement A). Fail-closed: any
 * missing signal (unknown liveness, unparseable `updatedAt`, throwing probe)
 * returns false, so the chat stays visible.
 *
 * @param {{
 *   now?: number,
 *   isChatRunConfirmedIdle?: (input: { chatId: string }) => boolean,
 *   graceMs?: number,
 * }} [options]
 * @returns {(chat: object | null | undefined) => boolean}
 */
export function createChatArchivable(options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const graceMs = Number.isFinite(options.graceMs) ? Number(options.graceMs) : CHAT_ARCHIVE_GRACE_MS;
  const idleFn = typeof options.isChatRunConfirmedIdle === 'function'
    ? options.isChatRunConfirmedIdle
    : isChatRunConfirmedIdle;
  return function chatArchivable(chat) {
    if (!chat || typeof chat !== 'object') return false;
    if (chat.watcherPinned === true) return false;
    if (isChatAlreadyArchived(chat)) return false;
    const updatedMs = Date.parse(asString(chat.updatedAt));
    if (!Number.isFinite(updatedMs)) return false;
    if (now - updatedMs < graceMs) return false;
    try {
      return idleFn({ chatId: asString(chat.id) }) === true;
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
 * A delegation child must be terminal AND slot-free; a deleted or already
 * archived child is nothing to hide and never blocks its parent. A corrupt
 * fork/delegation cycle is broken by the `visiting` set instead of recursing
 * forever. A failed delegation read is fail-closed (`null`).
 *
 * @param {{
 *   chats: object[],
 *   chatArchivable: (chat: object) => boolean,
 *   listDelegationsForParent?: (parentChatId: string) => object[],
 *   isTerminalDelegationStatus?: (status: unknown) => boolean,
 *   isDelegationSlotOccupied?: (row: object, nowMs: number) => boolean,
 *   now?: number,
 * }} input
 * @returns {{ collect: (rootChat: object) => object[] | null, byId: Map<string, object> }}
 */
export function createFamilyCollector(input = {}) {
  const chats = Array.isArray(input.chats) ? input.chats : [];
  const chatArchivable = typeof input.chatArchivable === 'function' ? input.chatArchivable : () => false;
  const listChildrenFn = typeof input.listDelegationsForParent === 'function'
    ? input.listDelegationsForParent
    : listDelegationsForParent;
  const terminalFn = typeof input.isTerminalDelegationStatus === 'function'
    ? input.isTerminalDelegationStatus
    : isTerminalDelegationStatus;
  const slotOccupiedFn = typeof input.isDelegationSlotOccupied === 'function'
    ? input.isDelegationSlotOccupied
    : isDelegationSlotOccupied;
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();

  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const chat of chats) {
    const id = asString(chat?.id);
    if (id) byId.set(id, chat);
  }

  const directForks = (parentId) => chats.filter((chat) => asString(chat?.forkParentChatId) === parentId);

  const delegationsOf = (parentId) => {
    try {
      const rows = listChildrenFn(parentId);
      if (!Array.isArray(rows)) return null;
      return rows;
    } catch {
      return null;
    }
  };

  const collect = (chat, visiting) => {
    const id = asString(chat?.id);
    if (!id || visiting.has(id)) return null;
    if (!chatArchivable(chat)) return null;
    visiting.add(id);
    const members = [chat];
    for (const fork of directForks(id)) {
      const sub = collect(fork, visiting);
      if (!sub) {
        visiting.delete(id);
        return null;
      }
      members.push(...sub);
    }
    const delegationRows = delegationsOf(id);
    if (delegationRows === null) {
      visiting.delete(id);
      return null;
    }
    for (const row of delegationRows) {
      if (!terminalFn(row?.status) || slotOccupiedFn(row, now)) {
        visiting.delete(id);
        return null;
      }
      const childId = asString(row?.childChatId);
      if (!childId) continue;
      const child = byId.get(childId);
      // A deleted/already-archived child is nothing to hide and never blocks the parent.
      if (!child || isChatAlreadyArchived(child)) continue;
      const sub = collect(child, visiting);
      if (!sub) {
        visiting.delete(id);
        return null;
      }
      members.push(...sub);
    }
    visiting.delete(id);
    return members;
  };

  return { collect: (rootChat) => collect(rootChat, new Set()), byId };
}

/**
 * Archive a collected family children-before-parent (requirement C). Best
 * effort: a store write failure leaves that chat in place and never rethrows.
 * `done` dedupes across multiple calls over one chat snapshot.
 *
 * @param {object[]} members parent-first family from `createFamilyCollector`
 * @param {{
 *   updateChat?: (id: string, updates: object) => unknown,
 *   done?: Set<string>,
 * }} [options]
 * @returns {{ archived: string[], skipped: number }}
 */
export function archiveFamilyMembers(members, options = {}) {
  const updateChatFn = typeof options.updateChat === 'function' ? options.updateChat : updateChat;
  const done = options.done instanceof Set ? options.done : new Set();
  const summary = { archived: [], skipped: 0 };
  for (let i = members.length - 1; i >= 0; i -= 1) {
    const memberId = asString(members[i]?.id);
    if (!memberId || done.has(memberId)) continue;
    try {
      updateChatFn(memberId, { archived: true });
      done.add(memberId);
      summary.archived.push(memberId);
    } catch {
      summary.skipped += 1;
    }
  }
  return summary;
}

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
 *     loadChats?: () => object[],
 *     updateChat?: (id: string, updates: object) => unknown,
 *     listDelegationsForParent?: (parentChatId: string) => object[],
 *     isChatRunConfirmedIdle?: (input: { chatId: string }) => boolean,
 *     isDelegationSlotOccupied?: (row: object, nowMs: number) => boolean,
 *     isTerminalDelegationStatus?: (status: unknown) => boolean,
 *     hasActiveWorkspaceWatcherCycleChildren?: (chatId: string, delegations: object[]) => boolean,
 *   },
 * }} [options]
 * @returns {{ archived: string[], skipped: number, reason: string }}
 */
export function archiveChatFamily(rootChatId, options = {}) {
  const id = asString(rootChatId);
  const summary = { archived: [], skipped: 0, reason: '' };
  if (!id) {
    summary.skipped = 1;
    summary.reason = 'no_chat';
    return summary;
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};

  const loadChatsFn = typeof deps.loadChats === 'function' ? deps.loadChats : loadChats;
  const updateChatFn = typeof deps.updateChat === 'function' ? deps.updateChat : updateChat;
  const listChildrenFn = typeof deps.listDelegationsForParent === 'function'
    ? deps.listDelegationsForParent
    : listDelegationsForParent;
  const idleFn = typeof deps.isChatRunConfirmedIdle === 'function'
    ? deps.isChatRunConfirmedIdle
    : isChatRunConfirmedIdle;
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
      summary.skipped = 1;
      summary.reason = 'cycle_children_active';
      return summary;
    }
  } catch {
    summary.skipped = 1;
    summary.reason = 'cycle_children_active';
    return summary;
  }

  /** @type {object[]} */
  let chats;
  try {
    chats = loadChatsFn();
  } catch {
    summary.skipped = 1;
    summary.reason = 'load_failed';
    return summary;
  }
  if (!Array.isArray(chats)) {
    summary.skipped = 1;
    summary.reason = 'load_failed';
    return summary;
  }

  const chatArchivable = createChatArchivable({ now, isChatRunConfirmedIdle: idleFn });
  const { collect, byId } = createFamilyCollector({
    chats,
    chatArchivable,
    listDelegationsForParent: listChildrenFn,
    isTerminalDelegationStatus: terminalFn,
    isDelegationSlotOccupied: slotOccupiedFn,
    now,
  });

  const root = byId.get(id);
  if (!root) {
    summary.skipped = 1;
    summary.reason = 'chat_missing';
    return summary;
  }
  const family = collect(root);
  if (!family) {
    summary.skipped = 1;
    summary.reason = 'family_blocked';
    return summary;
  }
  const result = archiveFamilyMembers(family, { updateChat: updateChatFn, done: new Set() });
  summary.archived = result.archived;
  summary.skipped = result.skipped;
  summary.reason = result.archived.length ? 'archived' : 'nothing_to_archive';
  return summary;
}
