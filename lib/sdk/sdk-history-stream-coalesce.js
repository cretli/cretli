/**
 * Coalesce consecutive assistant/thinking SDK history records into one snapshot.
 * DeepSeek (and similar) persist every token as its own event; after a tail-page
 * reload those fragments render as separate Answer blocks.
 */

/**
 * @param {unknown} rec
 * @returns {Record<string, unknown> | null}
 */
function asRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  return /** @type {Record<string, unknown>} */ (rec);
}

/**
 * @param {unknown} rec
 * @returns {'assistant' | 'thinking' | ''}
 */
export function readSdkHistoryStreamKind(rec) {
  const row = asRecord(rec);
  if (!row || row.kind !== 'sdk') return '';
  const event = asRecord(row.event);
  if (!event) return '';
  const type = typeof event.type === 'string' ? event.type.toLowerCase() : '';
  if (type === 'assistant' || type === 'thinking') return type;
  return '';
}

/**
 * @param {unknown} rec
 * @returns {string}
 */
export function readSdkHistoryStreamText(rec) {
  const kind = readSdkHistoryStreamKind(rec);
  const row = asRecord(rec);
  const event = row ? asRecord(row.event) : null;
  if (!kind || !event) return '';
  if (kind === 'thinking') {
    return typeof event.text === 'string' ? event.text : '';
  }
  const message = asRecord(event.message);
  const content = message && Array.isArray(message.content) ? message.content : [];
  let out = '';
  for (const block of content) {
    const item = asRecord(block);
    if (item && item.type === 'text' && typeof item.text === 'string') out += item.text;
  }
  return out;
}

/**
 * @param {string} prev
 * @param {string} next
 * @returns {string}
 */
export function mergeSdkHistoryStreamText(prev, next) {
  const previous = String(prev || '');
  const incoming = String(next || '');
  if (!previous) return incoming;
  if (!incoming) return previous;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming) && incoming.length < previous.length) return previous;
  return previous + incoming;
}

/**
 * @param {Record<string, unknown>} rec
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function withSdkHistoryStreamText(rec, text) {
  const event = asRecord(rec.event) || {};
  const kind = readSdkHistoryStreamKind(rec);
  if (kind === 'thinking') {
    return { ...rec, event: { ...event, type: 'thinking', text } };
  }
  const message = asRecord(event.message) || {};
  return {
    ...rec,
    event: {
      ...event,
      type: 'assistant',
      message: {
        ...message,
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    },
  };
}

/**
 * @param {Array<{ rec?: unknown, clientSeq?: number }>} items
 * @returns {Array<{ rec: unknown, clientSeq?: number }>}
 */
export function coalesceSdkHistoryItems(items) {
  const list = Array.isArray(items) ? items : [];
  /** @type {Array<{ rec: Record<string, unknown>, clientSeq?: number }>} */
  const out = [];
  for (const item of list) {
    const rec = asRecord(item?.rec);
    if (!rec) continue;
    const kind = readSdkHistoryStreamKind(rec);
    const prev = out[out.length - 1];
    const prevKind = prev ? readSdkHistoryStreamKind(prev.rec) : '';
    if (!kind || kind !== prevKind) {
      out.push({ ...item, rec });
      continue;
    }
    const mergedText = mergeSdkHistoryStreamText(
      readSdkHistoryStreamText(prev.rec),
      readSdkHistoryStreamText(rec),
    );
    prev.rec = withSdkHistoryStreamText(prev.rec, mergedText);
  }
  return out;
}

/**
 * Walks an event pool backward so a tail page does not start mid-assistant/thinking stream.
 *
 * @param {Array<{ seq: number, rec: unknown }>} pool
 * @param {Array<{ seq: number, rec: unknown }>} slice
 * @param {number} maxLen
 * @returns {Array<{ seq: number, rec: unknown }>}
 */
export function extendHistorySliceToStreamBoundary(pool, slice, maxLen) {
  if (!Array.isArray(pool) || pool.length === 0) return Array.isArray(slice) ? slice : [];
  if (!Array.isArray(slice) || slice.length === 0) return slice;
  const startIdx = pool.length - slice.length;
  if (startIdx < 0) return slice;
  const kind = readSdkHistoryStreamKind(pool[startIdx]?.rec);
  if (!kind) return slice;
  const cap = Math.max(slice.length, Number(maxLen) || slice.length);
  let idx = startIdx;
  while (idx > 0 && pool.length - (idx - 1) <= cap) {
    if (readSdkHistoryStreamKind(pool[idx - 1]?.rec) !== kind) break;
    idx -= 1;
  }
  return pool.slice(idx);
}
