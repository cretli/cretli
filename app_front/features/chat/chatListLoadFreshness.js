/**
 * Explicit freshness policy for GET /api/chats (task 7.1).
 *
 * Rules (summary):
 * - Join an in-flight request when its scope already satisfies the caller
 *   (a `full` load covers a later `live` open; identical pinned scope joins).
 * - Skip a new GET when the last successful response for the same scope is
 *   younger than the TTL, the auth/session scope is unchanged, and the list
 *   revision has not moved since that response completed.
 * - `forceRefresh: true`, session/generation change, or list-revision bump
 *   always require a fetch.
 * - A follow-up queued in `pendingLoadQuery` runs only when the completed
 *   in-flight scope did not already satisfy the merged pending query.
 */

/** TTL after a successful live-only index load. */
export const CHAT_LIST_LIVE_INDEX_FRESH_MS = 15_000;

/** TTL after a successful full index load (`includeArchived: true`). */
export const CHAT_LIST_FULL_INDEX_FRESH_MS = 30_000;

/**
 * @typedef {object} ChatListLoadQueryNormalized
 * @property {boolean} skipAutoSelect
 * @property {boolean} skipIfInFlight
 * @property {boolean} forceRefresh
 * @property {boolean} includeArchived
 * @property {string} preferChatId
 * @property {string} pinnedTo
 * @property {string} archiveWorkspace
 * @property {boolean} skipCache
 */

/**
 * @typedef {object} ChatListLoadSuccessSnapshot
 * @property {string} scopeKey
 * @property {number} completedAtMs
 * @property {string} sessionId
 * @property {number} generation
 * @property {number} listRevisionAtComplete
 */

/**
 * @param {object} [query]
 * @returns {ChatListLoadQueryNormalized}
 */
export function normalizeChatListLoadQuery(query = {}) {
  return {
    skipAutoSelect: query.skipAutoSelect === true,
    skipIfInFlight: query.skipIfInFlight === true,
    forceRefresh: query.forceRefresh === true,
    includeArchived: query.includeArchived === true,
    preferChatId: typeof query.preferChatId === 'string' ? query.preferChatId.trim() : '',
    pinnedTo: typeof query.pinnedTo === 'string' ? query.pinnedTo.trim() : '',
    archiveWorkspace: normalizeChatWorkspaceScopeForListLoad(
      typeof query.archiveWorkspace === 'string' ? query.archiveWorkspace : '',
    ),
    skipCache: query.skipCache === true,
  };
}

/**
 * Match server `normalizeChatWorkspaceScope` (lib/routes/chats-routes.js).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeChatWorkspaceScopeForListLoad(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

/**
 * @param {ChatListLoadQueryNormalized} normalized
 * @returns {string}
 */
export function buildChatListLoadScopeKey(normalized) {
  if (normalized.pinnedTo) return `pinned:${normalized.pinnedTo}`;
  if (normalized.includeArchived) {
    const workspaceKey = normalizeChatWorkspaceScopeForListLoad(normalized.archiveWorkspace);
    if (workspaceKey) return `full:${workspaceKey}`;
    return 'full';
  }
  return 'live';
}

/**
 * Wider scope wins when coalescing in-flight keys.
 *
 * @param {string | null | undefined} currentKey
 * @param {string} nextKey
 * @returns {string}
 */
export function mergeChatListInFlightScopeKey(currentKey, nextKey) {
  const current = typeof currentKey === 'string' ? currentKey : '';
  const next = typeof nextKey === 'string' ? nextKey : '';
  if (!current) return next;
  if (!next) return current;
  if (current.startsWith('pinned:') || next.startsWith('pinned:')) {
    return current === next ? current : next;
  }
  if (current === 'full' || next === 'full') return 'full';
  const currentScoped = current.startsWith('full:');
  const nextScoped = next.startsWith('full:');
  if (currentScoped && nextScoped) return current === next ? current : next;
  if (currentScoped || nextScoped) return currentScoped ? current : next;
  return 'live';
}

/**
 * @param {string} inFlightScopeKey
 * @param {ChatListLoadQueryNormalized} normalized
 * @returns {boolean}
 */
export function chatListInFlightScopeCoversQuery(inFlightScopeKey, normalized) {
  const needKey = buildChatListLoadScopeKey(normalized);
  if (inFlightScopeKey === needKey) return true;
  if (needKey === 'live' && (inFlightScopeKey === 'full' || inFlightScopeKey.startsWith('full:'))) {
    return true;
  }
  if (inFlightScopeKey === 'full' && needKey.startsWith('full:')) return true;
  return false;
}

/**
 * @param {string} completedScopeKey
 * @param {ChatListLoadQueryNormalized} normalized
 * @returns {boolean}
 */
export function chatListCompletedScopeCoversQuery(completedScopeKey, normalized) {
  return chatListInFlightScopeCoversQuery(completedScopeKey, normalized);
}

/**
 * @param {string} scopeKey
 * @returns {number}
 */
export function chatListFreshTtlMsForScopeKey(scopeKey) {
  if (scopeKey === 'full' || scopeKey.startsWith('full:')) return CHAT_LIST_FULL_INDEX_FRESH_MS;
  if (scopeKey.startsWith('pinned:')) return CHAT_LIST_LIVE_INDEX_FRESH_MS;
  return CHAT_LIST_LIVE_INDEX_FRESH_MS;
}

/**
 * @param {ChatListLoadSuccessSnapshot | null | undefined} snapshot
 * @param {{ sessionId?: string, generation?: number }} session
 * @param {number} listRevision
 * @returns {boolean}
 */
export function isChatListLoadSnapshotStale(snapshot, session, listRevision) {
  if (!snapshot) return true;
  const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : '';
  const generation = Number.isFinite(Number(session?.generation)) ? Math.floor(Number(session.generation)) : 0;
  if (snapshot.sessionId !== sessionId || snapshot.generation !== generation) return true;
  if (snapshot.listRevisionAtComplete !== listRevision) return true;
  return false;
}

/**
 * @param {{
 *   nowMs: number,
 *   normalized: ChatListLoadQueryNormalized,
 *   hasInFlight: boolean,
 *   inFlightScopeKey: string | null,
 *   lastSuccess: ChatListLoadSuccessSnapshot | null,
 *   session: { sessionId?: string, generation?: number },
 *   listRevision: number,
 * }} input
 * @returns {'fetch' | 'join-in-flight' | 'skip-fresh'}
 */
export function decideChatListNetworkLoad(input) {
  const normalized = input.normalized;
  if (normalized.forceRefresh) return 'fetch';
  const needKey = buildChatListLoadScopeKey(normalized);
  if (input.hasInFlight && input.inFlightScopeKey) {
    if (chatListInFlightScopeCoversQuery(input.inFlightScopeKey, normalized)) {
      return 'join-in-flight';
    }
  }
  if (normalized.skipIfInFlight && input.hasInFlight) {
    return 'join-in-flight';
  }
  const snapshot = input.lastSuccess;
  if (!isChatListLoadSnapshotStale(snapshot, input.session, input.listRevision)) {
    const freshScopeKey = snapshot.scopeKey;
    const covers = chatListCompletedScopeCoversQuery(freshScopeKey, normalized);
    if (covers) {
      const ttl = chatListFreshTtlMsForScopeKey(freshScopeKey);
      if (input.nowMs - snapshot.completedAtMs <= ttl) {
        return 'skip-fresh';
      }
    }
    if (needKey !== 'live' && freshScopeKey === 'live') {
      return 'fetch';
    }
  }
  return 'fetch';
}

/**
 * Drop a pending follow-up load when the request that just finished already
 * satisfied the merged pending query.
 *
 * @param {string | null | undefined} completedScopeKey
 * @param {object | null | undefined} pendingQuery
 * @returns {object | null}
 */
export function trimPendingChatListLoadQuery(completedScopeKey, pendingQuery) {
  if (!pendingQuery || typeof pendingQuery !== 'object') return null;
  const normalized = normalizeChatListLoadQuery(pendingQuery);
  if (normalized.forceRefresh) return pendingQuery;
  const scopeKey = typeof completedScopeKey === 'string' ? completedScopeKey : '';
  if (scopeKey && chatListCompletedScopeCoversQuery(scopeKey, normalized)) {
    return null;
  }
  return pendingQuery;
}

/**
 * Token captured before GET /api/chats; stale responses must not mutate RAM or freshness.
 *
 * @typedef {{ sessionId: string, generation: number, listRevision: number }} ChatListLoadApplyToken
 */

/**
 * @param {{ sessionId?: string, generation?: number }} session
 * @param {number} listRevision
 * @returns {ChatListLoadApplyToken}
 */
export function buildChatListLoadApplyToken(session, listRevision) {
  return {
    sessionId: typeof session?.sessionId === 'string' ? session.sessionId : '',
    generation: Number.isFinite(Number(session?.generation)) ? Math.floor(Number(session.generation)) : 0,
    listRevision: Number.isFinite(Number(listRevision)) ? Math.floor(Number(listRevision)) : 0,
  };
}

/**
 * @param {ChatListLoadApplyToken | null | undefined} token
 * @param {{ sessionId?: string, generation?: number }} session
 * @param {number} listRevision
 * @returns {boolean}
 */
export function isChatListLoadApplyTokenFresh(token, session, listRevision) {
  if (!token) return false;
  const current = buildChatListLoadApplyToken(session, listRevision);
  return token.sessionId === current.sessionId
    && token.generation === current.generation
    && token.listRevision === current.listRevision;
}

/**
 * @param {string} scopeKey
 * @param {number} completedAtMs
 * @param {{ sessionId?: string, generation?: number }} session
 * @param {number} listRevision
 * @returns {ChatListLoadSuccessSnapshot}
 */
export function buildChatListLoadSuccessSnapshot(scopeKey, completedAtMs, session, listRevision) {
  return {
    scopeKey,
    completedAtMs,
    sessionId: typeof session?.sessionId === 'string' ? session.sessionId : '',
    generation: Number.isFinite(Number(session?.generation)) ? Math.floor(Number(session.generation)) : 0,
    listRevisionAtComplete: listRevision,
  };
}
