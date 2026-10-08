/**
 * Automatic archiving of idle chats (Settings → Chat & agents → General).
 *
 * This is the generic, opt-in sibling of the always-on sweeps for Workspace
 * Watcher orchestrator families (`workspace-watcher-archive-sweep.js`) and
 * Scout chats (`archiveIdleScoutChats`). It reuses the same fail-closed
 * `canArchive` gate and children-before-parent family writer from
 * `chat-archive-policy.js`, so it can never hide a pinned chat, a chat with a
 * live run, or a delegation child that still holds a slot.
 *
 * The sweep is dependency-injected so unit tests run without a chat store, a
 * delegation store or a model.
 */

import { loadChats, updateChat } from './persist/chats-persist.js';
import { listDelegationsForParent } from './persist/delegations-persist.js';
import { isChatRunConfirmedIdle } from './chat-run-service.js';
import { isDelegationSlotOccupied, isTerminalDelegationStatus } from './delegation-status.js';
import { getChatAutoArchiveSettings, loadSettings } from './persist/settings.js';
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
 * Archive every chat whose activity is older than the configured idle window,
 * together with the archivable part of its fork/delegation family. Disabled by
 * default; a disabled or unreadable configuration is a no-op.
 *
 * @param {{
 *   settings?: object,
 *   now?: number,
 *   deps?: {
 *     loadChats?: () => object[],
 *     updateChat?: (id: string, updates: object) => unknown,
 *     listDelegationsForParent?: (parentChatId: string) => object[],
 *     isChatRunConfirmedIdle?: (input: { chatId: string }) => boolean,
 *     isDelegationSlotOccupied?: (row: object, nowMs: number) => boolean,
 *     isTerminalDelegationStatus?: (status: unknown) => boolean,
 *   },
 * }} [options]
 * @returns {{
 *   enabled: boolean,
 *   idleValue: number,
 *   idleUnit: string,
 *   idleMs: number,
 *   considered: number,
 *   archived: string[],
 *   skipped: number,
 *   reason: string,
 * }}
 */
export function sweepIdleChats(options = {}) {
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : loadSettings();
  const cfg = getChatAutoArchiveSettings(settings);
  /** @type {{ enabled: boolean, idleValue: number, idleUnit: string, idleMs: number, considered: number, archived: string[], skipped: number, reason: string }} */
  const summary = {
    enabled: cfg.enabled,
    idleValue: cfg.idleValue,
    idleUnit: cfg.idleUnit,
    idleMs: cfg.idleMs,
    considered: 0,
    archived: [],
    skipped: 0,
    reason: cfg.enabled ? 'ok' : 'disabled',
  };
  if (!cfg.enabled) return summary;

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

  /** @type {object[]} */
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
    listDelegationsForParent: listChildrenFn,
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
   * @param {object} chat
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
    // The family is collected parent-first and written children-before-parent.
    const result = archiveFamilyMembers(family, { updateChat: updateChatFn, done });
    summary.archived.push(...result.archived);
    summary.skipped += result.skipped;
  }
  if (summary.archived.length) summary.reason = 'archived';
  return summary;
}
