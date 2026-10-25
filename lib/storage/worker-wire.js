/**
 * Wire format shared by the storage worker host and the worker thread (A2 S3,
 * protocol: lib/storage/worker-protocol.md).
 *
 * Payloads and results cross the thread boundary as JSON text produced once by
 * `toWireJson()`. The text is the snapshot: later mutation of the caller's
 * object cannot change what the worker commits, and its UTF-8 length is the
 * exact byte cost charged to the queue budget.
 */

/** Handler names: short identifiers, never SQL. */
export const HANDLER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/**
 * Caller idempotency ids. No path separators, so the id always survives the
 * StorageError detail sanitizer and reaches the caller.
 */
export const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Control operations the worker implements itself (no handler). */
export const CONTROL_OPS = Object.freeze(new Set(['ping', 'checkpoint', 'fence']));

/** Fixed name of a group-commit batch request (kind `batch`, S5). */
export const BATCH_REQUEST_NAME = 'batch';

/**
 * JSON replacer that refuses values JSON would silently drop or flatten
 * (functions, symbols, Map/Set/typed arrays become `{}` or vanish). BigInt and
 * cycles already throw inside JSON.stringify.
 *
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function strictReplacer(_key, value) {
  const type = typeof value;
  if (type === 'function' || type === 'symbol') throw new TypeError(`Storage JSON cannot carry a ${type}`);
  if (value instanceof Map || value instanceof Set || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError('Storage JSON cannot carry Map, Set or binary values');
  }
  return value;
}

/**
 * Serialize a payload/result to wire JSON. `undefined` becomes `null`.
 * Throws a TypeError for anything that is not plain JSON data.
 *
 * @param {unknown} value
 * @returns {{ json: string, bytes: number }}
 */
export function toWireJson(value) {
  const json = JSON.stringify(value === undefined ? null : value, strictReplacer);
  if (typeof json !== 'string') throw new TypeError('Storage JSON value is not serializable');
  return { json, bytes: Buffer.byteLength(json) };
}
