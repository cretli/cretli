/**
 * External tree ownership for the Workspace Watcher.
 *
 * A todo tree that a chat outside the watcher is driving (a manual `todo_start`
 * orchestrator, a leaf chat running its own implement/review loop) must not be
 * picked by an autopilot cycle: two orchestrators on one tree share a worktree,
 * overwrite each other's `orchestratorChatId` stamps and run duplicate paid
 * work. Pure helpers: the snapshot supplies the live chat / delegation facts,
 * and the pick only asks "is this leaf's tree owned by someone else right now".
 */

import { buildTodoIndex, readTodoParentId } from './todo-tree.js';
import { delegationController } from './delegation-control.js';

/** `pickPurpose` stamped on every watcher cycle orchestrator chat. */
export const WORKSPACE_WATCHER_ORCHESTRATOR_PICK_PURPOSE = 'watcher-orchestrator';

/**
 * A manual orchestrator is usually idle between turns (it waits for the user to
 * say "continue"), so an ancestor stamp keeps the tree owned for this long after
 * the chat's last activity even without a live run or delegation.
 */
export const WORKSPACE_WATCHER_EXTERNAL_OWNER_GRACE_MS = 30 * 60 * 1000;

/**
 * @typedef {{
 *   liveChatIds: string[],
 *   delegationLeafIds: string[],
 *   recentOrchestratorChatIds: string[],
 * }} WorkspaceWatcherExternalOwners
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function readId(value) {
  return String(value ?? '').trim();
}

/**
 * @param {Record<string, any> | null | undefined} chat
 * @returns {boolean}
 */
export function isWorkspaceWatcherOrchestratorChat(chat) {
  return readId(chat?.pickPurpose) === WORKSPACE_WATCHER_ORCHESTRATOR_PICK_PURPOSE;
}

/**
 * @param {Record<string, any> | null | undefined} chat
 * @returns {number}
 */
function readChatActivityMs(chat) {
  const stamps = [chat?.lastFinishedAt, chat?.lastStartedAt, chat?.createdAt]
    .map((value) => Date.parse(String(value ?? '')))
    .filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : Number.NaN;
}

/**
 * Collect the ownership facts from what the snapshot already loaded. Watcher
 * cycle chats and their children are never in `activeChatIds` /
 * `activeDelegations` (the snapshot excludes them), and watcher orchestrator
 * chats are dropped from the recent set by their `pickPurpose`, so a stale stamp
 * left by an earlier cycle never blocks the watcher from its own work.
 *
 * @param {{
 *   activeChatIds?: Iterable<unknown>,
 *   activeDelegations?: Record<string, any>[],
 *   chatRows?: Record<string, any>[],
 *   excludeChatIds?: Iterable<unknown>,
 *   now?: number,
 *   graceMs?: number,
 * }} [input]
 * @returns {WorkspaceWatcherExternalOwners}
 */
export function collectWorkspaceWatcherExternalOwners(input = {}) {
  const excluded = new Set([...(input.excludeChatIds || [])].map(readId).filter(Boolean));
  const live = new Set();
  const leafIds = new Set();
  for (const id of input.activeChatIds || []) {
    const chatId = readId(id);
    if (chatId && !excluded.has(chatId)) live.add(chatId);
  }
  for (const row of Array.isArray(input.activeDelegations) ? input.activeDelegations : []) {
    const parent = readId(delegationController(row));
    if (excluded.has(parent)) continue;
    if (parent) live.add(parent);
    const child = readId(row?.childChatId);
    if (child) live.add(child);
    const leafId = readId(row?.leafId);
    if (leafId) leafIds.add(leafId);
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const graceMs = Number.isFinite(input.graceMs)
    ? Math.max(0, Number(input.graceMs))
    : WORKSPACE_WATCHER_EXTERNAL_OWNER_GRACE_MS;
  const recent = new Set();
  for (const chat of Array.isArray(input.chatRows) ? input.chatRows : []) {
    const chatId = readId(chat?.id);
    if (!chatId || excluded.has(chatId)) continue;
    if (isWorkspaceWatcherOrchestratorChat(chat) || readId(chat?.archivedAt)) continue;
    const at = readChatActivityMs(chat);
    if (graceMs > 0 && Number.isFinite(at) && now - at < graceMs) recent.add(chatId);
  }
  for (const id of live) {
    if (excluded.has(id)) live.delete(id);
  }
  return {
    liveChatIds: [...live],
    delegationLeafIds: [...leafIds],
    recentOrchestratorChatIds: [...recent],
  };
}

/**
 * @param {Record<string, any>} row
 * @param {Map<string, Record<string, any>>} byId
 * @returns {Record<string, any>[]} the row and its ancestors, nearest first
 */
function collectAncestorChain(row, byId) {
  const chain = [];
  const seen = new Set();
  let current = byId.get(readId(row?.id)) || row;
  while (current && !seen.has(readId(current.id))) {
    seen.add(readId(current.id));
    chain.push(current);
    const parentId = readTodoParentId(current);
    current = parentId ? byId.get(parentId) || null : null;
  }
  return chain;
}

/**
 * @param {string} rootId
 * @param {Record<string, any>[]} items
 * @returns {Record<string, any>[]} every node whose root is `rootId`
 */
function collectTreeNodes(rootId, items, byId) {
  return items.filter((item) => {
    const chain = collectAncestorChain(item, byId);
    return readId(chain[chain.length - 1]?.id) === rootId;
  });
}

/**
 * Who, outside the watcher, owns the tree of `row` right now, or null.
 *
 * - live: any node of the tree is stamped (`orchestratorChatId`, `chatId`,
 *   `claimedByChatId`) with a chat that is running or controls an active
 *   delegation, or an active non-watcher delegation runs on a node of the tree;
 * - recent: the leaf or an ancestor carries an `orchestratorChatId` of a
 *   non-watcher chat active within the grace window (an idle manual
 *   orchestrator between turns).
 *
 * @param {Record<string, any>} row
 * @param {Record<string, any>[]} items
 * @param {WorkspaceWatcherExternalOwners | null | undefined} owners
 * @returns {{ chatId: string, todoId: string, reason: 'live_chat' | 'live_delegation' | 'recent_orchestrator' } | null}
 */
export function findWorkspaceWatcherExternalTreeOwner(row, items, owners) {
  if (!row || !owners) return null;
  const live = new Set(owners.liveChatIds || []);
  const leafIds = new Set(owners.delegationLeafIds || []);
  const recent = new Set(owners.recentOrchestratorChatIds || []);
  if (!live.size && !leafIds.size && !recent.size) return null;
  const list = Array.isArray(items) && items.length ? items : [row];
  const byId = buildTodoIndex(list);
  const chain = collectAncestorChain(row, byId);
  const rootId = readId(chain[chain.length - 1]?.id);
  for (const node of collectTreeNodes(rootId, list, byId)) {
    const todoId = readId(node.id);
    for (const field of ['orchestratorChatId', 'chatId', 'claimedByChatId']) {
      const chatId = readId(node[field]);
      if (chatId && live.has(chatId)) return { chatId, todoId, reason: 'live_chat' };
    }
    if (leafIds.has(todoId)) return { chatId: '', todoId, reason: 'live_delegation' };
  }
  for (const node of chain) {
    const chatId = readId(node.orchestratorChatId);
    if (chatId && recent.has(chatId)) {
      return { chatId, todoId: readId(node.id), reason: 'recent_orchestrator' };
    }
  }
  return null;
}

/**
 * Reserve-time re-check: asks the tree-owner rule against the live todo rows
 * (read inside the reserve) with the owners captured by the tick snapshot.
 *
 * @param {Record<string, any>} liveTodo
 * @param {Record<string, any>[]} liveItems
 * @param {WorkspaceWatcherExternalOwners | null | undefined} owners
 * @returns {string} abort reason, or '' when the tree is free
 */
export function resolveWorkspaceWatcherReserveOwnerAbort(liveTodo, liveItems, owners) {
  return findWorkspaceWatcherExternalTreeOwner(liveTodo, liveItems, owners)
    ? 'tree_owned_by_live_orchestrator'
    : '';
}
