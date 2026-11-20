/**
 * Map native `node:sqlite` and filesystem errors to typed StorageError codes
 * (A2, docs/storage-contract.md explicit missing/corrupt/I/O/conflict outcomes).
 *
 * `node:sqlite` throws `ERR_SQLITE_ERROR` with `errcode` holding the (possibly
 * extended) SQLite result code; the primary code is its low byte.
 *
 * `retryable` is true only for transient classes (lock contention and real
 * I/O failures). Deterministic failures (SQL errors, misuse, constraint
 * violations, read-only/permission problems, migration code that threw, and
 * anything unrecognised) are `retryable: false`: retrying the same command
 * would fail the same way.
 */
import { fromJSON, StorageError, STORAGE_ERROR_CODES } from './errors.js';

/** Primary SQLite result codes this module distinguishes. */
export const SQLITE_PRIMARY_CODES = Object.freeze({
  ERROR: 1,
  BUSY: 5,
  LOCKED: 6,
  NOMEM: 7,
  READONLY: 8,
  IOERR: 10,
  CORRUPT: 11,
  FULL: 13,
  CANTOPEN: 14,
  CONSTRAINT: 19,
  MISUSE: 21,
  NOTADB: 26,
});

/** Extended SQLITE_CONSTRAINT_* codes mapped to a stable constraint kind. */
export const SQLITE_CONSTRAINT_KINDS = Object.freeze({
  275: 'check',
  787: 'foreign_key',
  1299: 'not_null',
  1555: 'primary_key',
  2067: 'unique',
  3091: 'datatype',
});

/**
 * Primary code -> [storage code, retryable]. A missing entry (SQLITE_ERROR,
 * SQLITE_MISUSE, unknown codes) is a deterministic `io` failure.
 */
const PRIMARY_TO_STORAGE = Object.freeze({
  [SQLITE_PRIMARY_CODES.BUSY]: [STORAGE_ERROR_CODES.BUSY, true],
  [SQLITE_PRIMARY_CODES.LOCKED]: [STORAGE_ERROR_CODES.BUSY, true],
  [SQLITE_PRIMARY_CODES.NOMEM]: [STORAGE_ERROR_CODES.IO, true],
  [SQLITE_PRIMARY_CODES.READONLY]: [STORAGE_ERROR_CODES.IO, false],
  [SQLITE_PRIMARY_CODES.IOERR]: [STORAGE_ERROR_CODES.IO, true],
  [SQLITE_PRIMARY_CODES.CORRUPT]: [STORAGE_ERROR_CODES.CORRUPT, false],
  [SQLITE_PRIMARY_CODES.FULL]: [STORAGE_ERROR_CODES.FULL_DISK, false],
  // CANTOPEN is usually a path/permission problem (directory, missing parent),
  // which a retry does not fix.
  [SQLITE_PRIMARY_CODES.CANTOPEN]: [STORAGE_ERROR_CODES.IO, false],
  // The store has no dedicated validation code, so every constraint violation
  // is `conflict` (never retryable) and `details.constraintKind` tells a
  // PK/UNIQUE collision (a committed row already owns the key) apart from a
  // malformed write (check/not_null/foreign_key/datatype).
  [SQLITE_PRIMARY_CODES.CONSTRAINT]: [STORAGE_ERROR_CODES.CONFLICT, false],
  [SQLITE_PRIMARY_CODES.NOTADB]: [STORAGE_ERROR_CODES.CORRUPT, false],
});

const ERRNO_TO_STORAGE = Object.freeze({
  ENOENT: [STORAGE_ERROR_CODES.MISSING, false],
  ENOTDIR: [STORAGE_ERROR_CODES.MISSING, false],
  ENOSPC: [STORAGE_ERROR_CODES.FULL_DISK, false],
  EDQUOT: [STORAGE_ERROR_CODES.FULL_DISK, false],
  EBUSY: [STORAGE_ERROR_CODES.BUSY, true],
  EIO: [STORAGE_ERROR_CODES.IO, true],
  EAGAIN: [STORAGE_ERROR_CODES.IO, true],
  EMFILE: [STORAGE_ERROR_CODES.IO, true],
  ENFILE: [STORAGE_ERROR_CODES.IO, true],
});

/**
 * Primary SQLite result code of a `node:sqlite` error, or null.
 *
 * @param {unknown} err
 * @returns {number | null}
 */
export function sqlitePrimaryCode(err) {
  const code = sqliteExtendedCode(err);
  return code === null ? null : code & 0xff;
}

/**
 * Full (extended) SQLite result code of a `node:sqlite` error, or null.
 *
 * @param {unknown} err
 * @returns {number | null}
 */
export function sqliteExtendedCode(err) {
  const errcode = /** @type {any} */ (err)?.errcode;
  if (!Number.isInteger(errcode) || errcode < 0) return null;
  return errcode;
}

/**
 * Convert any error thrown by SQLite or the filesystem into a StorageError.
 * An existing StorageError passes through unchanged. Unknown failures become
 * non-retryable `io`: the operation did not produce a trustworthy result.
 *
 * A PK/UNIQUE `conflict` only says "the key is taken". The receipt API (S4)
 * must decide same-commandId/same-digest (replay) versus different digest
 * (conflict) by selecting the existing receipt row and comparing digests, not
 * from this mapped code.
 *
 * @param {unknown} err
 * @param {string} [operation] Short operation label kept in safe details.
 * @returns {StorageError}
 */
export function toStorageError(err, operation) {
  if (err instanceof StorageError) return err;
  // A serialized StorageError (e.g. after postMessage) keeps its code.
  const revived = fromJSON(err);
  if (revived) return revived;
  const extended = sqliteExtendedCode(err);
  const errno = /** @type {any} */ (err)?.code;
  /** @type {[string, boolean]} */
  let mapped = [STORAGE_ERROR_CODES.IO, false];
  /** @type {Record<string, unknown>} */
  const details = operation ? { operation } : {};
  if (extended !== null) {
    const primary = extended & 0xff;
    if (Object.prototype.hasOwnProperty.call(PRIMARY_TO_STORAGE, primary)) mapped = PRIMARY_TO_STORAGE[primary];
    details.sqliteCode = extended;
    if (primary === SQLITE_PRIMARY_CODES.CONSTRAINT) {
      details.constraintKind = SQLITE_CONSTRAINT_KINDS[extended] || 'other';
    }
  } else if (typeof errno === 'string' && Object.prototype.hasOwnProperty.call(ERRNO_TO_STORAGE, errno)) {
    mapped = ERRNO_TO_STORAGE[errno];
  }
  const message = err instanceof Error ? err.message : String(err);
  return new StorageError(mapped[0], `${operation ? `${operation}: ` : ''}${message}`, {
    cause: err,
    retryable: mapped[1],
    details,
  });
}
