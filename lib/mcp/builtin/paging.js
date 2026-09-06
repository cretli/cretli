/**
 * Offset cursors for builtin MCP lists.
 */

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
export const DETAIL_PAGE_CHARS = 4000;

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function clampListLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.floor(value));
}

/**
 * @param {unknown} cursor
 * @returns {number}
 */
export function decodeListCursor(cursor) {
  const raw = String(cursor || '').trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

/**
 * @param {unknown[]} items
 * @param {{ limit?: unknown, cursor?: unknown }} query
 */
export function paginateList(items, query = {}) {
  const rows = Array.isArray(items) ? items : [];
  const limit = clampListLimit(query.limit);
  const offset = decodeListCursor(query.cursor);
  const slice = rows.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    next_cursor: nextOffset < rows.length ? String(nextOffset) : '',
  };
}

/**
 * @param {unknown} cursor
 * @returns {{ revision: string, field: string, offset: number }}
 */
export function parseDetailCursor(cursor) {
  const raw = String(cursor || '').trim();
  if (!raw) return { revision: '', field: '', offset: 0 };
  const parts = raw.split(':');
  if (parts.length < 3) {
    const err = new Error('Invalid detail cursor');
    err.code = 'VALIDATION';
    throw err;
  }
  const offset = Number(parts[parts.length - 1]);
  const field = String(parts[parts.length - 2] || '');
  const revision = parts.slice(0, -2).join(':');
  if (!Number.isInteger(offset) || offset < 0 || !field) {
    const err = new Error('Invalid detail cursor');
    err.code = 'VALIDATION';
    throw err;
  }
  return { revision, field, offset };
}

/**
 * @param {{ revision?: unknown, field?: unknown, offset?: unknown }} input
 */
export function encodeDetailCursor(input) {
  return `${String(input.revision ?? '')}:${String(input.field || 'body')}:${Number(input.offset) || 0}`;
}

/**
 * Page a long markdown/report string. Cursor is bound to revision + field.
 *
 * @param {unknown} text
 * @param {{ cursor?: unknown, revision?: unknown, field?: unknown }} query
 */
export function paginateDetail(text, query = {}) {
  const full = String(text || '');
  const field = String(query.field || 'body');
  const revision = String(query.revision ?? '');
  const cursor = String(query.cursor || '').trim();
  const parsed = parseDetailCursor(cursor);
  if (cursor && (parsed.revision !== revision || parsed.field !== field)) {
    const err = new Error('Detail cursor does not match the current revision');
    err.code = 'CONFLICT';
    throw err;
  }
  const offset = cursor ? parsed.offset : 0;
  const slice = full.slice(offset, offset + DETAIL_PAGE_CHARS);
  const next = offset + slice.length;
  const truncated = next < full.length;
  return {
    text: slice,
    truncated,
    next_cursor: truncated ? encodeDetailCursor({ revision, field, offset: next }) : '',
  };
}
