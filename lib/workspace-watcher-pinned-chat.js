/**
 * Pinned Workspace Chat — one durable chat per workspace for the Workspace
 * Watcher.
 *
 * Autopilot cycles are ephemeral: each cycle owns a short-lived orchestrator
 * chat. That leaves the operator without a stable place to see what the watcher
 * is doing or why. This module materializes exactly one long-lived chat per
 * workspace (`pinnedChatId` on the watcher row) and appends deterministic
 * notices to it.
 *
 * Design decisions (see docs/workspace-watcher-pinned-chat.md):
 *   - Notifications are persisted `meta` records (`variant: 'watcher'`), not
 *     lightweight agent runs. A watcher notice must be cheap and must never
 *     depend on a model being available.
 *   - User commands are not interpreted by an LLM here. The UI maps them onto
 *     the existing watcher/todo REST APIs (option A); the chat is a shell, not a
 *     new harness mode.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addChat, loadChats } from './persist/chats-persist.js';
import { appendChatNotice } from './persist/chat-history-persist.js';
import {
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceFolder,
} from './persist/workspace-watchers-persist.js';

/** Base title for the durable per-workspace watcher chat. */
export const WORKSPACE_WATCHER_PINNED_CHAT_BASE_TITLE = 'Workspace watcher';

/**
 * Human-readable title for a workspace's pinned chat.
 *
 * @param {unknown} workspaceFolder
 * @returns {string}
 */
export function workspaceWatcherPinnedChatTitle(workspaceFolder) {
  const raw = String(workspaceFolder || '').replace(/[\\/]+$/, '');
  const base = path.basename(raw) || 'workspace';
  return `${WORKSPACE_WATCHER_PINNED_CHAT_BASE_TITLE} — ${base}`;
}

/**
 * @param {unknown} chat
 * @returns {boolean}
 */
export function isWorkspaceWatcherPinnedChat(chat) {
  return Boolean(chat && typeof chat === 'object' && chat.watcherPinned === true);
}

/**
 * Find an existing pinned chat for a workspace, regardless of whether the
 * watcher row still remembers its id. Used to recover after a manual delete of
 * the row (or a lost `pinnedChatId`) without creating a duplicate.
 *
 * @param {unknown} workspaceFolder
 * @param {object[]} [chats]
 * @returns {object | null}
 */
export function findWorkspaceWatcherPinnedChat(workspaceFolder, chats = loadChats()) {
  const folder = normalizeWorkspaceFolder(workspaceFolder);
  if (!folder) return null;
  return (Array.isArray(chats) ? chats : []).find(
    (chat) => isWorkspaceWatcherPinnedChat(chat)
      && normalizeWorkspaceFolder(chat.workspaceFolder) === folder,
  ) || null;
}

/**
 * Idempotently materialize the pinned chat for one workspace.
 *
 * Resolution order:
 *   1. The id stored on the watcher row, when that chat still exists.
 *   2. Any surviving chat marked `watcherPinned` for the same workspace.
 *   3. Create a new one (reusing the stored id when present so a lost transcript
 *      cannot create an unbounded stream of new ids).
 *
 * The chat store is a separate file, so creation and the row update cannot be
 * one transaction; both steps are individually idempotent, which makes a retry
 * converge on the same chat.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   deps?: object,
 * }} [input]
 * @returns {{ ok: boolean, reason?: string, chatId?: string, chat?: object|null, created?: boolean, adopted?: boolean, watcher?: object|null }}
 */
export function ensurePinnedChat(input = {}) {
  const folder = normalizeWorkspaceFolder(input.workspaceFolder);
  if (!folder) return { ok: false, reason: 'no_workspace' };
  const dataDir = String(input.dataDir ?? '').trim();
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
  const loadChatsFn = typeof deps.loadChats === 'function' ? deps.loadChats : loadChats;
  const addChatFn = typeof deps.addChat === 'function' ? deps.addChat : addChat;
  const getWatcherFn = typeof deps.getWorkspaceWatcher === 'function'
    ? deps.getWorkspaceWatcher
    : getWorkspaceWatcher;
  const mutateRowFn = typeof deps.mutateWorkspaceWatcherRow === 'function'
    ? deps.mutateWorkspaceWatcherRow
    : mutateWorkspaceWatcherRow;

  const row = getWatcherFn(folder, { dataDir });
  const storedId = String(row?.pinnedChatId || '').trim();
  const chats = loadChatsFn();
  if (storedId) {
    const stored = (Array.isArray(chats) ? chats : []).find((chat) => chat?.id === storedId);
    if (stored) {
      return { ok: true, chatId: stored.id, chat: stored, created: false, adopted: false, watcher: row };
    }
  }
  const survivor = findWorkspaceWatcherPinnedChat(folder, chats);
  if (survivor) {
    if (survivor.id !== storedId) {
      mutateRowFn(folder, () => ({ pinnedChatId: survivor.id }), { dataDir });
    }
    return { ok: true, chatId: survivor.id, chat: survivor, created: false, adopted: true, watcher: row };
  }

  let created;
  try {
    // Pinning materializes the durable chat through `addChat`, so the server emits its own
    // `chatsChanged { reason: 'create' }` frame; the watcher live frame never has to reload
    // the chat list for a newly pinned chat.
    created = addChatFn(
      randomUUID(),
      workspaceWatcherPinnedChatTitle(folder),
      null,
      folder,
      undefined,
      {
        id: storedId || randomUUID(),
        watcherPinned: true,
        agentTransport: 'sdk',
        sdkMode: 'agent',
      },
    );
  } catch (error) {
    return { ok: false, reason: 'create_failed', error: error?.message || String(error) };
  }
  if (!created?.id) return { ok: false, reason: 'create_failed' };
  const updated = mutateRowFn(folder, () => ({ pinnedChatId: created.id }), { dataDir });
  return {
    ok: true,
    chatId: created.id,
    chat: created,
    created: true,
    adopted: false,
    watcher: updated?.row || row,
  };
}

/**
 * Append one watcher notice to the workspace's pinned chat, materializing the
 * chat first when needed. Never throws: a failed notice must not break a watcher
 * tick or cycle.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   action?: string,
 *   text?: string,
 *   level?: string,
 *   todoId?: string,
 *   cycleId?: string,
 *   chatId?: string,
 *   at?: string,
 *   deps?: object,
 * }} [input]
 * @returns {{ ok: boolean, reason?: string, chatId?: string, seq?: number, created?: boolean }}
 */
export function appendWorkspaceWatcherNotice(input = {}) {
  try {
    const folder = normalizeWorkspaceFolder(input.workspaceFolder);
    if (!folder) return { ok: false, reason: 'no_workspace' };
    const text = String(input.text == null ? '' : input.text).trim();
    if (!text) return { ok: false, reason: 'empty_notice' };
    const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
    const ensured = ensurePinnedChat({ workspaceFolder: folder, dataDir: input.dataDir, deps });
    if (!ensured.ok || !ensured.chatId) {
      return { ok: false, reason: ensured.reason || 'no_pinned_chat' };
    }
    const appendFn = typeof deps.appendChatNotice === 'function' ? deps.appendChatNotice : appendChatNotice;
    const result = appendFn(ensured.chatId, text, {
      action: String(input.action || 'info'),
      level: String(input.level || 'info'),
      workspaceFolder: folder,
      todoId: String(input.todoId || ''),
      cycleId: String(input.cycleId || ''),
      chatId: String(input.chatId || ''),
      at: String(input.at || new Date().toISOString()),
    });
    if (!result || result.ok === false) {
      return { ok: false, reason: result?.error || 'append_failed', chatId: ensured.chatId };
    }
    const seq = Array.isArray(result.appended) && result.appended.length
      ? Number(result.appended[result.appended.length - 1].seq)
      : undefined;
    return { ok: true, chatId: ensured.chatId, seq, created: ensured.created === true };
  } catch (error) {
    return { ok: false, reason: error?.message || 'notice_failed' };
  }
}
