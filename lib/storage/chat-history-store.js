/**
 * Incremental history pilot. This file is both a synchronous worker registry
 * and an asynchronous host facade; it never opens a database on the host.
 * See chat-history-store.md for identity, retention and ACK boundaries.
 */
import { isValidSdkHistoryRecord } from '../persist/chat-history-validate.js';
import { summarizeChatHistoryUsage } from '../persist/chat-history-usage.js';
import {
  mergeSdkHistoryStreamText, readSdkHistoryStreamKind, readSdkHistoryStreamText,
  readSdkHistoryStreamTextMode, withSdkHistoryStreamText,
} from '../sdk/sdk-history-stream-coalesce.ts';
import { computeRequestDigest, DATASET_GENERATION_PATTERN, executeCommand, RECEIPT_HANDLER_MARK, RECEIPT_QUERIES, resolveUnknown, withReceipt } from './command-receipts.js';
import { StorageError } from './errors.js';
import { assertWriteAllowed } from './maintenance-coordinator.js';
import {
  assembleFragments, fragmentCountFor, fragmentSizeAt, HISTORY_LARGE_MAX_FRAGMENTS, HISTORY_MAX_LARGE_RECORD_BYTES, HISTORY_STAGE_MAX_BYTES_PER_CHAT,
  HISTORY_STAGE_MAX_BYTES_TOTAL, HISTORY_STAGE_MAX_PER_CHAT, HISTORY_STAGE_MAX_TOTAL, isFragmentData, isLargeDescriptor,
} from './history-large-record.js';
import { toWireJson } from './worker-wire.js';

export const HISTORY_RETENTION_LIMIT = 2000;
export const HISTORY_MAX_APPEND_EVENTS = 256;
export const HISTORY_MAX_COMMAND_BYTES = 64 * 1024;
export const HISTORY_MAX_RECORD_BYTES = 256 * 1024;
/**
 * Explicit cap of a LARGE stored record (fragment protocol, history-large-record.js). A regular
 * append still refuses above HISTORY_MAX_RECORD_BYTES; only a finalized staged record may reach this.
 */
export { HISTORY_MAX_LARGE_RECORD_BYTES };
/** Stages per `listStages` page. */
export const HISTORY_STAGE_LIST_PAGE_MAX = 200;
/** Allowance for identity fields and the event wrapper around one record. */
export const HISTORY_COMMAND_ENVELOPE_BYTES = 8 * 1024;
/**
 * Command budget of a single-event append. A record between the 64 KiB batch
 * budget and HISTORY_MAX_RECORD_BYTES stays saveable (P2-2): the legacy
 * adapter had no record limit, so a large tool result must not become
 * unwritable after caller conversion.
 */
export const HISTORY_MAX_SINGLE_EVENT_COMMAND_BYTES = HISTORY_MAX_RECORD_BYTES + HISTORY_COMMAND_ENVELOPE_BYTES;
/**
 * `maxMemberBytes` a group committer feeding this store must use so that a
 * single-event command (plus receipt envelope and batch entry) ships alone
 * instead of failing with `payload_too_large`.
 */
export const HISTORY_GROUP_MAX_MEMBER_BYTES = HISTORY_MAX_SINGLE_EVENT_COMMAND_BYTES + HISTORY_COMMAND_ENVELOPE_BYTES;
/** Serialized bytes of an event row besides `rec` (seq, ids, counters), upper bound. */
const EVENT_WRAPPER_BYTES = 400;
/**
 * Upper bound of the serialized read result (events only) charged against the
 * worker result limit (4 MiB, see worker-host DEFAULT_MAX_RESULT_BYTES). A
 * window is truncated by bytes before it would exceed the worker's
 * `result_too_large` refusal, so the caller always gets a page plus `hasMore`
 * instead of a non-retryable error (P2-1). Headroom is left for the state
 * fields and the `hasMore` flag returned alongside the events.
 */
export const HISTORY_READ_RESULT_BYTE_BUDGET = 4 * 1024 * 1024 - 256 * 1024;
/** Producer that owns events copied by `copyChat` (retired from birth, so nobody can append as it). */
export const HISTORY_FORK_PRODUCER_ID = 'fork-copy';
/** Longest `cursorSessionId` a write accepts (bytes); imported values are kept as they are. */
export const HISTORY_MAX_CURSOR_SESSION_BYTES = 4096;
/** Ceiling of the stored JSON a single `copyChat` command may duplicate inside the worker. */
export const HISTORY_MAX_COPY_BYTES = 64 * 1024 * 1024;
/** Chats per `listHeads` page. */
export const HISTORY_LIST_PAGE_MAX = 500;
/** Seqs per `readSeqs` call. */
export const HISTORY_READ_SEQS_MAX = 256;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;
const COMMAND_PREFIX = 'history.';

/** @typedef {{datasetGeneration:string, chatId:string, chatEpoch:string}} HistoryIdentity */
/** @typedef {{clientSeq:number, rec:Record<string, unknown>, createdAt?:number, large?:any}} HistoryInput */
/** @typedef {HistoryIdentity & {producerId:string, events:HistoryInput[], cursorSessionId?:string, expectedRevision?:number, coalesce?:boolean}} AppendPayload */

/** @param {string} kind @param {Record<string, unknown>} [details] @returns {never} */
function refuse(kind, details = {}) {
  throw new StorageError('conflict', 'History command refused', {
    details: { operation: 'history', conflictKind: kind, commitState: 'not_committed', ...details },
  });
}

/** @param {unknown} value @returns {boolean} */
function isIdentity(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
}

/** @param {unknown} value @param {number} [minimum] @returns {boolean} */
function isCounter(value, minimum = 0) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= minimum && /** @type {number} */ (value) <= MAX_COUNTER;
}

/** @param {HistoryIdentity} payload @returns {void} */
function assertIdentity(payload) {
  if (!payload || typeof payload.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(payload.datasetGeneration)
    || !isIdentity(payload.chatId) || !isIdentity(payload.chatEpoch)) {
    refuse('history_reconciliation_required');
  }
}

/** @param {any} ctx @param {string} chatId @returns {any|undefined} */
function readState(ctx, chatId) {
  return ctx.prepare('SELECT * FROM chat_history_state WHERE chat_id = ?').get(chatId);
}

/** @param {any} state @returns {any} */
function stateResult(state) {
  return {
    datasetGeneration: state.dataset_generation, chatId: state.chat_id, chatEpoch: state.chat_epoch,
    revision: state.revision, headSeq: state.next_seq - 1, nextSeq: state.next_seq,
    retentionLimit: state.retention_limit, trimmedThroughSeq: state.trimmed_through_seq,
  };
}

/** @param {any} ctx @param {string} chatId @returns {void} */
function ensureMeta(ctx, chatId) {
  ctx.prepare('INSERT OR IGNORE INTO chat_history_meta (chat_id) VALUES (?)').run(chatId);
}

/**
 * Original `updatedAt` string and tombstone are valid only until the next
 * write; `revive` also clears a deletion tombstone (a new event recreates the chat).
 * @param {any} ctx @param {string} chatId @param {boolean} [revive]
 */
function touchMeta(ctx, chatId, revive = false) {
  ctx.prepare(`UPDATE chat_history_meta SET updated_at_raw = NULL${revive ? ', deleted_at = NULL' : ''} WHERE chat_id = ?`).run(chatId);
}

/** @param {unknown} chatId @returns {void} */
function assertChatId(chatId) {
  if (!isIdentity(chatId)) refuse('history_reconciliation_required');
}

/**
 * @param {any} ctx @param {HistoryIdentity & {anyEpoch?: boolean}} payload
 * @param {boolean} [create]
 * @returns {any|undefined}
 */
function requireState(ctx, payload, create = false) {
  // A legacy-semantic read has no epoch to give: it only needs the chat and learns the current identity from the result.
  if (payload?.anyEpoch === true && !create) {
    assertChatId(payload.chatId);
    return readState(ctx, payload.chatId);
  }
  assertIdentity(payload);
  let state = readState(ctx, payload.chatId);
  if (!state && create) {
    ctx.prepare(`INSERT INTO chat_history_state
      (chat_id, dataset_generation, chat_epoch, revision, next_seq, retention_limit, trimmed_through_seq, updated_at)
      VALUES (?, ?, ?, 0, 1, ?, 0, ?)`).run(payload.chatId, payload.datasetGeneration, payload.chatEpoch, HISTORY_RETENTION_LIMIT, Date.now());
    ctx.prepare(`INSERT INTO chat_history_epochs (chat_id, dataset_generation, chat_epoch, created_at)
      VALUES (?, ?, ?, ?)`).run(payload.chatId, payload.datasetGeneration, payload.chatEpoch, Date.now());
    ensureMeta(ctx, payload.chatId);
    state = readState(ctx, payload.chatId);
  }
  if (state && (state.dataset_generation !== payload.datasetGeneration || state.chat_epoch !== payload.chatEpoch)) refuse('history_stale_epoch');
  return state;
}

/** @param {any} state @param {number|undefined} expectedRevision @returns {void} */
function assertRevision(state, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (!isCounter(expectedRevision)) refuse('history_invalid_revision');
  if (state.revision !== expectedRevision) refuse('history_revision_mismatch', { expectedRevision, actualRevision: state.revision });
}

/** @param {any} ctx @param {AppendPayload} payload @returns {void} */
function requireProducer(ctx, payload) {
  if (!isIdentity(payload.producerId)) refuse('history_reconciliation_required');
  const row = ctx.prepare(`SELECT * FROM chat_history_producers
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ?`).get(payload.datasetGeneration, payload.chatId, payload.producerId);
  if (row && (row.status !== 'active' || row.chat_epoch !== payload.chatEpoch)) refuse('history_producer_fenced');
  if (row) return;
  ctx.prepare(`INSERT INTO chat_history_producers
    (dataset_generation, chat_id, producer_id, chat_epoch, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)`).run(payload.datasetGeneration, payload.chatId, payload.producerId, payload.chatEpoch, Date.now());
}

/** @param {AppendPayload} payload @returns {void} */
function assertEvents(payload) {
  if (!isIdentity(payload.producerId)) refuse('history_reconciliation_required');
  if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > HISTORY_MAX_APPEND_EVENTS) refuse('history_invalid_events');
  if (payload.coalesce !== undefined && typeof payload.coalesce !== 'boolean') refuse('history_invalid_events');
  for (const item of payload.events) {
    if (!item || !isCounter(item.clientSeq) || (item.createdAt !== undefined && !isCounter(item.createdAt))) refuse('history_invalid_events');
    // A finalizing input names its staged fragments instead of carrying the record: exactly one per command.
    if (item.large !== undefined) {
      if (payload.events.length !== 1 || item.rec !== undefined || !isLargeDescriptor(item.large)) refuse('history_invalid_events');
    } else if (!isValidSdkHistoryRecord(item.rec)) refuse('history_invalid_events');
  }
}

/** @param {any} ctx @param {any} state @returns {number} */
function trimEvents(ctx, state) {
  // OFFSET counts retained rows, rather than sequence gaps from coalescing.
  const boundary = ctx.prepare(`SELECT seq FROM chat_history_events
    WHERE dataset_generation = ? AND chat_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`)
    .get(state.dataset_generation, state.chat_id, state.retention_limit);
  if (!boundary) return 0;
  const result = ctx.prepare('DELETE FROM chat_history_events WHERE dataset_generation = ? AND chat_id = ? AND seq <= ?')
    .run(state.dataset_generation, state.chat_id, boundary.seq);
  ctx.prepare('DELETE FROM chat_history_event_extra WHERE chat_id = ? AND seq <= ?').run(state.chat_id, boundary.seq);
  state.trimmed_through_seq = Math.max(state.trimmed_through_seq, boundary.seq);
  return Number(result.changes);
}

/** @param {any} ctx @param {any} state @returns {void} */
function saveState(ctx, state) {
  ctx.prepare(`UPDATE chat_history_state SET revision = ?, next_seq = ?, retention_limit = ?,
    trimmed_through_seq = ?, updated_at = ? WHERE chat_id = ?`)
    .run(state.revision, state.next_seq, state.retention_limit, state.trimmed_through_seq, Date.now(), state.chat_id);
}

/** @param {any} ctx @param {AppendPayload} payload @param {any} state @param {HistoryInput} item @returns {any} */
function appendInput(ctx, payload, state, item) {
  const key = [payload.datasetGeneration, payload.chatId, payload.producerId, item.clientSeq];
  const digest = computeRequestDigest('history.input', item.large
    ? { chatEpoch: payload.chatEpoch, large: item.large, createdAt: item.createdAt ?? null, coalesce: payload.coalesce !== false }
    : { chatEpoch: payload.chatEpoch, rec: item.rec, createdAt: item.createdAt ?? null, coalesce: payload.coalesce !== false });
  const prior = ctx.prepare(`SELECT request_digest, result_json FROM chat_history_dedupe
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ?`).get(...key);
  if (prior) {
    if (prior.request_digest !== digest) refuse('history_input_digest_mismatch');
    return { ...JSON.parse(prior.result_json), duplicate: true };
  }
  if (state.revision >= MAX_COUNTER || state.next_seq >= MAX_COUNTER) refuse('history_counter_exhausted');
  const tail = ctx.prepare(`SELECT seq, producer_id, payload_json FROM chat_history_events
    WHERE dataset_generation = ? AND chat_id = ? ORDER BY seq DESC LIMIT 1`).get(payload.datasetGeneration, payload.chatId);
  // A finalized large record never coalesces: it is its own event and the regular merge cap would refuse any delta onto it.
  const incoming = item.large ? loadStagedRecord(ctx, payload, item) : item.rec;
  const previous = tail && !item.large ? JSON.parse(tail.payload_json) : null;
  const kind = item.large ? null : readSdkHistoryStreamKind(incoming);
  let canMerge = payload.coalesce !== false && kind && tail?.producer_id === payload.producerId
    && readSdkHistoryStreamKind(previous) === kind;
  let rec = canMerge ? withSdkHistoryStreamText(previous, mergeSdkHistoryStreamText(
    readSdkHistoryStreamText(previous), readSdkHistoryStreamText(incoming), readSdkHistoryStreamTextMode(incoming),
  )) : { ...incoming, clientSeq: item.clientSeq };
  let wire = toWireJson(rec);
  if (canMerge && wire.bytes > HISTORY_MAX_RECORD_BYTES) {
    // Overflow policy: a stream that outgrows the record cap continues in a
    // new event instead of losing content or refusing the delta.
    canMerge = false;
    rec = { ...incoming, clientSeq: item.clientSeq };
    wire = toWireJson(rec);
  }
  if (wire.bytes > (item.large ? HISTORY_MAX_LARGE_RECORD_BYTES : HISTORY_MAX_RECORD_BYTES)) refuse('history_record_too_large');
  const seq = canMerge ? tail.seq : state.next_seq++;
  state.revision += 1;
  if (canMerge) {
    ctx.prepare(`UPDATE chat_history_events SET payload_json = ?, revision = ?
      WHERE dataset_generation = ? AND chat_id = ? AND seq = ?`).run(wire.json, state.revision, payload.datasetGeneration, payload.chatId, seq);
  } else {
    ctx.prepare(`INSERT INTO chat_history_events
      (dataset_generation, chat_id, seq, chat_epoch, producer_id, client_seq, kind, payload_json, created_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(payload.datasetGeneration, payload.chatId, seq,
      payload.chatEpoch, payload.producerId, item.clientSeq, rec.kind, wire.json, item.createdAt ?? Date.now(), state.revision);
  }
  const accepted = { clientSeq: item.clientSeq, seq, revision: state.revision, duplicate: false };
  // The record is an event now; its fragments go in the same transaction (atomic finalization).
  if (item.large) deleteStage(ctx, payload.datasetGeneration, payload.chatId, payload.producerId, item.clientSeq);
  ctx.prepare(`INSERT INTO chat_history_dedupe
    (dataset_generation, chat_id, producer_id, client_seq, chat_epoch, event_seq, request_digest, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...key, payload.chatEpoch, seq, digest, JSON.stringify(accepted), Date.now());
  return accepted;
}

/** @param {string} kind @param {Record<string, unknown>} [details] @returns {never} */
function refuseTransient(kind, details = {}) {
  throw new StorageError('conflict', 'History command refused', {
    retryable: true, details: { operation: 'history', conflictKind: kind, commitState: 'not_committed', ...details },
  });
}

/** @param {any} ctx @param {string} generation @param {string} chatId @param {string} producerId @param {number} clientSeq @returns {void} */
function deleteStage(ctx, generation, chatId, producerId, clientSeq) {
  ctx.prepare(`DELETE FROM chat_history_stage_fragment
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ?`).run(generation, chatId, producerId, clientSeq);
  ctx.prepare(`DELETE FROM chat_history_stage
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ?`).run(generation, chatId, producerId, clientSeq);
}

/** Drop every staged fragment of a chat (reset, delete, replaced fork target): they belong to an identity that no longer exists. */
function deleteChatStages(ctx, chatId) {
  ctx.prepare('DELETE FROM chat_history_stage_fragment WHERE chat_id = ?').run(chatId);
  ctx.prepare('DELETE FROM chat_history_stage WHERE chat_id = ?').run(chatId);
}

/** @param {any} payload @returns {void} */
function assertFragmentPayload(payload) {
  const total = payload.totalBytes;
  const count = payload.count;
  if (!isIdentity(payload.producerId) || !isCounter(payload.clientSeq) || !Number.isSafeInteger(total) || total < 1
    || total > HISTORY_MAX_LARGE_RECORD_BYTES || count !== fragmentCountFor(total) || count > HISTORY_LARGE_MAX_FRAGMENTS
    || !Number.isSafeInteger(payload.index) || payload.index < 0 || payload.index >= count
    || typeof payload.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sha256)
    || !isFragmentData(payload.data, fragmentSizeAt(total, count, payload.index))) refuse('history_invalid_large');
}

/**
 * One bounded fragment of a large record. Idempotent by content: the same fragment again is a no-op,
 * a different one at the same index (or a different header) is a mismatch. The fragment is not history:
 * nothing but the finalizing append can turn staged bytes into an event.
 * @param {any} ctx
 * @param {HistoryIdentity & {producerId:string, clientSeq:number, index:number, count:number, totalBytes:number, sha256:string, data:string}} payload
 * @returns {any}
 */
function stageFragment(ctx, payload) {
  assertIdentity(payload);
  assertFragmentPayload(payload);
  const state = readState(ctx, payload.chatId);
  if (state && (state.dataset_generation !== payload.datasetGeneration || state.chat_epoch !== payload.chatEpoch)) refuse('history_stale_epoch');
  const producer = ctx.prepare(`SELECT status, chat_epoch FROM chat_history_producers
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ?`).get(payload.datasetGeneration, payload.chatId, payload.producerId);
  if (producer && (producer.status !== 'active' || producer.chat_epoch !== payload.chatEpoch)) refuse('history_producer_fenced');
  const key = [payload.datasetGeneration, payload.chatId, payload.producerId, payload.clientSeq];
  const header = ctx.prepare(`SELECT chat_epoch, total_bytes, fragment_count, sha256 FROM chat_history_stage
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ?`).get(...key);
  if (header) {
    if (header.chat_epoch !== payload.chatEpoch) refuse('history_stale_epoch');
    if (header.total_bytes !== payload.totalBytes || header.fragment_count !== payload.count || header.sha256 !== payload.sha256) refuse('history_stage_mismatch');
  } else {
    // Quota is reserved by the declared size at the first fragment, so a refusal never leaves a partial reservation.
    const chat = ctx.prepare('SELECT count(*) AS stages, coalesce(sum(total_bytes), 0) AS bytes FROM chat_history_stage WHERE chat_id = ?').get(payload.chatId);
    const all = ctx.prepare('SELECT count(*) AS stages, coalesce(sum(total_bytes), 0) AS bytes FROM chat_history_stage').get();
    if (Number(chat.stages) >= HISTORY_STAGE_MAX_PER_CHAT || Number(chat.bytes) + payload.totalBytes > HISTORY_STAGE_MAX_BYTES_PER_CHAT
      || Number(all.stages) >= HISTORY_STAGE_MAX_TOTAL || Number(all.bytes) + payload.totalBytes > HISTORY_STAGE_MAX_BYTES_TOTAL) {
      refuseTransient('history_stage_quota', { chatStages: Number(chat.stages), totalStages: Number(all.stages) });
    }
    ctx.prepare(`INSERT INTO chat_history_stage
      (dataset_generation, chat_id, producer_id, client_seq, chat_epoch, total_bytes, fragment_count, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...key, payload.chatEpoch, payload.totalBytes, payload.count, payload.sha256, Date.now());
  }
  const bytes = Buffer.from(payload.data, 'base64');
  const existing = ctx.prepare(`SELECT data FROM chat_history_stage_fragment
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ? AND idx = ?`).get(...key, payload.index);
  if (existing) {
    if (Buffer.compare(Buffer.from(existing.data), bytes) !== 0) refuse('history_stage_mismatch');
  } else {
    ctx.prepare('INSERT INTO chat_history_stage_fragment (dataset_generation, chat_id, producer_id, client_seq, idx, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(...key, payload.index, bytes);
  }
  const received = Number(ctx.prepare(`SELECT count(*) AS n FROM chat_history_stage_fragment
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ?`).get(...key).n);
  return { chatId: payload.chatId, producerId: payload.producerId, clientSeq: payload.clientSeq, index: payload.index, received, complete: received === payload.count };
}

/**
 * Reassemble and validate the record a finalizing input names. Everything that can be wrong with the
 * staged bytes is refused here, before the event row exists; the caller's transaction then rolls back.
 * @param {any} ctx @param {AppendPayload} payload @param {HistoryInput} item
 * @returns {Record<string, unknown>}
 */
function loadStagedRecord(ctx, payload, item) {
  const key = [payload.datasetGeneration, payload.chatId, payload.producerId, item.clientSeq];
  const header = ctx.prepare(`SELECT chat_epoch, total_bytes, fragment_count, sha256 FROM chat_history_stage
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ?`).get(...key);
  if (!header) refuse('history_large_missing');
  if (header.chat_epoch !== payload.chatEpoch) refuse('history_stale_epoch');
  if (header.total_bytes !== item.large.bytes || header.fragment_count !== item.large.fragments || header.sha256 !== item.large.sha256) refuse('history_stage_mismatch');
  const parts = ctx.prepare(`SELECT data FROM chat_history_stage_fragment
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ? ORDER BY idx`).all(...key).map((row) => Buffer.from(row.data));
  let whole;
  try {
    whole = assembleFragments(parts, item.large);
  } catch (error) {
    return refuse(error?.kind ?? 'history_large_incomplete');
  }
  let rec;
  try {
    rec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(whole));
  } catch {
    return refuse('history_large_invalid');
  }
  if (!isValidSdkHistoryRecord(rec)) refuse('history_large_invalid');
  return rec;
}

/**
 * Abandon one staged record (an operator or the adapter's fenced GC decided nobody will finalize it).
 * `createdBefore` guards against deleting a newer stage that reuses the key.
 * @param {any} ctx @param {HistoryIdentity & {producerId:string, clientSeq:number, createdBefore?:number}} payload @returns {any}
 */
function abandonStage(ctx, payload) {
  assertChatId(payload?.chatId);
  if (!isIdentity(payload.producerId) || !isCounter(payload.clientSeq) || (payload.createdBefore !== undefined && !isCounter(payload.createdBefore))) refuse('history_invalid_large');
  const header = ctx.prepare(`SELECT created_at FROM chat_history_stage
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ? AND client_seq = ?`).get(payload.datasetGeneration, payload.chatId, payload.producerId, payload.clientSeq);
  if (!header || (payload.createdBefore !== undefined && header.created_at > payload.createdBefore)) return { abandoned: false };
  deleteStage(ctx, payload.datasetGeneration, payload.chatId, payload.producerId, payload.clientSeq);
  return { abandoned: true };
}

/**
 * Remove stages that can never be finalized: the chat moved to another epoch/generation (reset, delete, fork
 * tombstone) or the producer was fenced/retired. A chat with no state row yet is NOT superseded: its first write may be
 * the large record being staged. Needs no fencing token because no pending retry can succeed for them.
 * @param {any} ctx @param {{datasetGeneration:string}} payload @returns {any}
 */
function gcSupersededStages(ctx, payload) {
  if (typeof payload?.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(payload.datasetGeneration)) refuse('history_reconciliation_required');
  const dead = ctx.prepare(`SELECT g.dataset_generation, g.chat_id, g.producer_id, g.client_seq FROM chat_history_stage g
    LEFT JOIN chat_history_state s ON s.chat_id = g.chat_id
    LEFT JOIN chat_history_producers p ON p.dataset_generation = g.dataset_generation AND p.chat_id = g.chat_id AND p.producer_id = g.producer_id
    WHERE (s.chat_id IS NOT NULL AND (s.dataset_generation <> g.dataset_generation OR s.chat_epoch <> g.chat_epoch))
      OR (p.producer_id IS NOT NULL AND (p.status <> 'active' OR p.chat_epoch <> g.chat_epoch))
    LIMIT 256`).all();
  for (const row of dead) deleteStage(ctx, row.dataset_generation, row.chat_id, row.producer_id, row.client_seq);
  return { removed: dead.length, more: dead.length === 256 };
}

/** Read-only page of staged headers (no fragment bytes), keyset by (chatId, producerId, clientSeq). */
function listStages(ctx, payload) {
  const limit = payload?.limit ?? HISTORY_STAGE_LIST_PAGE_MAX;
  const after = payload?.after ?? { chatId: '', producerId: '', clientSeq: -1 };
  if (!isCounter(limit, 1) || limit > HISTORY_STAGE_LIST_PAGE_MAX || typeof after.chatId !== 'string' || typeof after.producerId !== 'string' || !Number.isSafeInteger(after.clientSeq)) refuse('history_invalid_page');
  const rows = ctx.prepare(`SELECT chat_id, producer_id, client_seq, chat_epoch, total_bytes, fragment_count, created_at,
      (SELECT count(*) FROM chat_history_stage_fragment f WHERE f.dataset_generation = g.dataset_generation AND f.chat_id = g.chat_id
        AND f.producer_id = g.producer_id AND f.client_seq = g.client_seq) AS received
    FROM chat_history_stage g WHERE dataset_generation = ? AND (chat_id, producer_id, client_seq) > (?, ?, ?)
    ORDER BY chat_id, producer_id, client_seq LIMIT ?`).all(payload.datasetGeneration, after.chatId, after.producerId, after.clientSeq, limit + 1);
  const page = rows.slice(0, limit);
  return {
    stages: page.map((row) => ({ chatId: row.chat_id, producerId: row.producer_id, clientSeq: row.client_seq, chatEpoch: row.chat_epoch,
      totalBytes: row.total_bytes, fragments: row.fragment_count, received: Number(row.received), createdAt: row.created_at })),
    hasMore: rows.length > limit,
  };
}

/** @param {any} ctx @param {AppendPayload} payload @returns {any} */
function appendEvents(ctx, payload) {
  assertEvents(payload);
  assertCursorSession(payload.cursorSessionId);
  const state = requireState(ctx, payload, true);
  assertRevision(state, payload.expectedRevision);
  requireProducer(ctx, payload);
  const before = state.revision;
  const accepted = payload.events.map((item) => appendInput(ctx, payload, state, item));
  trimEvents(ctx, state);
  saveState(ctx, state);
  if (state.revision !== before) touchMeta(ctx, state.chat_id, true);
  if (typeof payload.cursorSessionId === 'string' && payload.cursorSessionId) {
    // Legacy parity: a non-empty cursorSessionId replaces the stored one (even when every input was a duplicate).
    const changed = ctx.prepare('UPDATE chat_history_meta SET cursor_session_id = ? WHERE chat_id = ? AND cursor_session_id <> ?')
      .run(payload.cursorSessionId, state.chat_id, payload.cursorSessionId);
    if (Number(changed.changes) > 0) touchMeta(ctx, state.chat_id);
  }
  return { ...stateResult(state), accepted };
}

/** @param {unknown} value @returns {void} */
function assertCursorSession(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || Buffer.byteLength(value) > HISTORY_MAX_CURSOR_SESSION_BYTES) refuse('history_invalid_cursor_session');
}

/** @param {any} ctx @param {HistoryIdentity & {keepLast?:number, expectedRevision?:number}} payload @returns {any} */
function trim(ctx, payload) {
  const state = requireState(ctx, payload);
  if (!state) refuse('history_missing');
  assertRevision(state, payload.expectedRevision);
  const keepLast = payload.keepLast ?? HISTORY_RETENTION_LIMIT;
  if (!isCounter(keepLast) || keepLast > HISTORY_RETENTION_LIMIT) refuse('history_invalid_retention');
  if (state.revision >= MAX_COUNTER) refuse('history_counter_exhausted');
  const changedPolicy = state.retention_limit !== keepLast;
  state.retention_limit = keepLast;
  const removed = trimEvents(ctx, state);
  if (removed || changedPolicy) {
    state.revision += 1;
    touchMeta(ctx, state.chat_id);
  }
  saveState(ctx, state);
  return { ...stateResult(state), removed };
}

/** @param {any} ctx @param {HistoryIdentity & {newChatEpoch:string, newDatasetGeneration?:string, expectedRevision?:number}} payload @returns {any} */
function reset(ctx, payload) {
  const state = requireState(ctx, payload);
  if (!state) refuse('history_missing');
  assertRevision(state, payload.expectedRevision);
  const generation = payload.newDatasetGeneration ?? payload.datasetGeneration;
  if (!isIdentity(payload.newChatEpoch) || typeof generation !== 'string' || !DATASET_GENERATION_PATTERN.test(generation)
    || (generation === payload.datasetGeneration && payload.newChatEpoch === payload.chatEpoch)) refuse('history_invalid_reset');
  // Never reuse an epoch pair: doing so would make old revision cursors valid.
  const seen = ctx.prepare(`SELECT 1 FROM chat_history_epochs
    WHERE dataset_generation = ? AND chat_id = ? AND chat_epoch = ? LIMIT 1`).get(generation, payload.chatId, payload.newChatEpoch);
  if (seen) refuse('history_epoch_reused');
  ctx.prepare(`INSERT INTO chat_history_epochs (chat_id, dataset_generation, chat_epoch, created_at)
    VALUES (?, ?, ?, ?)`).run(payload.chatId, generation, payload.newChatEpoch, Date.now());
  ctx.prepare("UPDATE chat_history_producers SET status = 'fenced', retired_at = ? WHERE chat_id = ? AND status = 'active'").run(Date.now(), payload.chatId);
  ctx.prepare('DELETE FROM chat_history_events WHERE chat_id = ?').run(payload.chatId);
  // Event-level unknown keys belong to events that no longer exist; keeping them would re-attach them to new events of the same seq.
  ctx.prepare('DELETE FROM chat_history_event_extra WHERE chat_id = ?').run(payload.chatId);
  deleteChatStages(ctx, payload.chatId);
  touchMeta(ctx, payload.chatId);
  ctx.prepare(`UPDATE chat_history_state SET dataset_generation = ?, chat_epoch = ?, revision = 0,
    next_seq = 1, trimmed_through_seq = 0, updated_at = ? WHERE chat_id = ?`)
    .run(generation, payload.newChatEpoch, Date.now(), payload.chatId);
  return stateResult(readState(ctx, payload.chatId));
}

/** @param {any} ctx @param {HistoryIdentity & {producerId:string, mode?:string}} payload @returns {any} */
function retireProducer(ctx, payload) {
  const state = requireState(ctx, payload);
  if (!state) refuse('history_missing');
  if (!isIdentity(payload.producerId) || !['retired', 'fenced'].includes(payload.mode ?? 'retired')) refuse('history_invalid_producer');
  const row = ctx.prepare(`SELECT status FROM chat_history_producers
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ?`).get(payload.datasetGeneration, payload.chatId, payload.producerId);
  if (!row) {
    ctx.prepare(`INSERT INTO chat_history_producers (dataset_generation, chat_id, producer_id, chat_epoch, status, created_at, retired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(payload.datasetGeneration, payload.chatId, payload.producerId, payload.chatEpoch, payload.mode ?? 'retired', Date.now(), Date.now());
  } else if (row.status === 'active') {
    ctx.prepare(`UPDATE chat_history_producers SET status = ?, retired_at = ?
      WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ?`).run(payload.mode ?? 'retired', Date.now(), payload.datasetGeneration, payload.chatId, payload.producerId);
  }
  return { ...stateResult(state), producerId: payload.producerId, status: row?.status === 'active' || !row ? payload.mode ?? 'retired' : row.status };
}

/** @param {any} ctx @param {AppendPayload & {reviewed:boolean, reconciliationId:string}} payload @returns {any} */
function reconcileLegacyQueue(ctx, payload) {
  if (payload.reviewed !== true || !isIdentity(payload.reconciliationId) || !Array.isArray(payload.events)) refuse('history_reconciliation_required');
  if (payload.events.length < 1 || payload.events.length > HISTORY_MAX_APPEND_EVENTS
    || payload.events.some((item) => !item || !isValidSdkHistoryRecord(item.rec))) refuse('history_invalid_events');
  const prior = ctx.prepare(`SELECT 1 FROM chat_history_producers
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ?`).get(payload.datasetGeneration, payload.chatId, payload.producerId);
  if (prior) refuse('history_reconciliation_producer_reused');
  const events = payload.events.map((item, index) => ({
    clientSeq: index, rec: { ...item.rec, legacyClientSeq: item.clientSeq ?? null, reconciliationId: payload.reconciliationId },
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
  }));
  return { ...appendEvents(ctx, { ...payload, events }), reconciliationId: payload.reconciliationId, historicalDedupeCertain: false };
}

/** @param {any} ctx @param {HistoryIdentity & {producerId:string}} payload @returns {any} */
function reconnect(ctx, payload) {
  const state = requireState(ctx, payload);
  if (!state) refuse('history_missing');
  if (!isIdentity(payload.producerId)) refuse('history_reconciliation_required');
  const producer = ctx.prepare(`SELECT status, chat_epoch FROM chat_history_producers
    WHERE dataset_generation = ? AND chat_id = ? AND producer_id = ?`).get(payload.datasetGeneration, payload.chatId, payload.producerId);
  if (producer && (producer.status !== 'active' || producer.chat_epoch !== payload.chatEpoch)) refuse('history_producer_fenced');
  return { ...stateResult(state), producerId: payload.producerId };
}

/**
 * Per-command byte budget for the chat-history command payload. A
 * single-event command may carry a record up to HISTORY_MAX_RECORD_BYTES plus
 * the envelope allowance (P2-2); multi-event batches keep the 64 KiB budget.
 * Shared by the facade and the worker handler so both refuse identically.
 *
 * @param {unknown} payload
 * @returns {number}
 */
export function commandByteBudget(payload) {
  const events = payload && typeof payload === 'object' ? /** @type {any} */ (payload).events : undefined;
  return Array.isArray(events) && events.length === 1 ? HISTORY_MAX_SINGLE_EVENT_COMMAND_BYTES : HISTORY_MAX_COMMAND_BYTES;
}

/**
 * Dataset binding check run once at runtime start, before the store is READY:
 * the file must carry the immutable binding of exactly the generation the
 * control marker selected. A fresh empty store or another dataset's file is
 * refused, never adopted.
 * @param {any} ctx
 * @param {{datasetGeneration:string}} payload
 * @returns {{datasetGeneration:string}}
 */
function verifyDataset(ctx, payload) {
  if (!payload || typeof payload.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(payload.datasetGeneration)) refuse('history_reconciliation_required');
  const row = ctx.prepare('SELECT dataset_generation FROM storage_dataset_binding WHERE id = 1').get();
  if (!row) refuse('history_store_unbound');
  if (row.dataset_generation !== payload.datasetGeneration) refuse('history_generation_mismatch', { bound: row.dataset_generation });
  return { datasetGeneration: row.dataset_generation };
}

/** @param {any} ctx @param {string} chatId @returns {any|undefined} */
function readMeta(ctx, chatId) {
  return ctx.prepare('SELECT * FROM chat_history_meta WHERE chat_id = ?').get(chatId);
}

/** @param {any|undefined} meta @returns {boolean} */
function isDeleted(meta) {
  return Boolean(meta) && meta.deleted_at !== null && meta.deleted_at !== undefined;
}

/**
 * Metadata that travels with every read result (`cursorSessionId`, the
 * `updatedAt` string a legacy document would carry, tombstone flag).
 * @param {any} state @param {any|undefined} meta
 */
function metaResult(state, meta) {
  return {
    cursorSessionId: meta ? String(meta.cursor_session_id) : '',
    updatedAt: meta?.updated_at_raw ?? new Date(Number(state.updated_at)).toISOString(),
    deleted: isDeleted(meta),
  };
}

/** @param {any} ctx @param {HistoryIdentity & {anyEpoch?:boolean}} payload @returns {any|null} */
function readRevision(ctx, payload) {
  const state = requireState(ctx, payload);
  if (!state) return null;
  return { ...stateResult(state), ...metaResult(state, readMeta(ctx, state.chat_id)) };
}

/** @param {any} ctx @param {HistoryIdentity & {anyEpoch?:boolean, afterSeq?:number, beforeSeq?:number, limit?:number, byteBudget?:number}} payload @param {boolean} [latest] @returns {any} */
function readPage(ctx, payload, latest = false) {
  const state = requireState(ctx, payload);
  const limit = payload.limit ?? (latest ? 80 : 1000);
  const byteBudget = payload.byteBudget ?? HISTORY_READ_RESULT_BYTE_BUDGET;
  if (!isCounter(limit, 1) || limit > HISTORY_RETENTION_LIMIT
    || !isCounter(byteBudget, 1) || byteBudget > HISTORY_READ_RESULT_BYTE_BUDGET
    || (payload.afterSeq !== undefined && !isCounter(payload.afterSeq))
    || (payload.beforeSeq !== undefined && !isCounter(payload.beforeSeq, 1))) refuse('history_invalid_page');
  if (!state) return { datasetGeneration: payload.anyEpoch ? undefined : payload.datasetGeneration, chatId: payload.chatId, chatEpoch: payload.anyEpoch ? undefined : payload.chatEpoch,
    events: [], hasMore: false, revision: 0, headSeq: 0, trimmedThroughSeq: 0, oldestSeq: 0, cursorSessionId: '', deleted: false };
  const meta = readMeta(ctx, state.chat_id);
  if (isDeleted(meta)) {
    // A tombstone reads as a missing chat, but still reports the identity a new writer must use.
    return { ...stateResult(state), events: [], hasMore: false, headSeq: 0, oldestSeq: 0, cursorSessionId: '', deleted: true, updatedAt: '' };
  }
  const oldestSeq = Number(ctx.prepare('SELECT min(seq) AS seq FROM chat_history_events WHERE dataset_generation = ? AND chat_id = ?')
    .get(state.dataset_generation, state.chat_id).seq ?? 0);
  const backwards = latest || (payload.beforeSeq !== undefined && payload.afterSeq === undefined);
  const range = [state.dataset_generation, payload.chatId, payload.afterSeq ?? 0, payload.beforeSeq ?? Number.MAX_SAFE_INTEGER];
  const order = backwards ? 'DESC' : 'ASC';
  // Byte-budgeted pagination (P2-1). Pass 1 reads only sizes (UTF-8 length of
  // the stored JSON, which is embedded verbatim), so a 2000-row window of
  // large records is never materialised just to be cut. The page keeps whole
  // events in scan order until the next one would exceed the budget; the first
  // event is always returned (a single record is capped far below the budget).
  const sizes = ctx.prepare(`SELECT seq, length(CAST(payload_json AS BLOB)) AS bytes FROM chat_history_events
    WHERE dataset_generation = ? AND chat_id = ? AND seq > ? AND seq < ? ORDER BY seq ${order} LIMIT ?`).all(...range, limit + 1);
  let accumulatedBytes = 2;
  let count = 0;
  for (const size of sizes) {
    if (count >= limit) break;
    const next = accumulatedBytes + size.bytes + EVENT_WRAPPER_BYTES + 1;
    if (count > 0 && next > byteBudget) break;
    accumulatedBytes = next;
    count += 1;
  }
  const hasMore = sizes.length > count;
  const base = { ...stateResult(state), ...metaResult(state, meta), oldestSeq };
  if (count === 0) return { ...base, hasMore: false, events: [] };
  const edges = [sizes[0].seq, sizes[count - 1].seq];
  const rows = ctx.prepare(`SELECT * FROM chat_history_events WHERE dataset_generation = ? AND chat_id = ?
    AND seq >= ? AND seq <= ? ORDER BY seq ${order}`).all(state.dataset_generation, payload.chatId, Math.min(...edges), Math.max(...edges));
  const selected = rows.map((row) => ({
    seq: row.seq, rec: JSON.parse(row.payload_json), producerId: row.producer_id,
    clientSeq: row.client_seq, revision: row.revision, createdAt: row.created_at,
  }));
  if (backwards) selected.reverse();
  return { ...base, hasMore, events: selected };
}

/**
 * Specific retained events by seq (the stored, possibly coalesced, records),
 * truncated by bytes like `readPage`. Missing seqs are simply absent.
 * @param {any} ctx @param {HistoryIdentity & {anyEpoch?:boolean, seqs:number[]}} payload @returns {any}
 */
function readSeqs(ctx, payload) {
  const state = requireState(ctx, payload);
  if (!Array.isArray(payload.seqs) || payload.seqs.length < 1 || payload.seqs.length > HISTORY_READ_SEQS_MAX
    || !payload.seqs.every((seq) => isCounter(seq, 1))) refuse('history_invalid_page');
  if (!state) return { events: [], truncated: false };
  const wanted = [...new Set(payload.seqs)].sort((a, b) => a - b);
  const rows = ctx.prepare(`SELECT seq, producer_id, payload_json FROM chat_history_events
    WHERE dataset_generation = ? AND chat_id = ? AND seq IN (${wanted.map(() => '?').join(', ')}) ORDER BY seq`)
    .all(state.dataset_generation, state.chat_id, ...wanted);
  const events = [];
  let bytes = 2;
  let truncated = false;
  for (const row of rows) {
    bytes += Buffer.byteLength(row.payload_json) + EVENT_WRAPPER_BYTES + 1;
    if (events.length > 0 && bytes > HISTORY_READ_RESULT_BYTE_BUDGET) {
      truncated = true;
      break;
    }
    events.push({ seq: row.seq, rec: JSON.parse(row.payload_json), producerId: row.producer_id });
  }
  return { ...stateResult(state), events, truncated };
}

/**
 * Keyset-paged chat list (`headSeq` + legacy `updatedAt` string per chat);
 * tombstoned chats are skipped.
 * @param {any} ctx @param {{afterChatId?:string, limit?:number}} payload @returns {any}
 */
function listHeads(ctx, payload) {
  const limit = payload?.limit ?? HISTORY_LIST_PAGE_MAX;
  if (!isCounter(limit, 1) || limit > HISTORY_LIST_PAGE_MAX || (payload?.afterChatId !== undefined && typeof payload.afterChatId !== 'string')) refuse('history_invalid_page');
  const rows = ctx.prepare(`SELECT s.chat_id, s.next_seq, s.updated_at, m.updated_at_raw FROM chat_history_state s
    JOIN chat_history_meta m ON m.chat_id = s.chat_id
    WHERE m.deleted_at IS NULL AND s.chat_id > ? ORDER BY s.chat_id LIMIT ?`).all(payload?.afterChatId ?? '', limit + 1);
  const page = rows.slice(0, limit);
  return {
    chats: page.map((row) => ({
      chatId: row.chat_id, headSeq: row.next_seq - 1, updatedAt: row.updated_at_raw ?? new Date(Number(row.updated_at)).toISOString(),
    })),
    hasMore: rows.length > limit,
  };
}

/**
 * Usage/diagnostics summary computed inside the worker so the main thread
 * never loads a chat to answer it: counts come from SQL and only the small
 * `usage` / `context_usage` / `status` events are parsed.
 * @param {any} ctx @param {HistoryIdentity & {anyEpoch?:boolean}} payload @returns {any}
 */
function readUsage(ctx, payload) {
  const state = requireState(ctx, payload);
  const meta = state ? readMeta(ctx, state.chat_id) : undefined;
  if (!state || isDeleted(meta)) return { usageSummary: summarizeChatHistoryUsage([]), headSeq: 0, eventCount: 0, updatedAt: '' };
  const counts = ctx.prepare(`SELECT count(*) AS total,
    coalesce(sum(kind = 'localUser'), 0) AS local_user, coalesce(sum(kind = 'sdk'), 0) AS sdk
    FROM chat_history_events WHERE dataset_generation = ? AND chat_id = ?`).get(state.dataset_generation, state.chat_id);
  const events = ctx.prepare(`SELECT payload_json FROM chat_history_events
    WHERE dataset_generation = ? AND chat_id = ? AND kind = 'sdk'
      AND json_extract(payload_json, '$.event.type') IN ('usage', 'context_usage', 'status') ORDER BY seq`)
    .all(state.dataset_generation, state.chat_id).map((row) => ({ rec: JSON.parse(row.payload_json) }));
  return {
    usageSummary: { ...summarizeChatHistoryUsage(events), localUserCount: Number(counts.local_user), sdkEventCount: Number(counts.sdk) },
    headSeq: state.next_seq - 1,
    eventCount: Number(counts.total),
    updatedAt: metaResult(state, meta).updatedAt,
  };
}

/**
 * Tombstone a chat: events and event metadata go, producers are fenced, and the
 * chat moves to a new epoch so stale queues/runs are refused. Receipts and the
 * dedupe ledger stay (retries must not resurrect content). Legacy
 * `deleteChatHistory` parity: the chat reads as missing and leaves the list.
 * @param {any} ctx @param {{datasetGeneration:string, chatId:string, newChatEpoch:string}} payload @returns {any}
 */
function deleteChat(ctx, payload) {
  assertChatId(payload?.chatId);
  if (!isIdentity(payload.newChatEpoch)) refuse('history_invalid_reset');
  const state = readState(ctx, payload.chatId);
  if (!state) return { chatId: payload.chatId, deleted: false };
  ensureMeta(ctx, payload.chatId);
  if (isDeleted(readMeta(ctx, payload.chatId))) return { ...stateResult(state), deleted: false, alreadyDeleted: true };
  const seen = ctx.prepare(`SELECT 1 FROM chat_history_epochs WHERE dataset_generation = ? AND chat_id = ? AND chat_epoch = ? LIMIT 1`)
    .get(state.dataset_generation, payload.chatId, payload.newChatEpoch);
  if (seen) refuse('history_epoch_reused');
  const at = Date.now();
  ctx.prepare('INSERT INTO chat_history_epochs (chat_id, dataset_generation, chat_epoch, created_at) VALUES (?, ?, ?, ?)')
    .run(payload.chatId, state.dataset_generation, payload.newChatEpoch, at);
  ctx.prepare("UPDATE chat_history_producers SET status = 'fenced', retired_at = ? WHERE chat_id = ? AND status = 'active'").run(at, payload.chatId);
  ctx.prepare('DELETE FROM chat_history_events WHERE chat_id = ?').run(payload.chatId);
  ctx.prepare('DELETE FROM chat_history_event_extra WHERE chat_id = ?').run(payload.chatId);
  deleteChatStages(ctx, payload.chatId);
  ctx.prepare(`UPDATE chat_history_state SET chat_epoch = ?, revision = 0, next_seq = 1, trimmed_through_seq = 0, updated_at = ?
    WHERE chat_id = ?`).run(payload.newChatEpoch, at, payload.chatId);
  ctx.prepare(`UPDATE chat_history_meta SET cursor_session_id = '', doc_extra_json = '{}', updated_at_raw = NULL, deleted_at = ?
    WHERE chat_id = ?`).run(at, payload.chatId);
  return { ...stateResult(readState(ctx, payload.chatId)), deleted: true };
}

/**
 * Parsed legacy cut point of a partial fork: the index of the first event whose
 * `createdAt` is after the cutoff; unparsable stamps count as "before", an
 * unparsable cutoff disables the cut (same rules as chat-history-persist.js).
 * @param {Array<{created: unknown}>} rows @param {unknown} upToCreatedAt @returns {number}
 */
function resolveForkCut(rows, upToCreatedAt) {
  const cutoff = Date.parse(String(upToCreatedAt || ''));
  if (!Number.isFinite(cutoff)) return rows.length;
  for (let index = 0; index < rows.length; index += 1) {
    const stamp = Date.parse(String(rows[index].created || ''));
    if (Number.isFinite(stamp) && stamp > cutoff) return index;
  }
  return rows.length;
}

/**
 * Fork: copy a chat's retained events into `targetChatId` keeping `seq` and
 * `headSeq` and stripping the store/queue-added `clientSeq` of every record
 * (legacy `cloneHistoryEvents`). An existing target is replaced under the new
 * epoch (legacy overwrote the file). Content never crosses the thread boundary:
 * the copy is one `INSERT .. SELECT` bounded by HISTORY_MAX_COPY_BYTES.
 * @param {any} ctx
 * @param {{datasetGeneration:string, sourceChatId:string, targetChatId:string, targetChatEpoch:string, targetCursorSessionId?:string, upToCreatedAt?:string}} payload
 * @returns {any}
 */
function copyChat(ctx, payload) {
  assertChatId(payload?.sourceChatId);
  assertChatId(payload.targetChatId);
  if (payload.sourceChatId === payload.targetChatId) refuse('history_invalid_fork');
  if (!isIdentity(payload.targetChatEpoch) || typeof payload.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(payload.datasetGeneration)) refuse('history_invalid_fork');
  assertCursorSession(payload.targetCursorSessionId);
  const source = readState(ctx, payload.sourceChatId);
  const sourceLive = source && !isDeleted(readMeta(ctx, payload.sourceChatId));
  const rows = sourceLive ? ctx.prepare(`SELECT seq, json_extract(payload_json, '$.createdAt') AS created FROM chat_history_events
    WHERE dataset_generation = ? AND chat_id = ? ORDER BY seq`).all(source.dataset_generation, payload.sourceChatId) : [];
  const cut = payload.upToCreatedAt === undefined ? rows.length : resolveForkCut(rows, payload.upToCreatedAt);
  const copied = rows.slice(0, cut);
  const lastSeq = copied.length > 0 ? copied[copied.length - 1].seq : 0;
  // Full copy keeps the source headSeq (gaps from coalescing / trimming included); a partial one ends at the last copied seq.
  const headSeq = payload.upToCreatedAt === undefined ? (sourceLive ? source.next_seq - 1 : 0) : lastSeq;
  if (copied.length > 0) {
    const bytes = Number(ctx.prepare(`SELECT coalesce(sum(length(CAST(payload_json AS BLOB))), 0) AS bytes FROM chat_history_events
      WHERE dataset_generation = ? AND chat_id = ? AND seq <= ?`).get(source.dataset_generation, payload.sourceChatId, lastSeq).bytes);
    if (bytes > HISTORY_MAX_COPY_BYTES) refuse('history_copy_too_large', { bytes, maxBytes: HISTORY_MAX_COPY_BYTES });
  }
  const at = Date.now();
  const existing = readState(ctx, payload.targetChatId);
  const generation = existing ? existing.dataset_generation : payload.datasetGeneration;
  const seen = ctx.prepare('SELECT 1 FROM chat_history_epochs WHERE dataset_generation = ? AND chat_id = ? AND chat_epoch = ? LIMIT 1')
    .get(generation, payload.targetChatId, payload.targetChatEpoch);
  if (seen) refuse('history_epoch_reused');
  const trimmedThrough = copied.length > 0 ? copied[0].seq - 1 : headSeq;
  if (existing) {
    ctx.prepare("UPDATE chat_history_producers SET status = 'fenced', retired_at = ? WHERE chat_id = ? AND status = 'active'").run(at, payload.targetChatId);
    ctx.prepare('DELETE FROM chat_history_events WHERE chat_id = ?').run(payload.targetChatId);
    ctx.prepare('DELETE FROM chat_history_event_extra WHERE chat_id = ?').run(payload.targetChatId);
    deleteChatStages(ctx, payload.targetChatId);
    ctx.prepare(`UPDATE chat_history_state SET chat_epoch = ?, revision = ?, next_seq = ?, retention_limit = ?, trimmed_through_seq = ?, updated_at = ?
      WHERE chat_id = ?`).run(payload.targetChatEpoch, copied.length, headSeq + 1, HISTORY_RETENTION_LIMIT, trimmedThrough, at, payload.targetChatId);
  } else {
    ctx.prepare(`INSERT INTO chat_history_state
      (chat_id, dataset_generation, chat_epoch, revision, next_seq, retention_limit, trimmed_through_seq, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(payload.targetChatId, generation, payload.targetChatEpoch, copied.length, headSeq + 1, HISTORY_RETENTION_LIMIT, trimmedThrough, at);
  }
  ctx.prepare('INSERT INTO chat_history_epochs (chat_id, dataset_generation, chat_epoch, created_at) VALUES (?, ?, ?, ?)')
    .run(payload.targetChatId, generation, payload.targetChatEpoch, at);
  ctx.prepare(`INSERT OR IGNORE INTO chat_history_producers (dataset_generation, chat_id, producer_id, chat_epoch, status, created_at, retired_at)
    VALUES (?, ?, ?, ?, 'retired', ?, ?)`).run(generation, payload.targetChatId, HISTORY_FORK_PRODUCER_ID, payload.targetChatEpoch, at, at);
  if (copied.length > 0) {
    ctx.prepare(`INSERT INTO chat_history_events
      (dataset_generation, chat_id, seq, chat_epoch, producer_id, client_seq, kind, payload_json, created_at, revision)
      SELECT ?, ?, seq, ?, ?, 0, kind, json_remove(payload_json, '$.clientSeq'), created_at, row_number() OVER (ORDER BY seq)
      FROM chat_history_events WHERE dataset_generation = ? AND chat_id = ? AND seq <= ? ORDER BY seq`)
      .run(generation, payload.targetChatId, payload.targetChatEpoch, HISTORY_FORK_PRODUCER_ID, source.dataset_generation, payload.sourceChatId, lastSeq);
  }
  ensureMeta(ctx, payload.targetChatId);
  ctx.prepare(`UPDATE chat_history_meta SET cursor_session_id = ?, doc_extra_json = '{}', updated_at_raw = NULL, deleted_at = NULL
    WHERE chat_id = ?`).run(payload.targetCursorSessionId ?? '', payload.targetChatId);
  return { ...stateResult(readState(ctx, payload.targetChatId)), sourceChatId: payload.sourceChatId, copiedEvents: copied.length };
}

/** @param {any} handler @returns {any} */
function receiptCommand(handler) {
  const wrapped = withReceipt(handler);
  const command = function historyReceiptCommand(ctx, envelope) {
    if (envelope?.receipt?.datasetGeneration !== envelope?.payload?.datasetGeneration) refuse('history_receipt_generation_mismatch');
    if (toWireJson(envelope?.payload).bytes > commandByteBudget(envelope?.payload)) refuse('history_command_too_large');
    return wrapped(ctx, envelope);
  };
  Object.defineProperty(command, RECEIPT_HANDLER_MARK, { value: true });
  return command;
}

export const commands = Object.freeze(Object.fromEntries(Object.entries({ appendEvents, trim, reset, retireProducer, reconcileLegacyQueue, deleteChat, copyChat, stageFragment, abandonStage, gcSupersededStages })
  .map(([name, handler]) => [COMMAND_PREFIX + name, receiptCommand(handler)])));
export const queries = Object.freeze({
  ...RECEIPT_QUERIES,
  'history.verifyDataset': verifyDataset,
  'history.readRevision': readRevision,
  'history.reconnect': reconnect,
  'history.readPage': readPage,
  'history.readLatest': (ctx, payload) => readPage(ctx, payload, true),
  'history.readSeqs': readSeqs,
  'history.listHeads': listHeads,
  'history.listStages': listStages,
  'history.readUsage': readUsage,
});

/**
 * Bind the pilot to an already started worker host. No identity is generated
 * here: callers persist command/producer IDs before dispatch and retain their
 * pending content until the returned promise acknowledges COMMIT.
 * @param {{host:any, groupCommitter?:any, writeGate?: unknown}} options
 * @returns {any} Promise-based history commands and reads.
 */
export function createChatHistoryStore({ host, groupCommitter, writeGate } = /** @type {any} */ ({})) {
  if (!host || typeof host.query !== 'function') throw new TypeError('History store needs a worker host');
  const effectiveWriteGate = writeGate ?? host.writeGate;
  const write = async (operation, args) => {
    const { commandId, priority, deadlineMs, signal, error, operation: ignoredOperation, ...payload } = args;
    if (operation === 'deleteChat' || operation === 'abandonStage') assertChatId(payload.chatId);
    else if (operation === 'gcSupersededStages') {
      if (typeof payload.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(payload.datasetGeneration)) refuse('history_reconciliation_required');
    } else if (operation === 'copyChat') {
      assertChatId(payload.sourceChatId);
      assertChatId(payload.targetChatId);
    } else assertIdentity(payload);
    if (['appendEvents', 'reconcileLegacyQueue'].includes(operation) && !isIdentity(payload.producerId)) refuse('history_reconciliation_required');
    let bytes;
    try {
      bytes = toWireJson(payload).bytes;
    } catch (cause) {
      throw new StorageError('io', 'History command is not plain JSON', {
        cause, retryable: false, details: { operation: 'payload_invalid', commitState: 'not_committed', commandId },
      });
    }
    if (bytes > commandByteBudget(payload)) {
      return Promise.reject(new StorageError('conflict', 'History command exceeds the byte limit', {
        details: { operation: 'history', conflictKind: 'history_command_too_large', commitState: 'not_committed', commandId },
      }));
    }
    assertWriteAllowed(effectiveWriteGate);
    const request = { datasetGeneration: payload.datasetGeneration, commandId, name: COMMAND_PREFIX + operation, payload, priority, deadlineMs, signal, error, writeGate: effectiveWriteGate };
    return groupCommitter ? groupCommitter.submit(request) : executeCommand(host, request);
  };
  return Object.freeze({
    appendEvents: (args) => write('appendEvents', args),
    trim: (args) => write('trim', args),
    reset: (args) => write('reset', args),
    retireProducer: (args) => write('retireProducer', args),
    reconcileLegacyQueue: (args) => write('reconcileLegacyQueue', args),
    deleteChat: (args) => write('deleteChat', args),
    copyChat: (args) => write('copyChat', args),
    stageFragment: (args) => write('stageFragment', args),
    abandonStage: (args) => write('abandonStage', args),
    gcSupersededStages: (args) => write('gcSupersededStages', args),
    listStages: (args) => host.query('history.listStages', args),
    verifyDataset: (args) => host.query('history.verifyDataset', args),
    readSeqs: (args) => host.query('history.readSeqs', args),
    listHeads: (args) => host.query('history.listHeads', args),
    readUsage: (args) => host.query('history.readUsage', args),
    readPage: (args) => host.query('history.readPage', args),
    readLatest: (args) => host.query('history.readLatest', args),
    readRevision: (args) => host.query('history.readRevision', args),
    reconnect: (args) => host.query('history.reconnect', args),
    resolveUnknown: (args) => {
      const { commandId, priority, deadlineMs, signal, error, operation = 'appendEvents', ...payload } = args;
      return resolveUnknown(host, { datasetGeneration: payload.datasetGeneration, commandId, name: COMMAND_PREFIX + operation, payload, error });
    },
  });
}
