/**
 * Optional `ids=id1,id2` query for chat list HTTP polls.
 * Node's default max HTTP header size is 16 KiB (431 when exceeded).
 * A long comma-separated UUID list plus cookies blows that budget.
 */

/** Soft cap for the unencoded `id,id,...` value. Empty query means "all allowed". */
export const MAX_CHAT_IDS_QUERY_LENGTH = 2048;

/** Max chats in one POST /api/chats/history-batch body. Empty list is invalid, not "all". */
export const MAX_CHAT_HISTORY_BATCH = 32;

/** Max chat ids in one POST /api/chats/history-revisions-batch body. */
export const MAX_CHAT_REVISIONS_BATCH = 32;

/** Max sequential GET/POST parts when merging one explicit revision fetch. */
export const MAX_CHAT_REVISIONS_FETCH_PARTS = 32;

/**
 * @param {unknown} [chatIds]
 * @returns {string[]}
 */
export function normalizeExplicitChatIds(chatIds = []) {
  if (!Array.isArray(chatIds)) return [];
  return chatIds.map((id) => String(id || '').trim()).filter(Boolean);
}

/**
 * @param {unknown} [chatIds]
 * @returns {boolean}
 */
export function fitsChatIdsQuery(chatIds = []) {
  const normalized = normalizeExplicitChatIds(chatIds);
  if (normalized.length === 0) return true;
  return normalized.join(',').length <= MAX_CHAT_IDS_QUERY_LENGTH;
}

/**
 * Split an explicit id list into bounded chunks for revision HTTP.
 *
 * @param {unknown} [chatIds]
 * @param {number} [maxChunkSize]
 * @returns {string[][]}
 */
export function chunkExplicitChatIds(chatIds = [], maxChunkSize = MAX_CHAT_REVISIONS_BATCH) {
  const normalized = normalizeExplicitChatIds(chatIds);
  if (normalized.length === 0) return [];
  const size = Math.max(1, Number(maxChunkSize) || MAX_CHAT_REVISIONS_BATCH);
  /** @type {string[][]} */
  const chunks = [];
  for (let offset = 0; offset < normalized.length; offset += size) {
    chunks.push(normalized.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Explicit revisions-batch body. Returns null when there are no valid ids.
 *
 * @param {unknown} [chatIds]
 * @returns {{ ids: string[] } | null}
 */
export function buildChatHistoryRevisionsBatchBody(chatIds = []) {
  const normalized = normalizeExplicitChatIds(chatIds);
  if (normalized.length === 0) return null;
  return { ids: normalized.slice(0, MAX_CHAT_REVISIONS_BATCH) };
}

/**
 * Explicit history-batch body. Returns null when there are no valid ids
 * (caller must not POST — missing ids must never mean every chat).
 *
 * @param {Array<{ id?: unknown, since?: unknown, limit?: unknown }>} [requests]
 * @returns {{ chats: Array<{ id: string, since: number, limit?: number }> } | null}
 */
export function buildChatHistoryBatchBody(requests = []) {
  if (!Array.isArray(requests) || requests.length === 0) return null;
  const chats = [];
  for (const row of requests) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    const sinceRaw = Number(row?.since);
    const since = Number.isFinite(sinceRaw) ? Math.max(0, sinceRaw) : 0;
    /** @type {{ id: string, since: number, limit?: number }} */
    const item = { id, since };
    if (row?.limit != null) {
      const limitRaw = Number(row.limit);
      if (Number.isFinite(limitRaw)) item.limit = Math.max(1, limitRaw);
    }
    chats.push(item);
    if (chats.length >= MAX_CHAT_HISTORY_BATCH) break;
  }
  if (chats.length === 0) return null;
  return { chats };
}

/**
 * @param {unknown} [chatIds]
 * @returns {string} `ids=...` or empty
 */
export function buildChatIdsQuery(chatIds = []) {
  const normalized = normalizeExplicitChatIds(chatIds);
  if (normalized.length === 0) return '';
  const joined = normalized.join(',');
  if (joined.length > MAX_CHAT_IDS_QUERY_LENGTH) return null;
  return new URLSearchParams({ ids: joined }).toString();
}
