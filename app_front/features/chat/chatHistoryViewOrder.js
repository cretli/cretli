/**
 * Chronological insert position for a recovered history card.
 * historySeq is durable conversation order for the same chat. roomEventSeq is
 * live stream order and is comparable only inside a proven eventStreamId.
 * The two namespaces are never mixed. A missing stream id must not invent a
 * global room-seq order.
 */

/**
 * @param {unknown} source
 * @returns {string}
 */
export function resolveEventStreamId(source) {
  if (typeof source === 'string') return source.trim();
  if (!source || typeof source !== 'object') return '';
  const id = /** @type {Record<string, unknown>} */ (source).eventStreamId;
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * @param {unknown} source
 * @returns {{ historySeq: number, roomEventSeq: number, eventStreamId: string }}
 */
export function resolveViewOrderKey(source) {
  if (!source || typeof source !== 'object') {
    return { historySeq: 0, roomEventSeq: 0, eventStreamId: '' };
  }
  const rec = /** @type {Record<string, unknown>} */ (source);
  const historySeq = Number(rec.historySeq);
  const roomEventSeq = Number(rec.roomEventSeq);
  return {
    historySeq: Number.isSafeInteger(historySeq) && historySeq > 0 ? historySeq : 0,
    roomEventSeq: Number.isSafeInteger(roomEventSeq) && roomEventSeq > 0 ? roomEventSeq : 0,
    eventStreamId: resolveEventStreamId(rec),
  };
}

/**
 * @param {{ historySeq?: number, roomEventSeq?: number }} key
 * @returns {boolean}
 */
export function hasViewOrderKey(key) {
  const historySeq = Number(key?.historySeq) || 0;
  const roomEventSeq = Number(key?.roomEventSeq) || 0;
  return historySeq > 0 || roomEventSeq > 0;
}

/**
 * Negative when `left` belongs before `right`. Zero means equal or incomparable
 * — incomparable keys must not jump in front of a later card.
 *
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} left
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} right
 * @returns {number}
 */
export function compareViewOrderKeys(left, right) {
  const leftHistory = Number(left?.historySeq) || 0;
  const rightHistory = Number(right?.historySeq) || 0;
  if (leftHistory > 0 && rightHistory > 0) return leftHistory - rightHistory;
  const leftStream = resolveEventStreamId(left);
  const rightStream = resolveEventStreamId(right);
  if (!leftStream || !rightStream || leftStream !== rightStream) return 0;
  const leftRoom = Number(left?.roomEventSeq) || 0;
  const rightRoom = Number(right?.roomEventSeq) || 0;
  if (leftRoom > 0 && rightRoom > 0) return leftRoom - rightRoom;
  return 0;
}

/**
 * Index of the first existing card that should sit after `incomingKey`.
 *
 * @param {Array<{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }>} existingKeys
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} incomingKey
 * @returns {number}
 */
export function findViewInsertIndex(existingKeys, incomingKey) {
  const keys = Array.isArray(existingKeys) ? existingKeys : [];
  if (!hasViewOrderKey(incomingKey)) return keys.length;
  for (let i = 0; i < keys.length; i += 1) {
    if (compareViewOrderKeys(incomingKey, keys[i]) < 0) return i;
  }
  return keys.length;
}

/**
 * Splices `record` into `nodes` by durable/stream order. Unknown keys append.
 *
 * @param {unknown[]} nodes
 * @param {unknown} record
 * @returns {number} insert index
 */
export function insertRecordByViewOrder(nodes, record) {
  if (!Array.isArray(nodes)) return -1;
  const index = findViewInsertIndex(
    nodes.map((row) => resolveViewOrderKey(row)),
    resolveViewOrderKey(record)
  );
  nodes.splice(index, 0, record);
  return index;
}
