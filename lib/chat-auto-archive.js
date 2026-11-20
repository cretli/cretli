/**
 * Automatic archiving of idle chats (Settings → Chat & agents → General).
 *
 * This is the generic, opt-in sibling of the always-on sweeps for Workspace
 * Watcher orchestrator families (`workspace-watcher-archive-sweep.js`) and
 * Scout chats (`archiveIdleScoutChats`). It reuses the same fail-closed
 * `canArchive` gate and children-before-parent family writer from
 * `chat-archive-policy.js`, so it can never hide a pinned chat, a chat with a
 * live run, or a delegation child that still holds a slot. Starred chats
 * (sidebar favorites) are skipped too unless `skipFavorites` is turned off.
 * With `skipUnread` (on by default) a finished run nobody has read keeps its
 * family visible, and the idle window also restarts whenever the chat is opened.
 *
 * The sweep is dependency-injected so unit tests run without a chat store, a
 * delegation store or a model.
 */

import { loadChatsAsync, updateChatAsync } from './persist/chats-persist.js';
import { listDelegationsForController } from './persist/delegations-persist.js';
import { createChatArchiveIdleProbe } from './chat-archive-idle.js';
import { isDelegationSlotOccupied, isTerminalDelegationStatus } from './delegation-status.js';
import { getChatAutoArchiveSettings, loadSettings } from './persist/settings.js';
import { loadSidebarLayout } from './persist/sidebar-layout.js';
import {
  archiveFamilyMembers,
  createChatArchivable,
  createFamilyCollector,
  isChatAlreadyArchived,
} from './chat-archive-policy.js';
import { isTechnicalChat } from './chat-retention.js';

/** A registry run younger than this always keeps a cold chat visible, whatever the idle window. */
export const CHAT_AUTO_ARCHIVE_MIN_STALE_RUN_MS = 60 * 60 * 1000;

/** One idle day in milliseconds. */
export const CHAT_AUTO_ARCHIVE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * True when a run finished after the chat was last opened. Technical chats
 * (delegation children, Watcher, Scout, merge) are normally never opened, so they
 * never count: otherwise their families would stay in the sidebar for good.
 *
 * @param {Record<string, any> | null | undefined} chat
 * @returns {boolean}
 */
export function isChatResultUnread(chat) {
  if (isTechnicalChat(chat)) return false;
  const finishedMs = Date.parse(asString(chat?.lastFinishedAt));
  if (!Number.isFinite(finishedMs)) return false;
  const seenMs = Date.parse(asString(chat?.lastSeenAt));
  return !Number.isFinite(seenMs) || seenMs < finishedMs;
}

/**
 * Start of the idle window when opening a chat counts as activity: the later of
 * the last message and the last time the chat was opened.
 *
 * @param {Record<string, any>} chat
 * @returns {number}
 */
export function chatLastActivityMs(chat) {
  const updatedMs = Date.parse(asString(chat?.updatedAt));
  const seenMs = Date.parse(asString(chat?.lastSeenAt));
  return Number.isFinite(seenMs) ? Math.max(updatedMs, seenMs) : updatedMs;
}

/**
 * Start of the auto-archive idle window: the last message (and, with `skipUnread`,
 * the last open), pushed later by an explicit "postpone archiving" from the chat.
 *
 * @param {Record<string, any>} chat
 * @param {boolean} countOpens
 * @returns {number}
 */
export function chatAutoArchiveActivityMs(chat, countOpens) {
  const baseMs = countOpens ? chatLastActivityMs(chat) : Date.parse(asString(chat?.updatedAt));
  const postponedMs = Date.parse(asString(chat?.autoArchivePostponedAt));
  return Number.isFinite(postponedMs) ? Math.max(postponedMs, baseMs) : baseMs;
}

/**
 * Favorite chat ids from the shared sidebar layout. An unreadable layout yields
 * `null`, which makes the sweep fail closed (nothing archived) while favorites
 * are protected.
 *
 * @returns {Set<string> | null}
 */
function loadFavoriteChatIds() {
  try {
    const layout = loadSidebarLayout();
    const ids = Array.isArray(layout?.favoriteChatIds) ? layout.favoriteChatIds : [];
    return new Set(ids.map((id) => asString(id)).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Archive every chat whose activity is older than the configured idle window,
 * together with the archivable part of its fork/delegation family. Disabled by
 * default; a disabled or unreadable configuration is a no-op.
 *
 * @param {{
 *   settings?: Record<string, any>,
 *   now?: number,
 *   deps?: {
 *     loadChats?: () => Record<string, any>[],
 *     updateChat?: (id: string, updates: Record<string, any>) => unknown,
 *     listDelegationsForController?: (parentChatId: string) => Record<string, any>[],
 *     isChatRunConfirmedIdle?: (input: { chatId: string }) => boolean,
 *     isDelegationSlotOccupied?: (row: Record<string, any>, nowMs: number) => boolean,
 *     isTerminalDelegationStatus?: (status: unknown) => boolean,
 *     loadFavoriteChatIds?: () => Set<string> | string[] | null,
 *   },
 * }} [options]
 * @returns {Promise<{
 *   enabled: boolean,
 *   skipFavorites: boolean,
 *   skipUnread: boolean,
 *   idleValue: number,
 *   idleUnit: string,
 *   idleMs: number,
 *   considered: number,
 *   archived: string[],
 *   archivedTitles: string[],
 *   skipped: number,
 *   reason: string,
 * }>}
 */
export async function sweepIdleChats(options = {}) {
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : loadSettings();
  const cfg = getChatAutoArchiveSettings(settings);
  /** @type {{ enabled: boolean, skipFavorites: boolean, skipUnread: boolean, idleValue: number, idleUnit: string, idleMs: number, considered: number, archived: string[], archivedTitles: string[], skipped: number, reason: string }} */
  const summary = {
    enabled: cfg.enabled,
    skipFavorites: cfg.skipFavorites,
    skipUnread: cfg.skipUnread,
    idleValue: cfg.idleValue,
    idleUnit: cfg.idleUnit,
    idleMs: cfg.idleMs,
    considered: 0,
    archived: [],
    archivedTitles: [],
    skipped: 0,
    reason: cfg.enabled ? 'ok' : 'disabled',
  };
  if (!cfg.enabled) return summary;

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const deps = options.deps && typeof options.deps === 'object' ? options.deps : {};
  const loadChatsFn = typeof deps.loadChats === 'function' ? deps.loadChats : loadChatsAsync;
  const updateChatFn = typeof deps.updateChat === 'function' ? deps.updateChat : updateChatAsync;
  const listChildrenFn = typeof deps.listDelegationsForController === 'function'
    ? deps.listDelegationsForController
    : listDelegationsForController;
  const idleFn = typeof deps.isChatRunConfirmedIdle === 'function'
    ? deps.isChatRunConfirmedIdle
    : createChatArchiveIdleProbe({ fingerprintPerTick: true, staleRunMs: Math.max(cfg.idleMs, CHAT_AUTO_ARCHIVE_MIN_STALE_RUN_MS) });
  const slotOccupiedFn = typeof deps.isDelegationSlotOccupied === 'function'
    ? deps.isDelegationSlotOccupied
    : isDelegationSlotOccupied;
  const terminalFn = typeof deps.isTerminalDelegationStatus === 'function'
    ? deps.isTerminalDelegationStatus
    : isTerminalDelegationStatus;

  /** @type {Set<string>} */
  let favoriteIds = new Set();
  if (cfg.skipFavorites) {
    const loadFavoritesFn = typeof deps.loadFavoriteChatIds === 'function'
      ? deps.loadFavoriteChatIds
      : loadFavoriteChatIds;
    let loaded;
    try {
      loaded = await loadFavoritesFn();
    } catch {
      loaded = null;
    }
    if (!loaded || typeof loaded[Symbol.iterator] !== 'function') {
      summary.reason = 'favorites_load_failed';
      return summary;
    }
    favoriteIds = new Set(Array.from(loaded, (id) => asString(id)).filter(Boolean));
  }

  /** @type {Record<string, any>[]} */
  let chats;
  try {
    chats = await loadChatsFn();
  } catch {
    summary.reason = 'load_failed';
    return summary;
  }
  if (!Array.isArray(chats)) {
    summary.reason = 'load_failed';
    return summary;
  }

  const graceMs = cfg.idleMs;
  // `includeArchived` lets a fresh descendant connect its family to an already
  // archived ancestor, mirroring the Scout and Watcher sweeps; candidates
  // themselves are filtered to non-archived chats below.
  const chatArchivable = createChatArchivable({
    now,
    isChatRunConfirmedIdle: idleFn,
    graceMs,
    includeArchived: true,
    activityMs: (row) => chatAutoArchiveActivityMs(row, cfg.skipUnread),
  });
  const { collect } = createFamilyCollector({
    chats,
    chatArchivable,
    listDelegationsForController: listChildrenFn,
    isTerminalDelegationStatus: terminalFn,
    isDelegationSlotOccupied: slotOccupiedFn,
    now,
  });

  /** @type {Set<string>} */
  const done = new Set();

  /**
   * A delegation child must not be archived on its own while the parent's
   * delegation row is still non-terminal or holds a slot. The family gate only
   * sees that row when it collects from the parent, and a child is also a
   * standalone candidate here, so this guard keeps the two paths consistent.
   *
   * @param {Record<string, any>} chat
   * @returns {Promise<boolean>}
   */
  async function hasActiveParentDelegation(chat) {
    const parentId = asString(chat?.forkParentChatId);
    if (!parentId) return false;
    const id = asString(chat?.id);
    if (!id) return false;
    let rows;
    try {
      rows = await listChildrenFn(parentId);
    } catch {
      return true;
    }
    if (!Array.isArray(rows)) return true;
    for (const row of rows) {
      if (asString(row?.childChatId) !== id) continue;
      if (!terminalFn(row?.status) || slotOccupiedFn(row, now)) return true;
    }
    return false;
  }

  for (const chat of chats) {
    const id = asString(chat?.id);
    if (!id || done.has(id)) continue;
    if (isChatAlreadyArchived(chat)) continue;
    if (!chatArchivable(chat)) continue;
    summary.considered += 1;
    if (await hasActiveParentDelegation(chat)) {
      summary.skipped += 1;
      continue;
    }
    const family = collect(chat);
    if (!family) {
      summary.skipped += 1;
      continue;
    }
    // Archiving a parent cascades over its fork subtree, so one starred member
    // keeps the whole family in the sidebar.
    if (favoriteIds.size && family.some((member) => favoriteIds.has(asString(member?.id)))) {
      summary.skipped += 1;
      continue;
    }
    if (cfg.skipUnread && family.some((member) => isChatResultUnread(member))) {
      summary.skipped += 1;
      continue;
    }
    // The family is collected parent-first and written children-before-parent.
    const familyIds = new Set(family.map((member) => asString(member?.id)));
    const rootId = asString(family[0]?.id);
    const beforeArchive = async () => {
      let freshChats;
      try {
        freshChats = await loadChatsFn();
      } catch {
        return false;
      }
      if (!Array.isArray(freshChats)) return false;
      const freshRoot = freshChats.find((row) => asString(row?.id) === rootId);
      if (!freshRoot) return false;
      // Same window as the candidate pass, so a postpone that lands mid-sweep wins.
      const freshArchivable = createChatArchivable({
        now,
        isChatRunConfirmedIdle: idleFn,
        graceMs,
        includeArchived: true,
        activityMs: (row) => chatAutoArchiveActivityMs(row, cfg.skipUnread),
      });
      const freshCollector = createFamilyCollector({
        chats: freshChats,
        chatArchivable: freshArchivable,
        listDelegationsForController: listChildrenFn,
        isTerminalDelegationStatus: terminalFn,
        isDelegationSlotOccupied: slotOccupiedFn,
        now,
      });
      const freshFamily = freshCollector.collect(freshRoot);
      if (!freshFamily) return false;
      const freshIds = new Set(freshFamily.map((member) => asString(member?.id)));
      return freshIds.size === familyIds.size && [...familyIds].every((id) => freshIds.has(id));
    };
    const result = await archiveFamilyMembers(family, { updateChat: updateChatFn, beforeArchive, done });
    summary.archived.push(...result.archived);
    const titleById = new Map(chats.map((row) => [asString(row?.id), asString(row?.title || row?.name)]));
    for (const archivedId of result.archived) summary.archivedTitles.push(titleById.get(archivedId) || archivedId);
    summary.skipped += result.skipped;
  }
  if (summary.archived.length) summary.reason = 'archived';
  return summary;
}
