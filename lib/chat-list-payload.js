// The pure liveness predicate lives in its own module: importing the full
// worktree record chain here would pull `node:crypto`/`node:path` into the
// browser bundle (see lib/worktree/worktree-record-live.ts).
import { isWorktreeRecordLive } from './worktree/worktree-record-live.ts';

/**
 * Server-internal row fields the sidebar never reads: provider session ids and
 * delegation bookkeeping. Dropped from the list payload (they repeat on every
 * row of a multi-thousand-row startup response); `includeSummaries=1` keeps the
 * full persisted row for callers that need it.
 */
export const CHAT_LIST_INTERNAL_FIELDS = Object.freeze([
  'summaries',
  'opencodeSessionId',
  'codebuddySessionId',
  'deepseekSessionId',
  'codexThreadId',
  'qwenSessionId',
  'claudeSessionId',
  'delegationSessionIdentity',
  'delegationSessionGeneration',
  'delegationGrant',
  'delegationRootDelegationId',
]);

/**
 * Strip heavy and internal fields from GET /api/chats rows. Summaries are only
 * needed for title-fork / compression flows, not the sidebar list.
 *
 * @param {Record<string, any> | null | undefined} chat
 * @param {{ includeSummaries?: boolean }} [options]
 * @returns {Record<string, any> | null | undefined}
 */
export function mapChatForClientList(chat, options = {}) {
  if (!chat || typeof chat !== 'object') return chat;
  if (options.includeSummaries === true) return chat;
  let copy = null;
  for (const field of CHAT_LIST_INTERNAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(chat, field)) continue;
    if (!copy) copy = { ...chat };
    delete copy[field];
  }
  return copy || chat;
}

/**
 * @param {Record<string, any>[]} chats
 * @param {{ includeSummaries?: boolean }} [options]
 * @returns {Record<string, any>[]}
 */
export function mapChatsForClientList(chats, options = {}) {
  if (!Array.isArray(chats)) return [];
  return chats.map((chat) => mapChatForClientList(chat, options));
}

/**
 * Live (not cleaned, with a path) worktree todo ids from registry records.
 *
 * A chat that a worktree execution created — including a delegated child —
 * keeps the root `todoId`, so this set is all the sidebar needs to mark those
 * chats without a per-row Git request.
 *
 * @param {Record<string, any>[] | null | undefined} records
 * @returns {Set<string>}
 */
export function collectLiveWorktreeTodoIds(records) {
  const ids = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    if (!isWorktreeRecordLive(record) || !record.worktreePath) continue;
    const todoId = String(record.todoId || '').trim();
    if (todoId) ids.add(todoId);
  }
  return ids;
}

/**
 * Add `onWorktree: true` to chats whose linked task tree runs in a live
 * worktree. The field is added only when true, so a large full-index payload
 * does not grow per row and a cleaned worktree stops marking its chats.
 *
 * @param {Record<string, any>[]} chats
 * @param {Set<string>} worktreeTodoIds
 * @returns {Record<string, any>[]}
 */
export function markWorktreeChats(chats, worktreeTodoIds) {
  if (!Array.isArray(chats) || !(worktreeTodoIds instanceof Set) || worktreeTodoIds.size === 0) {
    return chats;
  }
  return chats.map((chat) => {
    if (!chat || typeof chat !== 'object') return chat;
    const todoId = String(chat.todoId || '').trim();
    if (!todoId || !worktreeTodoIds.has(todoId)) return chat;
    return { ...chat, onWorktree: true };
  });
}

/**
 * Compact per-workspace counts so the sidebar can show Archive without loading
 * archived rows on boot.
 *
 * @param {Record<string, any>[] | null | undefined} chats
 * @returns {Record<string, number>}
 */
export function countArchivedChatsByWorkspace(chats) {
  const counts = Object.create(null);
  if (!Array.isArray(chats)) return counts;
  for (const chat of chats) {
    if (!chat || typeof chat !== 'object') continue;
    if (!String(chat.archivedAt || '').trim()) continue;
    const key = `${String(chat.workspaceFile || '')}\n${String(chat.workspaceFolder || '')}`;
    counts[key] = (Number(counts[key]) || 0) + 1;
  }
  return counts;
}

/**
 * Sidebar list GET: archived rows are opt-in.
 *
 * @param {{ includeArchived?: boolean, pinnedTo?: string, archiveWorkspace?: string }} [query]
 * @returns {{ includeArchived?: boolean, pinnedTo?: string, archiveWorkspace?: string }}
 */
export function buildChatsListApiQuery(query = {}) {
  const apiQuery = {};
  if (typeof query.pinnedTo === 'string' && query.pinnedTo.trim()) {
    apiQuery.pinnedTo = query.pinnedTo.trim();
  }
  if (query.includeArchived === true) {
    apiQuery.includeArchived = true;
  }
  if (typeof query.archiveWorkspace === 'string' && query.archiveWorkspace.trim()) {
    apiQuery.archiveWorkspace = query.archiveWorkspace.trim();
  }
  return apiQuery;
}

/**
 * Collapse overlapping GET /api/chats loads into one follow-up query.
 *
 * @param {Record<string, any>} [current]
 * @param {Record<string, any>} [incoming]
 * @returns {{ skipAutoSelect: boolean, includeArchived: boolean, preferChatId: string, pinnedTo: string, archiveWorkspace: string }}
 */
/**
 * Whether GET /api/chats represents the full profile index (safe to drop activity
 * for chats absent from the response). Widget-scoped lists and pinned lookups are
 * never authoritative.
 *
 * @param {{ widgetAccess?: unknown, query?: { pinnedTo?: string } }} req
 * @param {boolean} includeArchived
 * @returns {boolean}
 */
export function isFullChatListIndexForServer(req, includeArchived) {
  if (req && req.widgetAccess) return false;
  const pinnedTo = typeof req?.query?.pinnedTo === 'string' ? req.query.pinnedTo.trim() : '';
  if (pinnedTo) return false;
  return includeArchived === true;
}

/**
 * Client-side gate for activity pruning after a list refresh.
 *
 * @param {{ fullIndex?: boolean, chats?: unknown[] } | null | undefined} data
 * @returns {boolean}
 */
export function shouldPruneChatActivityFromListResponse(data) {
  if (!data || data.fullIndex !== true) return false;
  return Array.isArray(data.chats) && data.chats.length > 0;
}

export function mergeChatListLoadQuery(current, incoming) {
  const a = current && typeof current === 'object' ? current : {};
  const b = incoming && typeof incoming === 'object' ? incoming : {};
  const preferB = typeof b.preferChatId === 'string' ? b.preferChatId.trim() : '';
  const preferA = typeof a.preferChatId === 'string' ? a.preferChatId.trim() : '';
  const pinnedB = typeof b.pinnedTo === 'string' ? b.pinnedTo.trim() : '';
  const pinnedA = typeof a.pinnedTo === 'string' ? a.pinnedTo.trim() : '';
  const archiveB = typeof b.archiveWorkspace === 'string' ? b.archiveWorkspace.trim() : '';
  const archiveA = typeof a.archiveWorkspace === 'string' ? a.archiveWorkspace.trim() : '';
  return {
    skipAutoSelect: a.skipAutoSelect === true && b.skipAutoSelect === true,
    skipIfInFlight: a.skipIfInFlight === true || b.skipIfInFlight === true,
    forceRefresh: a.forceRefresh === true || b.forceRefresh === true,
    includeArchived: a.includeArchived === true || b.includeArchived === true,
    preferChatId: preferB || preferA,
    pinnedTo: pinnedB || pinnedA,
    archiveWorkspace: archiveB || archiveA,
    skipCache: a.skipCache === true || b.skipCache === true,
  };
}
