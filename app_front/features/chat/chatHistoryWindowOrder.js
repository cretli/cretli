/**
 * Keeps the rendered SDK history window chronological.
 *
 * Incremental catch-up keys off per-stream watermarks. After a room change the
 * leftover events from the previous stream look "missing" — appending them
 * puts last night's turns below tonight's. Those records belong above the
 * current window (or in a full replay), not at the tail.
 */

/**
 * @param {unknown} record
 * @returns {string}
 */
export function readRecordCreatedAt(record) {
  if (!record || typeof record !== 'object') return '';
  const createdAt = /** @type {{ createdAt?: unknown }} */ (record).createdAt;
  return typeof createdAt === 'string' ? createdAt : '';
}

/**
 * @param {unknown[]} records
 * @returns {string}
 */
export function readOldestCreatedAt(records) {
  if (!Array.isArray(records)) return '';
  let oldest = '';
  for (const record of records) {
    const createdAt = readRecordCreatedAt(record);
    if (!createdAt) continue;
    if (!oldest || createdAt < oldest) oldest = createdAt;
  }
  return oldest;
}

/**
 * Marks the oldest timestamp currently shown. Replay replaces it; prepend only
 * moves it backward.
 *
 * @param {object | null | undefined} chat
 * @param {unknown[]} records
 * @param {{ reset?: boolean }} [options]
 * @returns {void}
 */
export function rememberHistoryWindowStart(chat, records, options = {}) {
  if (!chat || typeof chat !== 'object') return;
  const oldest = readOldestCreatedAt(records);
  if (options.reset === true) {
    chat._historyWindowOldestAt = oldest;
    return;
  }
  if (!oldest) return;
  const current =
    typeof chat._historyWindowOldestAt === 'string' ? chat._historyWindowOldestAt : '';
  if (!current || oldest < current) chat._historyWindowOldestAt = oldest;
}

/**
 * @param {unknown[]} records
 * @param {string} [windowOldestAt]
 * @returns {{ older: unknown[], newer: unknown[] }}
 */
export function partitionRecordsByWindowStart(records, windowOldestAt = '') {
  if (!Array.isArray(records) || records.length === 0) {
    return { older: [], newer: [] };
  }
  if (!windowOldestAt) return { older: [], newer: records.slice() };
  /** @type {unknown[]} */
  const older = [];
  /** @type {unknown[]} */
  const newer = [];
  for (const record of records) {
    const createdAt = readRecordCreatedAt(record);
    if (createdAt && createdAt < windowOldestAt) older.push(record);
    else newer.push(record);
  }
  return { older, newer };
}

/**
 * Stable sort so a corrupted local cache (recent session stored before an older
 * one) still replays oldest-to-newest. Records without createdAt keep their
 * relative position.
 *
 * @param {unknown[]} records
 * @returns {unknown[]}
 */
export function sortRecordsByCreatedAt(records) {
  if (!Array.isArray(records)) return [];
  if (records.length < 2) return records.slice();
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftAt = readRecordCreatedAt(left.record);
      const rightAt = readRecordCreatedAt(right.record);
      if (leftAt && rightAt && leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
      return left.index - right.index;
    })
    .map((item) => item.record);
}
