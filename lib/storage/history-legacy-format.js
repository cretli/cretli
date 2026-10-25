/**
 * Strict reader and canonical form of the LEGACY chat-history document
 * (`data/chat-history/<chatId>.json`, written by lib/persist/chat-history-persist.js).
 *
 * The legacy loader is deliberately forgiving: it defaults missing fields and
 * silently drops events it cannot validate, and the next save then makes that
 * loss permanent. A migration must not do that, so this reader refuses every
 * deviation with a stable `code` instead of repairing, truncating or dropping.
 * Nothing here touches the filesystem except `readLegacyHistoryFile`, which only
 * reads.
 *
 * Documented format (v1), from the code, not from user data:
 *   { v: 1, chatId, cursorSessionId, headSeq, updatedAt, events: [{ seq, rec }] }
 * `rec` is validated by `isValidSdkHistoryRecord`. Records written by a client
 * carry `clientSeq` (idempotency key, legacy-wide per chat). Unknown keys at the
 * document, event and record level are preserved verbatim (`docExtra`,
 * `event.extra`, and inside `rec`).
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isValidSdkHistoryRecord } from '../persist/chat-history-validate.js';
import { canonicalJson } from './command-receipts.js';
import { HISTORY_MAX_LARGE_RECORD_BYTES, HISTORY_RETENTION_LIMIT } from './chat-history-store.js';
import { toWireJson } from './worker-wire.js';

/** Legacy file `v` this reader understands. */
export const LEGACY_STORE_VERSION = 1;
/** Chat ids the legacy persist layer accepts (`isValidChatId`). */
export const LEGACY_CHAT_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;
/** Identity alphabet of the new store (chat-history-store.js `isIdentity`). */
export const STORE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
/** Producer that owns every imported event. It is created `retired`: nobody can append as it. */
export const LEGACY_IMPORT_PRODUCER_ID = 'legacy-import';
/** Chat epoch stamped on imported chats. */
export const LEGACY_IMPORT_CHAT_EPOCH = 'legacy-import';
/** Default ceiling of one legacy file; larger files are refused, not streamed partially. */
export const DEFAULT_MAX_LEGACY_FILE_BYTES = 256 * 1024 * 1024;
/** Counters must stay below the store's exhaustion bound. */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;
const DOC_KNOWN_KEYS = Object.freeze(['v', 'chatId', 'cursorSessionId', 'headSeq', 'updatedAt', 'events']);
const EVENT_KNOWN_KEYS = Object.freeze(['seq', 'rec']);

/** Typed, stable-coded failure of a migration step. `details` never carries conversation text. */
export class HistoryMigrationError extends Error {
  /**
   * @param {string} code Stable machine code (`legacy_*`, `staging_*`, `export_*`, ...).
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HistoryMigrationError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
export function refuse(code, message, details) {
  throw new HistoryMigrationError(code, message, details);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Refuse JSON that `JSON.parse` would accept but silently collapse: an object
 * with the same key twice (the last wins and the first is lost). The text is
 * already known to be syntactically valid when this runs, so the scan only
 * tracks object nesting and key strings.
 *
 * @param {string} text
 * @returns {void}
 */
export function assertNoDuplicateKeys(text) {
  /** @type {Array<Set<string> | null>} */
  const stack = [];
  let expectKey = false;
  const stringAt = /"(?:[^"\\]|\\.)*"/y;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      stringAt.lastIndex = index;
      const match = stringAt.exec(text);
      if (!match) refuse('legacy_invalid_json', 'Unterminated JSON string');
      const top = stack[stack.length - 1];
      if (top && expectKey) {
        const key = JSON.parse(match[0]);
        if (top.has(key)) refuse('legacy_duplicate_key', 'Duplicate object key in legacy document', { keyLength: key.length });
        top.add(key);
        expectKey = false;
      }
      index = stringAt.lastIndex - 1;
    } else if (char === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (char === '[') {
      stack.push(null);
      expectKey = false;
    } else if (char === '}' || char === ']') {
      stack.pop();
      expectKey = false;
    } else if (char === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
}

/**
 * Parse text as strict JSON: no BOM, valid syntax, exactly one value, no
 * duplicate keys. Invalid UTF-8 must have been refused when the bytes were decoded.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseStrictJson(text) {
  if (text.charCodeAt(0) === 0xfeff) refuse('legacy_invalid_json', 'Legacy document starts with a byte order mark');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    refuse('legacy_invalid_json', 'Legacy document is not valid JSON');
  }
  assertNoDuplicateKeys(text);
  return value;
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
export function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse('legacy_invalid_utf8', 'Legacy document is not valid UTF-8');
  }
}

/**
 * Define an own, enumerable data property. Plain `obj[key] = v` would turn the
 * JSON key `__proto__` into a prototype change and silently lose it.
 *
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Prove against the RAW parse tree that normalisation kept every key (and the
 * very same value) at document and event level. A digest of the normalised
 * form cannot prove this: a loss shared by both sides cancels out.
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} rebuilt
 * @param {Record<string, unknown>} where
 * @returns {void}
 */
function assertSameOwnKeys(raw, rebuilt, where) {
  const rawKeys = Object.keys(raw);
  const rebuiltKeys = Object.keys(rebuilt);
  if (rawKeys.length !== rebuiltKeys.length || !rawKeys.every((key) => Object.hasOwn(rebuilt, key) && rebuilt[key] === raw[key])) {
    refuse('legacy_lossless_violation', 'Normalisation would drop or alter a legacy key', where);
  }
}

/**
 * @param {unknown} value
 * @param {number} [minimum]
 * @returns {value is number}
 */
function isCounter(value, minimum = 0) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= MAX_COUNTER;
}

/**
 * @typedef {{
 *   chatId: string,
 *   cursorSessionId: string,
 *   headSeq: number,
 *   updatedAt: string,
 *   docExtra: Record<string, unknown>,
 *   events: Array<{ seq: number, rec: Record<string, unknown>, extra: Record<string, unknown> | null }>,
 *   warnings: string[],
 * }} LegacyHistoryDocument
 */

/**
 * Validate a parsed legacy document against the format contract and normalise it.
 * Every refusal has a stable `code`; none repairs data.
 *
 * @param {unknown} value Parsed JSON.
 * @param {{ expectedChatId?: string, maxRecordBytes?: number }} [options]
 * @returns {LegacyHistoryDocument}
 */
export function normalizeLegacyHistory(value, options = {}) {
  const maxRecordBytes = options.maxRecordBytes ?? HISTORY_MAX_LARGE_RECORD_BYTES;
  if (!isPlainObject(value)) refuse('legacy_not_object', 'Legacy document is not a JSON object');
  if (value.v !== LEGACY_STORE_VERSION) refuse('legacy_unsupported_version', 'Legacy document version is not 1', { found: typeof value.v === 'number' ? value.v : null });
  for (const key of ['chatId', 'cursorSessionId', 'updatedAt']) {
    if (!(key in value)) refuse('legacy_doc_field_missing', 'Legacy document field is missing', { field: key });
    if (typeof value[key] !== 'string') refuse('legacy_doc_field_type', 'Legacy document field has the wrong type', { field: key });
  }
  if (!('headSeq' in value)) refuse('legacy_doc_field_missing', 'Legacy document field is missing', { field: 'headSeq' });
  if (!isCounter(value.headSeq)) refuse('legacy_doc_field_type', 'Legacy headSeq is not a non-negative safe integer', { field: 'headSeq' });
  if (!('events' in value)) refuse('legacy_doc_field_missing', 'Legacy document field is missing', { field: 'events' });
  if (!Array.isArray(value.events)) refuse('legacy_doc_field_type', 'Legacy events is not an array', { field: 'events' });
  const chatId = /** @type {string} */ (value.chatId);
  if (!LEGACY_CHAT_ID_PATTERN.test(chatId)) refuse('legacy_chat_id_invalid', 'Legacy chatId is outside the legacy alphabet');
  if (!STORE_IDENTITY_PATTERN.test(chatId)) refuse('legacy_chat_id_unmappable', 'Legacy chatId cannot be a store identity (leading hyphen)');
  if (options.expectedChatId !== undefined && chatId !== options.expectedChatId) {
    refuse('legacy_chat_id_mismatch', 'Document chatId differs from its file name');
  }
  /** @type {Record<string, unknown>} */
  const docExtra = {};
  for (const key of Object.keys(value)) {
    if (!DOC_KNOWN_KEYS.includes(key)) setOwn(docExtra, key, value[key]);
  }
  const events = [];
  let previousSeq = 0;
  /** @type {Map<number, number>} */
  const clientSeqOwners = new Map();
  value.events.forEach((entry, index) => {
    if (!isPlainObject(entry)) refuse('legacy_invalid_event', 'Legacy event is not an object', { index });
    if (!isCounter(entry.seq, 1)) refuse('legacy_invalid_event', 'Legacy event seq is not a positive safe integer', { index });
    if (entry.seq <= previousSeq) refuse('legacy_seq_not_ascending', 'Legacy event seq is not strictly ascending', { index });
    if (!isValidSdkHistoryRecord(entry.rec)) refuse('legacy_invalid_record', 'Legacy record fails the history record contract', { index, seq: entry.seq });
    const rec = /** @type {Record<string, unknown>} */ (entry.rec);
    let bytes;
    try {
      bytes = toWireJson(rec).bytes;
    } catch {
      return refuse('legacy_record_not_json', 'Legacy record is not plain JSON data', { index, seq: entry.seq });
    }
    if (bytes > maxRecordBytes) {
      refuse('legacy_record_too_large', 'Legacy record exceeds the large-record cap and is not truncated', { index, seq: entry.seq, bytes, maxRecordBytes });
    }
    if ('clientSeq' in rec) {
      if (!isCounter(rec.clientSeq)) refuse('legacy_client_seq_invalid', 'Legacy record clientSeq is not a non-negative safe integer', { index, seq: entry.seq });
      if (clientSeqOwners.has(rec.clientSeq)) {
        refuse('legacy_duplicate_client_seq', 'Two retained legacy events share one clientSeq; the dedupe ledger would be ambiguous', {
          seq: entry.seq, otherSeq: clientSeqOwners.get(rec.clientSeq), clientSeq: rec.clientSeq,
        });
      }
      clientSeqOwners.set(rec.clientSeq, entry.seq);
    }
    /** @type {Record<string, unknown> | null} */
    let extra = null;
    for (const key of Object.keys(entry)) {
      if (EVENT_KNOWN_KEYS.includes(key)) continue;
      extra ??= {};
      setOwn(extra, key, entry[key]);
    }
    previousSeq = entry.seq;
    assertSameOwnKeys(entry, { seq: entry.seq, rec, ...(extra ?? {}) }, { index, seq: entry.seq });
    events.push({ seq: entry.seq, rec, extra });
  });
  assertSameOwnKeys(value, { v: value.v, chatId, cursorSessionId: value.cursorSessionId, headSeq: value.headSeq, updatedAt: value.updatedAt, events: value.events, ...docExtra }, {});
  const headSeq = /** @type {number} */ (value.headSeq);
  if (headSeq < previousSeq) refuse('legacy_head_seq_behind', 'Legacy headSeq is lower than the last retained seq', { headSeq, lastSeq: previousSeq });
  /** @type {string[]} */
  const warnings = [];
  if (events.length > HISTORY_RETENTION_LIMIT) warnings.push('over_retention');
  if (events.length === 0 && headSeq > 0) warnings.push('empty_with_head_seq');
  return {
    chatId, cursorSessionId: /** @type {string} */ (value.cursorSessionId), headSeq,
    updatedAt: /** @type {string} */ (value.updatedAt), docExtra, events, warnings,
  };
}

/**
 * Read one legacy file: bounded size, regular file only (never a symlink),
 * strict UTF-8, strict JSON, strict contract. Returns the normalised document
 * and the SHA-256 of the exact bytes read, so a later pass can prove the
 * source did not change.
 *
 * @param {string} filePath
 * @param {{ expectedChatId?: string, maxFileBytes?: number, maxRecordBytes?: number }} [options]
 * @returns {{ doc: LegacyHistoryDocument, sha256: string, bytes: number }}
 */
export function readLegacyHistoryFile(filePath, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_LEGACY_FILE_BYTES;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) refuse('legacy_not_regular_file', 'Legacy history entry is not a regular file (symlinks are refused)');
  if (stat.size > maxFileBytes) refuse('legacy_file_too_large', 'Legacy history file exceeds the size ceiling', { bytes: stat.size, maxFileBytes });
  const bytes = fs.readFileSync(filePath);
  const text = decodeUtf8Strict(bytes);
  const doc = normalizeLegacyHistory(parseStrictJson(text), options);
  return { doc, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/**
 * The legacy document a `LegacyHistoryDocument` represents, in the key order the
 * legacy writer uses. Used by the rollback export and by logical comparison.
 *
 * @param {LegacyHistoryDocument} doc
 * @returns {Record<string, unknown>}
 */
export function toLegacyDocumentObject(doc) {
  return {
    v: LEGACY_STORE_VERSION,
    chatId: doc.chatId,
    cursorSessionId: doc.cursorSessionId,
    headSeq: doc.headSeq,
    updatedAt: doc.updatedAt,
    events: doc.events.map((event) => ({ seq: event.seq, rec: event.rec, ...(event.extra ?? {}) })),
    ...doc.docExtra,
  };
}

/**
 * Order-independent digest of everything a legacy document means (unknown
 * fields included). Two documents with the same digest are logically identical
 * whatever their whitespace or key order.
 *
 * @param {LegacyHistoryDocument} doc
 * @returns {string}
 */
export function digestLegacyDocument(doc) {
  const canonical = canonicalJson(toLegacyDocumentObject(doc));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * @param {Buffer | string} content
 * @returns {string}
 */
export function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}
