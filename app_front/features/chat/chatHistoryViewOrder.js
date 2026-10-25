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
 * True when both keys name the same already-rendered card.
 * compareViewOrderKeys returns 0 for incomparable keys as well, so equality
 * must not use that helper.
 *
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} left
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} right
 * @returns {boolean}
 */
export function isSameViewOrderKey(left, right) {
  const leftHistory = Number(left?.historySeq) || 0;
  const rightHistory = Number(right?.historySeq) || 0;
  if (leftHistory > 0 && rightHistory > 0) return leftHistory === rightHistory;
  const leftStream = resolveEventStreamId(left);
  const rightStream = resolveEventStreamId(right);
  if (!leftStream || !rightStream || leftStream !== rightStream) return false;
  const leftRoom = Number(left?.roomEventSeq) || 0;
  const rightRoom = Number(right?.roomEventSeq) || 0;
  if (leftRoom <= 0 || rightRoom <= 0) return false;
  return leftRoom === rightRoom;
}

/**
 * @param {Array<{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }>} existingKeys
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} incomingKey
 * @returns {number}
 */
export function findExistingViewOrderIndex(existingKeys, incomingKey) {
  if (!hasViewOrderKey(incomingKey)) return -1;
  const keys = Array.isArray(existingKeys) ? existingKeys : [];
  for (let i = 0; i < keys.length; i += 1) {
    if (isSameViewOrderKey(incomingKey, keys[i])) return i;
  }
  return -1;
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
 * @param {unknown} source
 * @returns {string}
 */
function readViewCardCreatedAt(source) {
  if (!source || typeof source !== 'object') return '';
  const createdAt = /** @type {{ createdAt?: unknown }} */ (source).createdAt;
  return typeof createdAt === 'string' ? createdAt.trim() : '';
}

/**
 * True when `incoming` must be inserted before `existing`.
 * Seq order wins inside one stream. Cards from different streams stay
 * incomparable by seq, so an older createdAt still belongs above a later tail
 * (the opening user prompt must not stick under the answers).
 *
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string, createdAt?: string }} incoming
 * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string, createdAt?: string }} existing
 * @returns {boolean}
 */
export function shouldPlaceViewCardBefore(incoming, existing) {
  if (compareViewOrderKeys(incoming, existing) < 0) return true;
  if (isSameViewOrderKey(incoming, existing)) return false;
  if (!hasViewOrderKey(incoming) || !hasViewOrderKey(existing)) return false;
  if (compareViewOrderKeys(incoming, existing) !== 0) return false;
  const incomingAt = readViewCardCreatedAt(incoming);
  const existingAt = readViewCardCreatedAt(existing);
  if (!incomingAt || !existingAt || incomingAt === existingAt) return false;
  const incomingHistory = Number(incoming?.historySeq) || 0;
  const existingHistory = Number(existing?.historySeq) || 0;
  const existingRoom = Number(existing?.roomEventSeq) || 0;
  if (incomingHistory > 0 && existingHistory <= 0 && existingRoom > 0 && existingAt > incomingAt) {
    const existingMs = Date.parse(existingAt);
    if (Number.isFinite(existingMs) && Math.abs(Date.now() - existingMs) < 10 * 60 * 1000) {
      return false;
    }
  }
  return incomingAt < existingAt;
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
  const incomingKey = resolveViewOrderKey(record);
  const existingKeys = nodes.map((row) => resolveViewOrderKey(row));
  const existingIndex = findExistingViewOrderIndex(existingKeys, incomingKey);
  if (existingIndex >= 0) return existingIndex;
  const index = findViewInsertIndex(existingKeys, incomingKey);
  nodes.splice(index, 0, record);
  return index;
}

/**
 * Stable identity for already-rendered cards. historySeq wins; otherwise
 * stream + room seq. Empty when the card cannot be matched.
 *
 * @param {unknown} source
 * @returns {string}
 */
export function viewOrderIdentity(source) {
  const key = resolveViewOrderKey(source);
  if (key.historySeq > 0) return `h:${key.historySeq}`;
  if (key.eventStreamId && key.roomEventSeq > 0) {
    return `r:${key.eventStreamId}:${key.roomEventSeq}`;
  }
  return '';
}

/**
 * Drops later copies of the same card. Live + catch-up can leave two
 * Answer nodes with the same seq already in the stream.
 *
 * @param {unknown[]} nodes
 * @returns {unknown[]}
 */
export function foldDuplicateViewOrderNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 2) return nodes;
  const seen = new Set();
  let write = 0;
  for (let read = 0; read < nodes.length; read += 1) {
    const node = nodes[read];
    const id = viewOrderIdentity(node);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    nodes[write] = node;
    write += 1;
  }
  nodes.length = write;
  return nodes;
}
