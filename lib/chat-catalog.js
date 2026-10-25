/**
 * ChatCatalog: frozen read-side contract for vertical V1 (docs/architecture-chat-catalog-contract.md).
 *
 * A catalog is an immutable, revision-stamped view of the chat list built from ONE
 * `loadChats()` snapshot. It answers get-by-id, list-by-scope, children and counts
 * from indexes instead of re-copying the whole list per lookup. It never writes:
 * every mutation stays in `lib/persist/chats-persist.js`.
 *
 * Transports keep their own policy. The catalog only reports `NOT_FOUND` /
 * `OUT_OF_SCOPE` as typed errors (or null/empty on the non-throwing reads); mapping
 * them to HTTP 404/403, WS frames or MCP errors is the transport's job.
 */

import path from 'node:path';
import { collectArchivedAncestorIds, isChatArchived, readForkParentChatId } from './chat-tree.js';
import { peekChatsSnapshot } from './persist/chats-persist.js';

export const CHAT_CATALOG_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  STALE_CURSOR: 'STALE_CURSOR',
});

/** First-page record cap is constant: it never depends on the number of chats. */
export const CHAT_CATALOG_PAGE_DEFAULT_LIMIT = 100;
export const CHAT_CATALOG_PAGE_MAX_LIMIT = 500;

export class ChatCatalogError extends Error {
  /**
   * @param {string} code One of {@link CHAT_CATALOG_ERROR_CODES}.
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ChatCatalogError';
    this.code = code;
  }
}

/**
 * @typedef {Record<string, any>} ChatCatalogScope
 * @property {string} [workspaceFolder] Match chats whose workspaceFolder resolves to this path.
 * @property {string} [workspaceFile] Fallback match on workspaceFile when no folder pair exists.
 * @property {string} [widgetInstallationId] When set, only chats bound to this widget installation.
 */

/**
 * `tree` = live rows plus archived ancestors of live rows (sidebar parity with
 * `selectChatsForSidebarList`; ancestors are computed within the scoped rows).
 * @typedef {'include' | 'exclude' | 'only' | 'tree'} ChatArchiveFilter
 */

const EMPTY = Object.freeze([]);

/**
 * Pure subset of the MCP workspace rule (folder wins, then file). The third MCP
 * branch (folder vs. chat workspaceFile resolved through the SDK cwd) needs runtime
 * deps and is NOT part of this contract; callers that need it pass `matchesWorkspace`.
 *
 * @param {Record<string, any>} chat
 * @param {ChatCatalogScope} scope
 * @returns {boolean}
 */
function matchesWorkspaceScope(chat, scope) {
  const folder = String(scope.workspaceFolder || '').trim();
  const chatFolder = String(chat.workspaceFolder || '').trim();
  if (folder && chatFolder) return path.resolve(chatFolder) === path.resolve(folder);
  const file = String(scope.workspaceFile || '').trim();
  const chatFile = String(chat.workspaceFile || '').trim();
  if (file && chatFile) return path.resolve(chatFile) === path.resolve(file);
  return !folder && !file;
}

/**
 * @param {Record<string, any>} chat
 * @param {ChatCatalogScope} scope
 * @param {(chat: Record<string, any>, scope: ChatCatalogScope) => boolean} [matcher]
 * @returns {boolean}
 */
export function isChatInScope(chat, scope, matcher = matchesWorkspaceScope) {
  // An empty scope matches everything and never reaches the (possibly injected) matcher,
  // so list, counts and require agree for any matcher.
  if (!scope || !(scope.workspaceFolder || scope.workspaceFile || scope.widgetInstallationId)) return true;
  if (scope.widgetInstallationId && chat.widgetInstallationId !== scope.widgetInstallationId) return false;
  return matcher(chat, scope);
}

/**
 * @param {unknown} filter
 * @returns {ChatArchiveFilter}
 */
function normalizeArchiveFilter(filter) {
  if (filter === undefined || filter === 'include') return 'include';
  if (filter === 'exclude' || filter === 'only' || filter === 'tree') return filter;
  throw new ChatCatalogError(CHAT_CATALOG_ERROR_CODES.INVALID_ARGUMENT, `Unknown archive filter: ${String(filter)}`);
}

/**
 * @param {Record<string, any>} chat
 * @param {ChatArchiveFilter} archive
 * @param {Set<string> | null} [keep] Archived ancestor ids (`tree` mode only).
 * @returns {boolean}
 */
function passesArchiveFilter(chat, archive, keep = null) {
  if (archive === 'include') return true;
  if (archive === 'tree') return !isChatArchived(chat) || Boolean(keep && keep.has(chat.id));
  return isChatArchived(chat) === (archive === 'only');
}

/**
 * Build a catalog from an already loaded chat list. Pure: no I/O, no clock.
 * Duplicate ids keep the FIRST row (same rule as the request-local index in
 * `delegations-routes.js`). Rows without a string id are listed but not indexed.
 *
 * The container and index results are frozen. Chat records are the rows passed in
 * (zero copy) and are read-only BY CONTRACT; they are not deep-frozen because
 * existing callers receive the same private copies `loadChats()` hands out.
 *
 * @param {Record<string, any>[]} chats
 * @param {{ revision?: string, matchesWorkspace?: (chat: Record<string, any>, scope: ChatCatalogScope) => boolean }} [options]
 */
export function createChatCatalog(chats, options = {}) {
  const rows = Object.freeze((Array.isArray(chats) ? chats : []).filter((chat) => chat && typeof chat === 'object'));
  const revision = String(options.revision || '');
  const matcher = typeof options.matchesWorkspace === 'function' ? options.matchesWorkspace : matchesWorkspaceScope;
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  /** @type {Map<string, Record<string, any>[]>} */
  const byParent = new Map();
  for (const chat of rows) {
    if (typeof chat.id === 'string' && chat.id && !byId.has(chat.id)) byId.set(chat.id, chat);
    const parentId = readForkParentChatId(chat);
    if (!parentId) continue;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(chat);
    else byParent.set(parentId, [chat]);
  }

  for (const siblings of byParent.values()) Object.freeze(siblings);

  /**
   * Archived ancestors of live rows for the `tree` filter, computed within the scoped rows.
   *
   * @param {ChatArchiveFilter} archive
   * @param {ChatCatalogScope | null} scope
   * @returns {Set<string> | null}
   */
  function treeKeepIds(archive, scope) {
    if (archive !== 'tree') return null;
    return collectArchivedAncestorIds(scope
      ? rows.filter((chat) => isChatInScope(chat, scope, matcher))
      : /** @type {Record<string, any>[]} */ (rows));
  }

  /** @param {unknown} id @returns {object | null} */
  function get(id) {
    return typeof id === 'string' ? byId.get(id) || null : null;
  }

  /**
   * @param {unknown} id
   * @param {ChatCatalogScope} [scope]
   * @returns {Record<string, any>}
   */
  function require(id, scope = {}) {
    const chat = get(id);
    if (!chat) throw new ChatCatalogError(CHAT_CATALOG_ERROR_CODES.NOT_FOUND, 'Chat not found');
    if (!isChatInScope(chat, scope, matcher)) {
      throw new ChatCatalogError(CHAT_CATALOG_ERROR_CODES.OUT_OF_SCOPE, 'This chat is outside the requested scope.');
    }
    return chat;
  }

  /**
   * @param {{ scope?: ChatCatalogScope, archived?: ChatArchiveFilter }} [query]
   * @returns {readonly Record<string, any>[]} Store order, deterministic.
   */
  function list(query = {}) {
    const archive = normalizeArchiveFilter(query.archived);
    const scope = query.scope || null;
    const hasScope = Boolean(scope && (scope.workspaceFolder || scope.workspaceFile || scope.widgetInstallationId));
    if (!hasScope && archive === 'include') return rows;
    const keep = treeKeepIds(archive, hasScope ? scope : null);
    return Object.freeze(rows.filter((chat) => (
      passesArchiveFilter(chat, archive, keep) && (!hasScope || isChatInScope(chat, scope, matcher))
    )));
  }

  /**
   * @param {unknown} parentId
   * @returns {readonly Record<string, any>[]} Direct children by `forkParentChatId`, store order.
   */
  function children(parentId) {
    return typeof parentId === 'string' ? byParent.get(parentId.trim()) || EMPTY : EMPTY;
  }

  /**
   * @param {{ scope?: ChatCatalogScope }} [query]
   * @returns {{ total: number, archived: number, live: number, roots: number }}
   */
  function counts(query = {}) {
    const scoped = list({ scope: query.scope });
    let archived = 0;
    let roots = 0;
    for (const chat of scoped) {
      if (isChatArchived(chat)) archived += 1;
      if (!readForkParentChatId(chat)) roots += 1;
    }
    return Object.freeze({ total: scoped.length, archived, live: scoped.length - archived, roots });
  }

  /**
   * @param {unknown} cursor
   * @returns {number} Store position to resume from.
   */
  function decodeCursor(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return 0;
    const match = /^(\d+)@(.*)$/.exec(String(cursor));
    if (!match) throw new ChatCatalogError(CHAT_CATALOG_ERROR_CODES.INVALID_ARGUMENT, 'Malformed cursor');
    if (match[2] !== revision) {
      throw new ChatCatalogError(CHAT_CATALOG_ERROR_CODES.STALE_CURSOR, 'Chat list changed since the cursor was issued');
    }
    return Number(match[1]);
  }

  /**
   * Keyset page over store order (the store position is the sequence). Scope and
   * archive filters run BEFORE the limit, so a page is never short because of rows
   * a filter would drop. Only `limit` records are collected per call and the walk
   * stops at the first row after a full page; `archived=tree` still pays an O(rows) ancestor pass up front.
   *
   * @param {{ scope?: ChatCatalogScope, archived?: ChatArchiveFilter, limit?: number, cursor?: string }} [query]
   * @returns {{ items: Record<string, any>[], nextCursor: string | null, revision: string }}
   */
  function page(query = {}) {
    const archive = normalizeArchiveFilter(query.archived);
    const scope = query.scope || null;
    const hasScope = Boolean(scope && (scope.workspaceFolder || scope.workspaceFile || scope.widgetInstallationId));
    const requested = Number.parseInt(String(query.limit ?? CHAT_CATALOG_PAGE_DEFAULT_LIMIT), 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), CHAT_CATALOG_PAGE_MAX_LIMIT)
      : CHAT_CATALOG_PAGE_DEFAULT_LIMIT;
    const keep = treeKeepIds(archive, hasScope ? scope : null);
    const items = [];
    let pos = decodeCursor(query.cursor);
    let nextCursor = null;
    for (; pos < rows.length; pos += 1) {
      const chat = rows[pos];
      if (!passesArchiveFilter(chat, archive, keep) || (hasScope && !isChatInScope(chat, scope, matcher))) continue;
      if (items.length >= limit) {
        nextCursor = `${pos}@${revision}`;
        break;
      }
      items.push(chat);
    }
    return { items, nextCursor, revision };
  }

  /**
   * Archived-row counts keyed like `countArchivedChatsByWorkspace` (file + newline +
   * folder) without materializing the archived rows.
   *
   * @param {{ scope?: ChatCatalogScope }} [query]
   * @returns {Record<string, number>}
   */
  function archivedCountsByWorkspace(query = {}) {
    const counts = Object.create(null);
    for (const chat of list({ scope: query.scope })) {
      if (!String(chat.archivedAt || '').trim()) continue;
      const key = `${String(chat.workspaceFile || '')}\n${String(chat.workspaceFolder || '')}`;
      counts[key] = (Number(counts[key]) || 0) + 1;
    }
    return counts;
  }

  return Object.freeze({
    revision, size: rows.length, get, require, list, children, counts, page, archivedCountsByWorkspace,
  });
}

/**
 * Take a read-only catalog snapshot of the persisted chat list. The revision is a hash of the bytes
 * read from the store (empty when no file exists).
 * Two snapshots with the same non-empty revision describe identical data.
 *
 * @param {{ matchesWorkspace?: (chat: Record<string, any>, scope: ChatCatalogScope) => boolean }} [options]
 */
export function readChatCatalog(options = {}) {
  const { chats, revision } = peekChatsSnapshot();
  return createChatCatalog(/** @type {Record<string, any>[]} */ (chats), { ...options, revision });
}
