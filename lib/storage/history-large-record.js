/**
 * Fragment codec of the large-record protocol (docs/storage-history-migration.md
 * "Large records"). A record above the regular 256 KiB cap and up to
 * HISTORY_MAX_LARGE_RECORD_BYTES is serialised once with `toWireJson`, cut into
 * fixed-size raw byte fragments and sent as base64 commands that each fit the
 * regular 64 KiB command budget. The worker reassembles the bytes, checks length and
 * SHA-256 and only then parses the text, so splitting inside a UTF-8 sequence or an
 * escaped surrogate cannot corrupt a record.
 *
 * No state lives here: the module is pure so the adapter, the worker handlers and the
 * tests share one definition of the limits.
 */
import { createHash } from 'node:crypto';
import { toWireJson } from './worker-wire.js';

/** Largest stored record (wire JSON bytes, including the store-added `clientSeq`) the fragment protocol accepts. */
export const HISTORY_MAX_LARGE_RECORD_BYTES = 3 * 1024 * 1024;
/** Raw bytes per fragment; base64 expands it to 43,692 characters, well inside the 64 KiB command budget. */
export const HISTORY_LARGE_FRAGMENT_BYTES = 32 * 1024;
export const HISTORY_LARGE_MAX_FRAGMENTS = Math.ceil(HISTORY_MAX_LARGE_RECORD_BYTES / HISTORY_LARGE_FRAGMENT_BYTES);
/** Staging quota: concurrent staged records per chat, and in total across the store. */
export const HISTORY_STAGE_MAX_PER_CHAT = 4;
export const HISTORY_STAGE_MAX_TOTAL = 64;
export const HISTORY_STAGE_MAX_BYTES_PER_CHAT = 4 * HISTORY_MAX_LARGE_RECORD_BYTES;
export const HISTORY_STAGE_MAX_BYTES_TOTAL = 64 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** @param {Buffer | string} content @returns {string} */
export const sha256Hex = (content) => createHash('sha256').update(content).digest('hex');

/** @param {number} total @returns {number} fragments needed for `total` bytes */
export const fragmentCountFor = (total) => Math.ceil(total / HISTORY_LARGE_FRAGMENT_BYTES);

/**
 * Raw size the fragment at `index` must have.
 * @param {number} total @param {number} count @param {number} index @returns {number}
 */
export const fragmentSizeAt = (total, count, index) => (index < count - 1 ? HISTORY_LARGE_FRAGMENT_BYTES : total - HISTORY_LARGE_FRAGMENT_BYTES * (count - 1));

/**
 * The `large` descriptor shape the finalizing command carries.
 * @param {unknown} value @returns {boolean}
 */
export function isLargeDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { bytes, fragments, sha256 } = /** @type {Record<string, unknown>} */ (value);
  return Object.keys(value).length === 3 && Number.isSafeInteger(bytes) && /** @type {number} */ (bytes) >= 1
    && /** @type {number} */ (bytes) <= HISTORY_MAX_LARGE_RECORD_BYTES && fragments === fragmentCountFor(/** @type {number} */ (bytes))
    && typeof sha256 === 'string' && SHA256_PATTERN.test(sha256);
}

/** @param {unknown} data @param {number} rawBytes @returns {boolean} strict base64 of exactly `rawBytes` bytes */
export function isFragmentData(data, rawBytes) {
  if (typeof data !== 'string' || data.length !== Math.ceil(rawBytes / 3) * 4 || !BASE64_PATTERN.test(data)) return false;
  return Buffer.from(data, 'base64').length === rawBytes;
}

/**
 * Plan the fragments of one record. The record is measured the way the store measures
 * it: wire JSON of the record WITH the widest `clientSeq` the store may add, so a plan
 * that passes here cannot be refused for size at finalization.
 *
 * @param {Record<string, unknown>} rec
 * @param {{ measureStored?: boolean, widestClientSeq?: number }} [options] `storedBytes` is 0 unless `measureStored` (it costs a second serialisation)
 * @returns {{ json: string, bytes: number, storedBytes: number, large: { bytes: number, fragments: number, sha256: string }, fragments: string[] }}
 */
export function planLargeRecord(rec, options = {}) {
  const wire = toWireJson(rec);
  const storedBytes = options.measureStored ? toWireJson({ ...rec, clientSeq: options.widestClientSeq ?? Number.MAX_SAFE_INTEGER - 1 }).bytes : 0;
  const raw = Buffer.from(wire.json, 'utf8');
  const count = fragmentCountFor(raw.length);
  const fragments = [];
  for (let index = 0; index < count; index += 1) {
    fragments.push(raw.subarray(index * HISTORY_LARGE_FRAGMENT_BYTES, (index + 1) * HISTORY_LARGE_FRAGMENT_BYTES).toString('base64'));
  }
  return { json: wire.json, bytes: raw.length, storedBytes, large: { bytes: raw.length, fragments: count, sha256: sha256Hex(raw) }, fragments };
}

/**
 * Reassemble staged fragments. Throws a plain `Error` with a `kind` for the worker to turn into a typed refusal.
 * @param {Array<Buffer | Uint8Array>} parts in index order
 * @param {{ bytes: number, fragments: number, sha256: string }} large
 * @returns {Buffer}
 */
export function assembleFragments(parts, large) {
  const fail = (kind) => Object.assign(new Error(kind), { kind });
  if (parts.length !== large.fragments) throw fail('history_large_incomplete');
  parts.forEach((part, index) => {
    if (part.length !== fragmentSizeAt(large.bytes, large.fragments, index)) throw fail('history_large_incomplete');
  });
  const whole = Buffer.concat(parts);
  if (whole.length !== large.bytes || sha256Hex(whole) !== large.sha256) throw fail('history_large_digest_mismatch');
  return whole;
}
