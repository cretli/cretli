/**
 * Typed storage errors shared by the storage infrastructure (A2).
 *
 * Every storage outcome that is not a success maps to one stable `code`
 * (docs/storage-contract.md: explicit missing/corrupt/I/O/conflict outcomes).
 * Callers branch on `code` and `retryable`, never on message text.
 *
 * `toJSON()` is the only shape that may cross an API/WS/report boundary: it
 * carries the code, a fixed public message and a whitelisted `details` object.
 * Raw messages, causes and stack traces stay server-side because they can
 * contain absolute paths, SQL or secrets.
 */

/** Stable storage error codes. Values are part of the public contract. */
export const STORAGE_ERROR_CODES = Object.freeze({
  MISSING: 'missing',
  CORRUPT: 'corrupt',
  IO: 'io',
  CONFLICT: 'conflict',
  BUSY: 'busy',
  FULL_DISK: 'full_disk',
  UNSUPPORTED_RUNTIME: 'unsupported_runtime',
  UNKNOWN_COMMIT: 'unknown_commit',
});

/**
 * Per-code defaults. `retryable` means the same command may be retried as-is;
 * `unknown_commit` is not blindly retryable: the caller must reconcile through
 * the command receipt first, otherwise a retry may apply a mutation twice.
 */
const CODE_META = Object.freeze({
  missing: { retryable: false, publicMessage: 'Storage record or file is missing' },
  corrupt: { retryable: false, publicMessage: 'Storage data is corrupt' },
  io: { retryable: true, publicMessage: 'Storage I/O error' },
  conflict: { retryable: false, publicMessage: 'Storage revision conflict' },
  busy: { retryable: true, publicMessage: 'Storage is busy' },
  full_disk: { retryable: false, publicMessage: 'Storage disk is full' },
  unsupported_runtime: { retryable: false, publicMessage: 'Storage runtime is not supported' },
  unknown_commit: { retryable: false, publicMessage: 'Storage commit outcome is unknown' },
});

/** Detail keys allowed in serialized output; anything else is dropped. */
const SAFE_DETAIL_KEYS = Object.freeze([
  'storeId',
  'operation',
  'commandId',
  'expectedRevision',
  'actualRevision',
  'requiredNode',
  'actualNode',
  'requiredSqlite',
  'actualSqlite',
  'missingFeatures',
  // Extended SQLite result code (a number, never the native message) and the
  // constraint class derived from it; see lib/storage/sqlite-errors.js.
  'sqliteCode',
  'constraintKind',
  // Worker protocol: whether a failed request is known not to have committed
  // ('not_committed') or its COMMIT outcome is unknown ('unknown').
  'commitState',
  // Command receipts (S4): which kind of `conflict` this is, e.g.
  // 'receipt_digest_mismatch' (commandId reused with another payload).
  'conflictKind',
  // Command receipts (S4): `false` when an `unknown_commit` cannot be
  // reconciled through the receipt (the mutation may be durable without
  // one); the caller must escalate, never retry (lib/storage/receipts.md).
  'reconcilable',
]);

const SAFE_SCALAR_TYPES = new Set(['string', 'number', 'boolean']);
const MAX_DETAIL_STRING = 200;

/**
 * @param {unknown} code
 * @returns {code is string}
 */
export function isStorageErrorCode(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_META, code);
}

/**
 * Keep only whitelisted, scalar (or array-of-scalar) detail values and drop
 * anything that looks like a filesystem path.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeDetailValue(value) {
  if (value === null) return null;
  if (Array.isArray(value)) {
    // Arrays are scalar-only: nested arrays are dropped, not flattened.
    return value
      .map((item) => (Array.isArray(item) ? undefined : sanitizeDetailValue(item)))
      .filter((item) => item !== undefined);
  }
  if (!SAFE_SCALAR_TYPES.has(typeof value)) return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  if (typeof value !== 'string') return value;
  if (/[\\/]/.test(value)) return undefined;
  return value.length > MAX_DETAIL_STRING ? value.slice(0, MAX_DETAIL_STRING) : value;
}

/**
 * @param {unknown} details
 * @returns {Record<string, unknown>}
 */
function sanitizeDetails(details) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!details || typeof details !== 'object') return out;
  for (const key of SAFE_DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) continue;
    const value = sanitizeDetailValue(/** @type {Record<string, unknown>} */ (details)[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export class StorageError extends Error {
  /**
   * @param {string} code One of STORAGE_ERROR_CODES.
   * @param {string} [message] Server-side message (may be detailed; never serialized).
   * @param {{ cause?: unknown, retryable?: boolean, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    if (!isStorageErrorCode(code)) {
      throw new TypeError(`Unknown storage error code: ${String(code)}`);
    }
    const meta = CODE_META[code];
    super(message || meta.publicMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
    /** @type {string} */
    this.code = code;
    /** @type {boolean} */
    this.retryable = typeof options.retryable === 'boolean' ? options.retryable : meta.retryable;
    /** @type {Record<string, unknown>} */
    this.details = sanitizeDetails(options.details);
  }

  /**
   * Safe serialization: no raw message, cause or stack (paths/secrets).
   *
   * @returns {{ name: 'StorageError', code: string, message: string, retryable: boolean, details: Record<string, unknown> }}
   */
  toJSON() {
    return {
      name: 'StorageError',
      code: this.code,
      message: CODE_META[this.code].publicMessage,
      retryable: this.retryable,
      details: { ...this.details },
    };
  }
}

/**
 * True for a StorageError instance or a plain object with the known
 * `name: 'StorageError'` + valid `code` shape (e.g. after postMessage).
 *
 * @param {unknown} err
 * @returns {err is StorageError}
 */
export function isStorageError(err) {
  if (err instanceof StorageError) return true;
  return Boolean(err) && typeof err === 'object'
    && /** @type {any} */ (err).name === 'StorageError'
    && isStorageErrorCode(/** @type {any} */ (err).code);
}

/**
 * Revive a StorageError from its `toJSON()` shape (worker protocol). Returns
 * null for anything that is not a valid serialized StorageError. Details go
 * through the same whitelist again; the message is the fixed public one.
 *
 * @param {unknown} json
 * @returns {StorageError | null}
 */
export function fromJSON(json) {
  if (!json || typeof json !== 'object') return null;
  const raw = /** @type {Record<string, unknown>} */ (json);
  if (raw.name !== 'StorageError' || !isStorageErrorCode(raw.code)) return null;
  return new StorageError(/** @type {string} */ (raw.code), undefined, {
    retryable: typeof raw.retryable === 'boolean' ? raw.retryable : undefined,
    details: /** @type {Record<string, unknown>} */ (raw.details),
  });
}
