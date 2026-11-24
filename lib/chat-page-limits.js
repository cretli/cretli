/** Shared row ceiling for catalog, SQLite and legacy chat pages. */
export const CHAT_PAGE_MAX_LIMIT = 100;
export const CHAT_PAGE_MAX_BYTES = 128 * 1024;
export const CHAT_PAGE_TRUNCATED_TITLE_LENGTH = 256;

/**
 * Preserve identity and scope when an individual row cannot fit. Full data stays
 * available from the single-chat endpoint. Identity is never silently clipped.
 * @param {Record<string, any>} row
 */
function reduceRow(row) {
  const reduced = {};
  for (const key of ['id', 'createdAt', 'updatedAt', 'archivedAt', 'workspaceFolder', 'workspaceFile']) {
    if (row[key] !== undefined) reduced[key] = row[key];
  }
  if (typeof row.title === 'string') reduced.title = row.title.slice(0, CHAT_PAGE_TRUNCATED_TITLE_LENGTH);
  return { ...reduced, truncated: true };
}

/**
 * Bound the complete wire body, including metadata and the continuation cursor.
 * The caller derives cursors from the catalog's original keys, never a reduced row.
 * @param {Record<string, any>} body
 * @param {(count: number) => string | null} cursorForCount
 * @returns {Record<string, any>}
 */
export function boundChatPage(body, cursorForCount) {
  const fits = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= CHAT_PAGE_MAX_BYTES;
  if (fits(body)) return body;
  const rows = body.chats;
  const candidate = (count) => ({ ...body, nextCursor: cursorForCount(count), chats: rows.slice(0, count) });
  // Binary search keeps serialization bounded even with a hundred large rows.
  let low = 1;
  let high = rows.length;
  let best = null;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const page = candidate(count);
    if (fits(page)) { best = page; low = count + 1; }
    else high = count - 1;
  }
  if (best) return best;
  if (rows.length) {
    const reduced = { ...candidate(1), chats: [reduceRow(rows[0])] };
    if (fits(reduced)) return reduced;
  }
  // Malformed identity fields or unbounded metadata must not break the wire cap.
  throw Object.assign(new Error('Chat page identity or metadata exceeds the byte limit'), { code: 'CHAT_PAGE_TOO_LARGE' });
}
