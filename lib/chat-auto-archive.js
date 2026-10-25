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
 *
 * The sweep is dependency-injected so unit tests run without a chat store, a
 * delegation store or a model.
 */

import { loadChats, updateChat } from './persist/chats-persist.js';
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
 * @returns {{
 *   enabled: boolean,
 *   skipFavorites: boolean,
 *   idleValue: number,
 *   idleUnit: string,
 *   idleMs: number,
 *   considered: number,
 *   archived: string[],
 *   archivedTitles: string[],
 *   skipped: number,
 *   reason: string,
 * }}
 */
export function sweepIdleChats(options = {}) {
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : loadSettings();
  const cfg = getChatAutoArchiveSettings(settings);
  /** @type {{ enabled: boolean, skipFavorites: boolean, idleValue: number, idleUnit: string, idleMs: number, considered: number, archived: string[], archivedTitles: string[], skipped: number, reason: string }} */
  const summary = {
    enabled: cfg.enabled,
    skipFavorites: cfg.skipFavorites,
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
  const loadChatsFn = typeof deps.loadChats === 'function' ? deps.loadChats : loadChats;
  const updateChatFn = typeof deps.updateChat === 'function' ? deps.updateChat : updateChat;
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

  /** @type {Set<string>} */
  let favoriteIds = new Set();
  if (cfg.skipFavorites) {
    const loadFavoritesFn = typeof deps.loadFavoriteChatIds === 'function'
      ? deps.loadFavoriteChatIds
      : loadFavoriteChatIds;
    let loaded;
    try {
      loaded = loadFavoritesFn();
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
    chats = loadChatsFn();
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
   * @returns {boolean}
   */
  function hasActiveParentDelegation(chat) {
    const parentId = asString(chat?.forkParentChatId);
    if (!parentId) return false;
    const id = asString(chat?.id);
    if (!id) return false;
    let rows;
    try {
      rows = listChildrenFn(parentId);
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
    if (hasActiveParentDelegation(chat)) {
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
    // The family is collected parent-first and written children-before-parent.
    const result = archiveFamilyMembers(family, { updateChat: updateChatFn, done });
    summary.archived.push(...result.archived);
    const titleById = new Map(chats.map((row) => [asString(row?.id), asString(row?.title || row?.name)]));
    for (const archivedId of result.archived) summary.archivedTitles.push(titleById.get(archivedId) || archivedId);
    summary.skipped += result.skipped;
  }
  if (summary.archived.length) summary.reason = 'archived';
  return summary;
}
