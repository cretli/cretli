/**
 * Strip heavy fields from GET /api/chats rows. Summaries are only needed for
 * title-fork / compression flows, not the sidebar list.
 *
 * @param {object | null | undefined} chat
 * @param {{ includeSummaries?: boolean }} [options]
 * @returns {object | null | undefined}
 */
export function mapChatForClientList(chat, options = {}) {
  if (!chat || typeof chat !== 'object') return chat;
  if (options.includeSummaries === true) return chat;
  if (!Object.prototype.hasOwnProperty.call(chat, 'summaries')) return chat;
  const copy = { ...chat };
  delete copy.summaries;
  return copy;
}

/**
 * @param {object[]} chats
 * @param {{ includeSummaries?: boolean }} [options]
 * @returns {object[]}
 */
export function mapChatsForClientList(chats, options = {}) {
  if (!Array.isArray(chats)) return [];
  return chats.map((chat) => mapChatForClientList(chat, options));
}

/**
 * Compact per-workspace counts so the sidebar can show Archive without loading
 * archived rows on boot.
 *
 * @param {object[] | null | undefined} chats
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
 * @param {{ includeArchived?: boolean, pinnedTo?: string }} [query]
 * @returns {{ includeArchived?: boolean, pinnedTo?: string }}
 */
export function buildChatsListApiQuery(query = {}) {
  const apiQuery = {};
  if (typeof query.pinnedTo === 'string' && query.pinnedTo.trim()) {
    apiQuery.pinnedTo = query.pinnedTo.trim();
  }
  if (query.includeArchived === true) {
    apiQuery.includeArchived = true;
  }
  return apiQuery;
}

/**
 * Collapse overlapping GET /api/chats loads into one follow-up query.
 *
 * @param {object} [current]
 * @param {object} [incoming]
 * @returns {{ skipAutoSelect: boolean, includeArchived: boolean, preferChatId: string, pinnedTo: string }}
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
  return {
    skipAutoSelect: a.skipAutoSelect === true && b.skipAutoSelect === true,
    skipIfInFlight: a.skipIfInFlight === true || b.skipIfInFlight === true,
    forceRefresh: a.forceRefresh === true || b.forceRefresh === true,
    includeArchived: a.includeArchived === true || b.includeArchived === true,
    preferChatId: preferB || preferA,
    pinnedTo: pinnedB || pinnedA,
    skipCache: a.skipCache === true || b.skipCache === true,
  };
}
