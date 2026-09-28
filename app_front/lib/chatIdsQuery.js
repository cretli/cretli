/**
 * Optional `ids=id1,id2` query for chat list HTTP polls.
 * Node's default max HTTP header size is 16 KiB (431 when exceeded).
 * A long comma-separated UUID list plus cookies blows that budget.
 */

/** Soft cap for the unencoded `id,id,...` value. Empty query means "all allowed". */
export const MAX_CHAT_IDS_QUERY_LENGTH = 2048;

/** Max chats in one POST /api/chats/history-batch body. Empty list is invalid, not "all". */
export const MAX_CHAT_HISTORY_BATCH = 32;

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
  if (!Array.isArray(chatIds) || chatIds.length === 0) return '';
  const joined = chatIds
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .join(',');
  if (!joined || joined.length > MAX_CHAT_IDS_QUERY_LENGTH) return '';
  return new URLSearchParams({ ids: joined }).toString();
}
