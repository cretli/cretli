/**
 * SQLite backend of the async history adapter (stage 2a). Every database call
 * goes through the worker-backed store (`createChatHistoryStore`); nothing here
 * opens SQLite, blocks on a worker or keeps a lock across an await.
 *
 * Write protocol (docs/storage-history-migration.md "Write path"):
 *   1. fix the identity: commandId, producerId and the producer-scoped
 *      clientSeq numbers;
 *   2. persist the command in the durable pending buffer (fsync) BEFORE dispatch;
 *   3. dispatch through the store (receipt-wrapped, group-commit capable);
 *   4. only the resolved promise is an ACK (the worker replied after COMMIT);
 *      then the pending entry is removed and `onCommitted` runs.
 * `unknown_commit` is reconciled by receipt lookup (`resolveUnknown`) with the
 * SAME command; an unreconcilable outcome leaves the entry pending and throws
 * `history_commit_unknown`. A restart calls `recoverPending()`, which replays
 * the persisted commands (a replay of a committed one is answered from its
 * receipt and cannot duplicate).
 *
 * A LOGICAL append that needs several store commands (chunks) is one durable
 * BATCH: every chunk entry (own `commandId`, pre-allocated `clientSeq` numbers,
 * epoch) is persisted before the first dispatch and the batch is acknowledged
 * as a whole only after its result was assembled, including the post-commit
 * `readStored`. Whatever fails in between leaves the plan pending and the
 * error carries `details.batchId`; the caller retries with
 * `callOptions.retryToken = batchId` (same inputs) and the adapter re-drives the
 * SAME commands: committed chunks are answered from their receipts, so the
 * logical append happens exactly once and allocates no new identity. A
 * definitive refusal after a prefix committed quarantines the rest and reports
 * the committed prefix (`history_batch_incomplete`, `resumable: false`).
 * Oversized or over-budget input is refused whole BEFORE anything is recorded.
 *
 * LARGE records (wire JSON above 256 KiB, up to HISTORY_MAX_LARGE_RECORD_BYTES) are ONE pending entry
 * (`appendLarge`, one fsync) whose dispatch expands into deterministic commands derived from its
 * commandId: bounded base64 fragments `<id>.f<i>` (staged, invisible as history) and one finalizing
 * `appendEvents` `<id>.z` that creates the event, verifies bytes/SHA-256 and drops the staging in one
 * receipt transaction. Retries therefore repeat identical commands and the record is created exactly once.
 *
 * Differences from the legacy file store, all deliberate (documented in
 * docs/storage-history-migration.md): inputs are deduplicated per producer, not
 * per chat; a stream delta merges only into the tail of the SAME producer; a
 * record over 3 MiB is refused with a typed error (256 KiB-3 MiB use the fragment protocol); a producer fenced by a
 * delete/reset cannot append (`history_producer_fenced`); a full-chat load has
 * an explicit byte cap with a typed refusal.
 */
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isValidSdkHistoryRecord } from './chat-history-validate.js';
import { summarizeChatHistoryUsage } from './chat-history-usage.js';
import { extendHistorySliceToStreamBoundary, readSdkHistoryStreamKind } from '../sdk/sdk-history-stream-coalesce.ts';
import { extendHistorySliceToTurnStart, isHistoryRunFragmentRecord, isUserTurnBoundaryRecord } from '../sdk/sdk-history-turn-window.ts';
import { DATASET_GENERATION_PATTERN } from '../storage/command-receipts.js';
import {
  HISTORY_MAX_COMMAND_BYTES, HISTORY_MAX_COPY_BYTES, HISTORY_MAX_CURSOR_SESSION_BYTES, HISTORY_MAX_RECORD_BYTES, HISTORY_READ_SEQS_MAX, commandByteBudget,
} from '../storage/chat-history-store.js';
import { toWireJson } from '../storage/worker-wire.js';
import { HISTORY_MAX_LARGE_RECORD_BYTES, planLargeRecord } from '../storage/history-large-record.js';
import { STORAGE_ERROR_CODES } from '../storage/errors.js';
import {
  HISTORY_PULL_MAX_LIMIT, HISTORY_TAIL_DEFAULT_LIMIT, buildChatNoticeItem, clampPullLimit,
} from './chat-history-adapter.js';
import { refuseHistory } from './chat-history-errors.js';
import { buildServerProducerId, isServerProducerId } from './history-pending-buffer.js';

export const DEFAULT_LOAD_MAX_BYTES = 32 * 1024 * 1024;
/** One logical append: at most this many events and record bytes (larger work must be split by the caller). */
export const HISTORY_BATCH_MAX_EVENTS = 1024;
export const HISTORY_BATCH_MAX_BYTES = 8 * 1024 * 1024;
/** Placeholder with the widest `clientSeq` so pre-validation measures the largest possible command. */
const WIDEST_CLIENT_SEQ = Number.MAX_SAFE_INTEGER - 1;
const CHUNK_BYTE_BUDGET = 56 * 1024;
/** Fragment commands in flight at once (a group committer folds them into few commits). */
const LARGE_FRAGMENT_CONCURRENCY = 6;
const OLDER_CHUNK = 250;
const COMMAND_ABBREVIATION = Object.freeze({ appendEvents: 'append', appendLarge: 'large', copyChat: 'copy', deleteChat: 'delete' });
const IDENTITY_CACHE_MAX = 512;

/** @param {unknown} error @returns {string | undefined} */
const conflictKindOf = (error) => /** @type {any} */ (error)?.details?.conflictKind;
/** @param {unknown} error @returns {boolean} */
const isUnknownCommit = (error) => /** @type {any} */ (error)?.code === STORAGE_ERROR_CODES.UNKNOWN_COMMIT || /** @type {any} */ (error)?.details?.commitState === 'unknown';
/** @param {unknown} error @returns {boolean} */
const isNotCommitted = (error) => /** @type {any} */ (error)?.details?.commitState === 'not_committed';
/** @param {unknown} error @returns {boolean} */
const isTransientRefusal = (error) => /** @type {any} */ (error)?.retryable === true && isNotCommitted(error);

/**
 * What a reader gets for a stored record: rows of a server producer carry an
 * adapter-allocated `clientSeq` that legacy server records never had.
 *
 * @param {string} producerId
 * @param {Record<string, unknown>} rec
 * @returns {Record<string, unknown>}
 */
export function presentHistoryRecord(producerId, rec) {
  if (!isServerProducerId(producerId) || !rec || typeof rec !== 'object' || !('clientSeq' in rec)) return rec;
  const { clientSeq, ...rest } = rec;
  return rest;
}

/**
 * @param {{
 *   store: ReturnType<import('../storage/chat-history-store.js').createChatHistoryStore>,
 *   datasetGeneration: string,
 *   pendingBuffer: ReturnType<import('./history-pending-buffer.js').createHistoryPendingBuffer>,
 *   producerId?: string,
 *   onCommitted?: (event: Record<string, unknown>) => void | Promise<void>,
 *   onHookError?: (error: unknown) => void,
 *   maxAttempts?: number,
 *   retryDelayMs?: number,
 *   loadMaxBytes?: number,
 * }} options
 */
export function createSqliteHistoryBackend(options) {
  const { store, pendingBuffer } = options;
  const { datasetGeneration } = options;
  if (!store || typeof store.appendEvents !== 'function') throw new TypeError('SQLite history backend needs a history store');
  if (!pendingBuffer || typeof pendingBuffer.record !== 'function') throw new TypeError('SQLite history backend needs a pending buffer');
  if (typeof datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(datasetGeneration)) throw new TypeError('A valid datasetGeneration is required');
  const defaultProducerId = options.producerId ?? buildServerProducerId({ runId: 'adapter', attemptId: randomUUID() });
  if (!isServerProducerId(defaultProducerId)) throw new TypeError('The default producer must be a server producer');
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const loadMaxBytes = options.loadMaxBytes ?? DEFAULT_LOAD_MAX_BYTES;
  const stats = { acked: 0, replayed: 0, ackCleanupFailures: 0, hookFailures: 0, quarantined: 0, batchesResumed: 0, cleanupUncertain: 0 };
  /** @type {Map<string, string>} chatId -> current epoch (legacy-semantic writes learn it from reads) */
  const epochs = new Map();

  /** @param {string} chatId @param {string | undefined} epoch */
  function rememberEpoch(chatId, epoch) {
    if (!epoch) return;
    epochs.delete(chatId);
    epochs.set(chatId, epoch);
    if (epochs.size > IDENTITY_CACHE_MAX) epochs.delete(epochs.keys().next().value);
  }

  /** @param {Record<string, unknown>} event */
  async function emitCommitted(event) {
    if (!options.onCommitted) return;
    try {
      await options.onCommitted(event);
    } catch (error) {
      // A notification failure never un-commits or fails an acknowledged write.
      stats.hookFailures += 1;
      options.onHookError?.(error);
    }
  }

  /** @param {string} chatId @returns {Record<string, unknown>} lenient (any-epoch) read identity */
  const lenient = (chatId) => ({ datasetGeneration, chatId, chatEpoch: 'any', anyEpoch: true });

  /** @param {string} chatId @param {string} chatEpoch @returns {Record<string, unknown>} strict read identity (a page of an epoch-pinned read) */
  const pinned = (chatId, chatEpoch) => ({ datasetGeneration, chatId, chatEpoch });

  /**
   * Per-chat identity a page was read under: callers (HTTP/WS handshake, browser queue) pin and compare it. A chat
   * that does not exist yet has none (`null`); the first write chooses its epoch exactly once.
   * @param {any} page @returns {{ datasetGeneration: string, chatEpoch: string, revision: number } | null}
   */
  const identityOf = (page) => (page && page.chatEpoch ? { datasetGeneration, chatEpoch: String(page.chatEpoch), revision: Number(page.revision) || 0 } : null);

  /** Multi-page reads restart (bounded) when the chat changed identity or revision between pages; they never mix contexts. */
  const READ_PIN_ATTEMPTS = 3;
  /** @param {string} chatId */
  const unstableRead = (chatId) => refuseHistory('history_read_unstable', 'The chat kept changing while it was read; retry the read', { chatId, attempts: READ_PIN_ATTEMPTS });
  /** @param {unknown} error @returns {boolean} the pinned epoch is no longer the chat's epoch */
  const isPinBroken = (error) => conflictKindOf(error) === 'history_stale_epoch';

  /**
   * Current epoch of a chat, or a fresh one for a chat that does not exist.
   * @param {string} chatId @param {boolean} refresh @returns {Promise<string>}
   */
  async function resolveEpoch(chatId, refresh) {
    if (!refresh && epochs.has(chatId)) return /** @type {string} */ (epochs.get(chatId));
    const state = /** @type {any} */ (await store.readRevision(lenient(chatId)));
    if (state && state.datasetGeneration !== datasetGeneration) {
      refuseHistory('history_generation_mismatch', 'The store holds this chat under another dataset generation', { chatId });
    }
    const epoch = state ? String(state.chatEpoch) : `ep.${randomUUID()}`;
    rememberEpoch(chatId, epoch);
    return epoch;
  }

  /**
   * Dispatch one persisted command until it is answered. Never touches the
   * pending buffer: the caller decides whether the entry is acknowledged, dropped
   * or quarantined.
   *
   * Returns the outcome, or throws either the store's definitive refusal
   * (`commitState: not_committed`) or `history_commit_unknown`.
   *
   * @param {import('./history-pending-buffer.js').PendingEntry} entry
   * @param {string} [priority]
   * @returns {Promise<{ result: any, replayed: boolean }>}
   */
  function dispatch(entry, priority) {
    return entry.operation === 'appendLarge' ? dispatchLarge(entry, priority) : dispatchCommand(entry.operation, entry.payload, entry.commandId, priority);
  }

  /**
   * The finalizing append of a large entry: its commandId and payload derive from the entry alone, so a retry,
   * a crash replay and a receipt lookup all address the same command.
   * @param {import('./history-pending-buffer.js').PendingEntry} entry
   */
  function largeCommands(entry) {
    const { event, ...base } = /** @type {any} */ (entry.payload);
    const plan = planLargeRecord(event.rec);
    const final = { commandId: `${entry.commandId}.z`, payload: { ...base, events: [{ clientSeq: event.clientSeq, large: plan.large }] } };
    return { base, event, plan, final };
  }

  /**
   * Drive a large record: stage every fragment (bounded concurrency, each its own idempotent command), then
   * finalize atomically. A retry first asks for the finalizing receipt so a completed record costs one query.
   * @param {import('./history-pending-buffer.js').PendingEntry} entry
   * @param {string} [priority]
   * @returns {Promise<{ result: any, replayed: boolean }>}
   */
  async function dispatchLarge(entry, priority) {
    const { base, event, plan, final } = largeCommands(entry);
    try {
      const resolved = await store.resolveUnknown({ ...final.payload, commandId: final.commandId, operation: 'appendEvents' });
      if (resolved.outcome === 'committed') return { result: resolved.result, replayed: true };
    } catch { /* an unreadable receipt lookup falls through to the normal, idempotent path */ }
    const { sha256, bytes: totalBytes, fragments: count } = plan.large;
    let next = 0;
    /** @type {unknown} */
    let failure;
    const lane = async () => {
      while (failure === undefined) {
        const index = next;
        next += 1;
        if (index >= count) return;
        try {
          await dispatchCommand('stageFragment', {
            datasetGeneration, chatId: base.chatId, chatEpoch: base.chatEpoch, producerId: base.producerId,
            clientSeq: event.clientSeq, index, count, totalBytes, sha256, data: plan.fragments[index],
          }, `${entry.commandId}.f${index}`, priority);
        } catch (error) {
          // An unknown commit outranks a clean refusal: the entry must stay pending either way, but the caller needs the token.
          if (failure === undefined || (error?.code === 'history_commit_unknown')) failure = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LARGE_FRAGMENT_CONCURRENCY, count) }, lane));
    if (failure !== undefined) throw failure;
    return dispatchCommand('appendEvents', final.payload, final.commandId, priority);
  }

  /**
   * @param {string} operation @param {Record<string, unknown>} payload @param {string} commandId @param {string} [priority]
   * @returns {Promise<{ result: any, replayed: boolean }>}
   */
  async function dispatchCommand(operation, payload, commandId, priority) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return /** @type {{ result: any, replayed: boolean }} */ (await store[operation]({ ...payload, commandId, ...(priority ? { priority } : {}) }));
      } catch (error) {
        lastError = error;
        if (isUnknownCommit(error)) {
          try {
            const resolved = await store.resolveUnknown({ ...payload, commandId, operation, error });
            if (resolved.outcome === 'committed') return { result: resolved.result, replayed: true };
            continue; // proven not committed: the same command may be retried
          } catch (resolveError) {
            refuseHistory('history_commit_unknown', 'The commit outcome could not be determined; the command stays pending', {
              commandId, cause: /** @type {any} */ (resolveError)?.code ?? 'unknown',
            });
          }
        }
        if (isTransientRefusal(error) && attempt < maxAttempts) {
          await delay(retryDelayMs * attempt);
          continue;
        }
        break;
      }
    }
    if (isNotCommitted(lastError)) throw lastError;
    // Neither committed nor refused with certainty: keep it pending, escalate.
    return refuseHistory('history_commit_unknown', 'The command failed without a known commit state; it stays pending', {
      commandId, cause: /** @type {any} */ (lastError)?.code ?? 'unknown',
    });
  }

  /** Acknowledge entries; a cleanup failure is harmless because a replay is answered from the receipt. */
  async function ackEntries(entries) {
    stats.acked += entries.length;
    try {
      await pendingBuffer.ackMany(entries.map((entry) => entry.commandId));
    } catch {
      stats.ackCleanupFailures += 1;
    }
  }

  /**
   * Remove a plan that is KNOWN not to have committed and whose failure is about to be reported to the caller.
   * The refusal may only be returned after the discard is durable: a swallowed cleanup error would let a restart
   * replay a command the caller was told had failed. `mode: 'quarantine'` keeps the entries for an operator.
   * Entries go lowest index first, so once index 0 is gone the remainder can never replay (recovery treats a
   * suffix as already finished); leftovers of such a partial cleanup are harmless and only counted.
   *
   * @param {import('./history-pending-buffer.js').PendingEntry[]} entries
   * @param {'ack' | 'quarantine'} mode @param {string} reason
   * @returns {Promise<{ durable: boolean, replayable: boolean, cause?: string }>}
   */
  async function discardKnownNotCommitted(entries, mode, reason) {
    const ids = entries.map((entry) => entry.commandId);
    try {
      if (mode === 'quarantine') await pendingBuffer.quarantineMany(ids, reason);
      else await pendingBuffer.ackMany(ids);
      return { durable: true, replayable: false };
    } catch (cause) {
      const replayable = pendingBuffer.get(ids[0]) !== null;
      if (!replayable) stats.ackCleanupFailures += 1;
      return { durable: false, replayable, cause: /** @type {any} */ (cause)?.code ?? 'cleanup_failed' };
    }
  }

  /** Receipt lookup of a command this adapter has pending (never an ACK for a different generation). Read-only. */
  async function lookupReceipt({ commandId }) {
    const entry = pendingBuffer.get(commandId);
    if (!entry) return { outcome: 'not_pending' };
    if (entry.payload.datasetGeneration !== datasetGeneration) return { outcome: 'stale_generation' };
    if (entry.operation === 'appendLarge') {
      const { final } = largeCommands(entry);
      return store.resolveUnknown({ ...final.payload, commandId: final.commandId, operation: 'appendEvents' });
    }
    return store.resolveUnknown({ ...entry.payload, commandId, operation: entry.operation });
  }

  /**
   * Cleanup of a not-committed plan could not be made durable and the plan is still replayable: tell the caller
   * explicitly (same token / commandId, plan kept) instead of reporting a failure that a restart could undo.
   * @param {Record<string, unknown>} identity `{ batchId, retryToken, ... }` or `{ commandId, retryToken, ... }`
   * @param {unknown} refusal the definitive refusal that triggered the discard @param {string | undefined} cause
   */
  function cleanupUncertain(identity, refusal, cause) {
    stats.cleanupUncertain += 1;
    return refuseHistory('history_cleanup_uncertain', 'The command did not commit, but its pending record could not be discarded; it may still be replayed. Retry with the same retryToken to finish or abandon it', {
      ...identity, commitState: 'uncertain', resumable: true, cleanup: 'failed', cause: cause ?? 'cleanup_failed',
      refusedWith: /** @type {any} */ (refusal)?.code ?? 'refused',
    });
  }

  /**
   * One stand-alone command (copy/delete): record, dispatch, acknowledge. With `retryToken` (the commandId of an
   * earlier uncertain attempt of the SAME operation and chat) the recorded command is re-driven, never re-recorded.
   *
   * @param {'appendEvents' | 'copyChat' | 'deleteChat'} operation
   * @param {string} chatId @param {string} producerId @param {Record<string, unknown>} payload @param {string} [retryToken]
   */
  async function executeDurably(operation, chatId, producerId, payload, retryToken) {
    let entry;
    if (retryToken !== undefined) {
      entry = pendingBuffer.get(retryToken);
      if (!entry || entry.batch) refuseHistory('history_batch_unknown', 'No pending command has this retry token (it completed, was dropped or was quarantined)', { retryToken });
      const sameTarget = entry.operation === operation && entry.chatId === chatId
        && (operation !== 'copyChat' || entry.payload.sourceChatId === payload.sourceChatId);
      if (!sameTarget) refuseHistory('history_batch_mismatch', 'The retry call differs from the recorded command', { retryToken });
    } else {
      const commandId = `hist.${COMMAND_ABBREVIATION[operation]}.${randomUUID()}`;
      entry = await pendingBuffer.record({ commandId, producerId, operation, chatId, payload: { ...payload, datasetGeneration } });
    }
    const commandId = entry.commandId;
    let outcome;
    try {
      outcome = await dispatch(entry);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'history_commit_unknown') {
        throw Object.assign(error, { details: { ...error.details, commandId, retryToken: commandId, resumable: true } });
      }
      if (isNotCommitted(error)) {
        // Known not to have committed: the entry is dropped durably BEFORE the caller hears "failed".
        const discard = await discardKnownNotCommitted([entry], 'ack', 'refused');
        if (!discard.durable && discard.replayable) cleanupUncertain({ commandId, retryToken: commandId, operation }, error, discard.cause);
      }
      throw error;
    }
    await ackEntries([entry]);
    return { ...outcome, commandId };
  }

  /**
   * Error that tells the caller how to find the committed prefix of a batch.
   * @param {string} code @param {string} message @param {import('./history-pending-buffer.js').PendingEntry[]} entries
   * @param {number} committedChunks @param {Record<string, unknown>} extra
   */
  function batchError(code, message, entries, committedChunks, extra) {
    const batch = /** @type {import('./history-pending-buffer.js').PendingBatch} */ (entries[0].batch);
    return refuseHistory(code, message, { batchId: batch.id, retryToken: batch.id, committedChunks, totalChunks: batch.count, ...extra });
  }

  /**
   * Handle a chunk failure of a batch and ALWAYS throw.
   * @param {import('./history-pending-buffer.js').PendingEntry[]} entries @param {number} index
   * @param {any} error @param {{ accepted: any[], headSeq: number, chatId: string }} progress
   */
  async function failBatch(entries, index, error, progress) {
    if (conflictKindOf(error) === 'history_stale_epoch') epochs.delete(progress.chatId);
    if (error?.code === 'history_commit_unknown') {
      throw Object.assign(error, { details: { ...error.details, batchId: entries[0].batch?.id, retryToken: entries[0].batch?.id, committedChunks: index, totalChunks: entries.length, resumable: true } });
    }
    if (!isNotCommitted(error)) throw error;
    // `committedEvents` = input events inside the committed chunks, so a caller can ACK exactly that prefix of its
    // retained input (a non-resumable partial failure) without guessing how the adapter chunked it.
    const committedEvents = entries.slice(0, index).reduce((sum, entry) => sum + /** @type {any[]} */ (entry.payload.events ?? [entry.payload.event]).length, 0);
    const batchIdentity = { batchId: entries[0].batch?.id, retryToken: entries[0].batch?.id, committedChunks: index, committedEvents, totalChunks: entries.length };
    if (index === 0) {
      // Nothing of the batch committed and the caller is told it failed: the plan must be gone durably before that.
      const discard = await discardKnownNotCommitted(entries, 'ack', 'refused');
      if (!discard.durable && discard.replayable) cleanupUncertain(batchIdentity, error, discard.cause);
      throw error;
    }
    const committed = { acceptedSeqs: progress.accepted.map((entry) => entry.seq), headSeq: progress.headSeq, cause: error?.code ?? 'refused', conflictKind: conflictKindOf(error) };
    if (isTransientRefusal(error)) {
      throw batchError('history_batch_incomplete', 'A prefix of the batch committed; retry with the same retryToken to finish it', entries, index, { ...committed, committedEvents, resumable: true });
    }
    stats.quarantined += 1;
    const discard = await discardKnownNotCommitted(entries, 'quarantine', String(committed.conflictKind ?? committed.cause));
    if (!discard.durable && discard.replayable) {
      // The rest "can never apply" only once it is out of the replay set; until then the committed prefix and the plan are kept.
      throw batchError('history_batch_incomplete', 'A prefix of the batch committed and the rest was refused, but the plan could not be quarantined; retry with the same retryToken to finish the cleanup', entries, index, {
        ...committed, committedEvents, resumable: true, cleanup: 'failed', cleanupCause: discard.cause,
      });
    }
    throw batchError('history_batch_incomplete', 'A prefix of the batch committed and the rest can never apply', entries, index, { ...committed, committedEvents, resumable: false });
  }

  /**
   * Drive a recorded batch to completion: dispatch every chunk in order (a chunk
   * that already committed is answered from its receipt), read back the stored
   * records, and only then acknowledge the whole plan.
   *
   * @param {import('./history-pending-buffer.js').PendingEntry[]} entries
   * @param {{ chatId: string, epoch: string, producerId: string, priority?: string, events: Array<{ clientSeq: number, rec: Record<string, unknown> }> }} plan
   */
  async function driveAppendBatch(entries, plan) {
    const { priority } = plan;
    const accepted = [];
    const receipts = [];
    let replayed = false;
    let headSeq = 0;
    for (const [index, entry] of entries.entries()) {
      let outcome;
      try {
        outcome = await dispatch(entry, priority);
      } catch (error) {
        await failBatch(entries, index, error, { accepted, headSeq, chatId: plan.chatId });
        throw error;
      }
      accepted.push(...outcome.result.accepted);
      headSeq = outcome.result.headSeq;
      replayed = replayed || outcome.replayed;
      receipts.push({ commandId: entry.commandId, datasetGeneration, chatEpoch: plan.epoch, producerId: plan.producerId, revision: outcome.result.revision });
    }
    let stored;
    try {
      stored = await readStored(plan.chatId, plan.epoch, accepted);
    } catch (cause) {
      const code = /** @type {any} */ (cause)?.code ?? 'unknown';
      const base = { commitState: 'committed', acceptedSeqs: accepted.map((entry) => entry.seq), headSeq, cause: code };
      if (conflictKindOf(cause) === 'history_stale_epoch') {
        // The chat was reset/replaced AFTER the plan committed: the read-back can never succeed under the old epoch and a
        // retry would loop forever. The plan is fully committed (so it is acknowledged), the failure is terminal and the
        // caller learns the new identity on its next read.
        epochs.delete(plan.chatId);
        await ackEntries(entries);
        return batchError('history_committed_readback_failed', 'The append committed but the chat moved to a new epoch before it could be read back', entries, entries.length, {
          ...base, cause: 'history_stale_epoch', retryToken: undefined, resumable: false,
        });
      }
      if (code === 'history_seq_missing') {
        // The store answered completely and an accepted seq is gone (concurrent retention/reset): a retry cannot recover it,
        // so the fully committed plan is acknowledged and the loss is reported, never papered over with the input record.
        await ackEntries(entries);
        return batchError('history_committed_readback_failed', 'The append committed but an accepted record is no longer stored', entries, entries.length, {
          ...base, retryToken: undefined, resumable: false, missingSeqs: /** @type {any} */ (cause).details?.missingSeqs,
        });
      }
      // Every chunk committed but the result could not be assembled: the plan stays pending, the retry re-reads.
      return batchError('history_committed_readback_failed', 'The append committed but its stored records could not be read back; retry with the same retryToken', entries, entries.length, { ...base, resumable: true });
    }
    await ackEntries(entries);
    const appended = accepted.map((entry) => {
      const row = /** @type {{ rec: Record<string, unknown>, producerId: string }} */ (stored.get(entry.seq));
      return { seq: entry.seq, rec: presentHistoryRecord(row.producerId, row.rec) };
    });
    // Several inputs coalesced into one event are reported once, like the legacy `appended` list.
    const seen = new Set();
    const distinct = appended.filter((row) => (seen.has(row.seq) ? false : (seen.add(row.seq), true)));
    const result = { ok: true, headSeq, appended: distinct, committed: true, replayed, receipts, duplicates: accepted.filter((entry) => entry.duplicate).length, identity: { datasetGeneration, chatEpoch: plan.epoch } };
    await emitCommitted({ operation: 'append', chatId: plan.chatId, headSeq, appended: distinct, replayed, receipts });
    return result;
  }

  /** @param {Array<{ clientSeq: number, rec: Record<string, unknown> }>} events @returns {Array<typeof events>} */
  function chunkEvents(events) {
    /** @type {Array<typeof events>} */
    const chunks = [];
    let current = [];
    let bytes = 0;
    for (const event of events) {
      const size = Buffer.byteLength(JSON.stringify(event.rec)) + 64;
      if (current.length > 0 && (bytes + size > CHUNK_BYTE_BUDGET || current.length >= 128 || size > CHUNK_BYTE_BUDGET)) {
        chunks.push(current);
        current = [];
        bytes = 0;
      }
      current.push(event);
      bytes += size;
      if (size > CHUNK_BYTE_BUDGET) {
        chunks.push(current);
        current = [];
        bytes = 0;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  /**
   * Stored (possibly coalesced) records for ALL accepted seqs. `readSeqs` truncates its answer by bytes, so each
   * page is re-requested for the seqs it did not return until none are left (every round must make progress).
   * A seq the store no longer holds (retention, reset) is never synthesised from the input: the call throws
   * `history_seq_missing` / `history_readback_no_progress`.
   * @param {string} chatId @param {string} epoch @param {Array<{ seq: number }>} accepted
   * @returns {Promise<Map<number, { rec: Record<string, unknown>, producerId: string }>>}
   */
  async function readStored(chatId, epoch, accepted) {
    /** @type {Map<number, { rec: Record<string, unknown>, producerId: string }>} */
    const found = new Map();
    const seqs = [...new Set(accepted.map((item) => item.seq))].sort((a, b) => a - b);
    for (let offset = 0; offset < seqs.length; offset += HISTORY_READ_SEQS_MAX) {
      let wanted = seqs.slice(offset, offset + HISTORY_READ_SEQS_MAX);
      while (wanted.length > 0) {
        const page = /** @type {any} */ (await store.readSeqs({ datasetGeneration, chatId, chatEpoch: epoch, seqs: wanted }));
        const returned = new Set();
        for (const event of page.events) {
          if (!wanted.includes(event.seq)) continue;
          found.set(event.seq, { rec: event.rec, producerId: event.producerId });
          returned.add(event.seq);
        }
        const rest = wanted.filter((seq) => !returned.has(seq));
        if (rest.length === 0) break;
        if (page.truncated !== true) refuseHistory('history_seq_missing', 'An accepted seq is no longer stored (retention or reset)', { missingSeqs: rest.slice(0, 16), missing: rest.length });
        if (returned.size === 0) refuseHistory('history_readback_no_progress', 'The read-back made no progress', { remaining: rest.length });
        wanted = rest;
      }
    }
    return found;
  }

  /**
   * Whole-input checks that run before ANY identity is allocated or recorded, so
   * an input the store would refuse part way is refused atomically up front.
   * @param {Array<{ rec: Record<string, unknown> }>} valid @param {string} cursorSessionId
   * @returns {Set<number>} positions whose record needs the fragment protocol (stored size above the regular cap)
   */
  function prevalidateAppend(valid, cursorSessionId) {
    if (typeof cursorSessionId === 'string' && Buffer.byteLength(cursorSessionId) > HISTORY_MAX_CURSOR_SESSION_BYTES) {
      refuseHistory('history_invalid_cursor_session', 'The cursor session id is too long', { commitState: 'not_committed', conflictKind: 'history_invalid_cursor_session' });
    }
    if (valid.length > HISTORY_BATCH_MAX_EVENTS) {
      refuseHistory('history_batch_too_large', 'One append may carry at most HISTORY_BATCH_MAX_EVENTS events; split it', { commitState: 'not_committed', conflictKind: 'history_batch_too_large', events: valid.length, maxEvents: HISTORY_BATCH_MAX_EVENTS });
    }
    let total = 0;
    /** @type {Set<number>} */
    const large = new Set();
    valid.forEach((item, position) => {
      const bytes = toWireJson({ ...item.rec, clientSeq: WIDEST_CLIENT_SEQ }).bytes;
      if (bytes > HISTORY_MAX_LARGE_RECORD_BYTES) {
        refuseHistory('history_record_too_large', 'A record exceeds the large-record limit; nothing was appended', { commitState: 'not_committed', conflictKind: 'history_record_too_large', position, bytes, maxBytes: HISTORY_MAX_LARGE_RECORD_BYTES });
      }
      if (bytes > HISTORY_MAX_RECORD_BYTES) large.add(position);
      total += bytes;
    });
    if (total > HISTORY_BATCH_MAX_BYTES) {
      refuseHistory('history_batch_too_large', 'One append may carry at most HISTORY_BATCH_MAX_BYTES of records; split it', { commitState: 'not_committed', conflictKind: 'history_batch_too_large', bytes: total, maxBytes: HISTORY_BATCH_MAX_BYTES });
    }
    return large;
  }

  /**
   * Commands of one logical append, in event order: regular chunks (`appendEvents`) and one `appendLarge` per
   * record that needs the fragment protocol. Chunks are size-checked by the caller with the widest `clientSeq`.
   * @param {{ chatId: string, epoch: string, producerId: string, cursorSessionId: string, coalesce: boolean }} identity
   * @param {Array<{ clientSeq: number, rec: Record<string, unknown> }>} events
   * @param {Set<number>} largePositions positions (in `events`) of large records
   * @returns {Array<{ operation: 'appendEvents' | 'appendLarge', payload: Record<string, unknown> }>}
   */
  function buildCommands(identity, events, largePositions) {
    const common = {
      chatId: identity.chatId, chatEpoch: identity.epoch, producerId: identity.producerId, coalesce: identity.coalesce,
      ...(identity.cursorSessionId ? { cursorSessionId: identity.cursorSessionId } : {}), datasetGeneration,
    };
    /** @type {Array<{ operation: 'appendEvents' | 'appendLarge', payload: Record<string, unknown> }>} */
    const commands = [];
    /** @type {typeof events} */
    let run = [];
    const flush = () => {
      for (const chunk of chunkEvents(run)) commands.push({ operation: 'appendEvents', payload: { ...common, events: chunk } });
      run = [];
    };
    events.forEach((event, position) => {
      if (!largePositions.has(position)) {
        run.push(event);
        return;
      }
      flush();
      commands.push({ operation: 'appendLarge', payload: { ...common, event: { clientSeq: event.clientSeq, rec: event.rec } } });
    });
    flush();
    return commands;
  }

  /**
   * One JSON round trip per item (`toJSON`/getters run once): the copy keeps unknown keys, own `__proto__` keys and
   * lone surrogates exactly as the wire would. Non-object items are dropped as before; a record that is not plain
   * JSON data (cycle, BigInt, function, Map/Set) is refused explicitly before anything is recorded.
   * @param {unknown} items @returns {Array<{ rec: Record<string, unknown>, clientSeq?: number }>}
   */
  function snapshotAppendItems(items) {
    if (!Array.isArray(items)) return [];
    const copies = [];
    items.forEach((item, position) => {
      if (!item || typeof item !== 'object') return;
      try {
        const clientSeq = typeof item.clientSeq === 'number' ? item.clientSeq : undefined;
        const rec = JSON.parse(toWireJson(item.rec === undefined ? null : item.rec).json);
        copies.push(clientSeq === undefined ? { rec } : { rec, clientSeq });
      } catch (error) {
        refuseHistory('history_record_unserializable', 'A record is not plain JSON data; nothing was appended', { commitState: 'not_committed', conflictKind: 'history_record_unserializable', position, reason: String(/** @type {Error} */ (error)?.message ?? error).slice(0, 120) });
      }
    });
    return copies;
  }

  /** @param {unknown} value @returns {string} */
  const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  /**
   * Append (legacy contract `appendChatHistoryEvents`) with explicit producer
   * identity. Server writes pass nothing special (`options.producerId` selects a
   * run/attempt producer); a browser queue replay passes `queueProducerId` and
   * numeric `clientSeq` per item. An item with a `clientSeq` but no queue
   * producer is a legacy un-namespaced input: it is REFUSED (never replayed
   * automatically); the caller must run an explicit reconciliation.
   *
   * Retry contract (the API stage 2b callers use): when the call throws an error
   * whose `details.retryToken` is set (`history_commit_unknown`,
   * `history_batch_incomplete` with `resumable`, `history_committed_readback_failed`),
   * the append may be partly or wholly committed. Keep the inputs and call again
   * with `callOptions.retryToken` set to that token until it returns `ok` or a
   * non-resumable error; the adapter re-drives the SAME recorded commands and
   * allocates no new commandId/clientSeq/epoch. Without a token a repeated call
   * is a NEW append.
   *
   * @param {string} chatId
   * @param {string} cursorSessionId
   * @param {Array<{ rec: Record<string, unknown>, clientSeq?: number }>} items
   * @param {{ producerId?: string, queueProducerId?: string, datasetGeneration?: string, chatEpoch?: string, coalesce?: boolean, retryToken?: string, priority?: string }} [callOptions]
   *   `chatEpoch` pins the epoch the caller knows (a browser queue): a stale one is refused, never refreshed.
   */
  async function appendChatHistoryEvents(chatId, cursorSessionId, items, callOptions = {}) {
    // Own immutable copy of the wire input, taken before the FIRST await: validation, digest, size checks, pending
    // entries, dispatch, receipts and recovery all see exactly these bytes whatever the caller does afterwards.
    const valid = snapshotAppendItems(items).filter((item) => isValidSdkHistoryRecord(item.rec));
    const queueProducerId = callOptions.queueProducerId;
    const named = valid.filter((item) => typeof item.clientSeq === 'number');
    if (queueProducerId === undefined && named.length > 0) {
      return { ok: false, code: 'history_unnamespaced_input', error: 'Inputs carrying a clientSeq need a queue producer identity' };
    }
    if (queueProducerId !== undefined && (isServerProducerId(queueProducerId) || named.length !== valid.length)) {
      return { ok: false, code: 'history_unnamespaced_input', error: 'A queue replay needs a non-server producer and a clientSeq on every input' };
    }
    if (queueProducerId !== undefined && (callOptions.datasetGeneration === undefined || callOptions.chatEpoch === undefined)) {
      // A queue replay must pin BOTH identities it was built against: the adapter never learns them from the write.
      refuseHistory('history_stale_client_identity', 'A queue replay must carry the dataset generation and chat epoch it was built against; nothing was appended', { commitState: 'not_committed', conflictKind: 'history_stale_epoch' });
    }
    if (callOptions.datasetGeneration !== undefined && callOptions.datasetGeneration !== datasetGeneration) {
      // The marker-owned current generation is authoritative: a queue built for another one is refused, never attached.
      refuseHistory('history_stale_client_identity', 'The queue was built for another dataset generation; nothing was appended', { commitState: 'not_committed', conflictKind: 'history_stale_epoch' });
    }
    const producerId = queueProducerId ?? callOptions.producerId ?? defaultProducerId;
    if (queueProducerId === undefined && !isServerProducerId(producerId)) {
      return { ok: false, code: 'history_unnamespaced_input', error: 'Server writes need a server producer identity' };
    }
    if (valid.length === 0 && callOptions.retryToken === undefined) {
      const state = /** @type {any} */ (await store.readRevision(lenient(chatId)));
      return { ok: true, headSeq: state && !state.deleted ? state.headSeq : 0, appended: [], committed: true, replayed: false, receipts: [] };
    }
    const largePositions = prevalidateAppend(valid, cursorSessionId);
    const coalesce = callOptions.coalesce !== false;
    const digest = digestOf({ chatId, producerId, coalesce, cursorSessionId: cursorSessionId || '', recs: valid.map((item) => [item.rec, item.clientSeq ?? null]) });
    if (callOptions.retryToken !== undefined) return resumeAppendBatch(chatId, callOptions.retryToken, digest, producerId, callOptions.priority);
    let autoEpoch = callOptions.chatEpoch === undefined;
    for (let round = 0; ; round += 1) {
      const epoch = callOptions.chatEpoch ?? await resolveEpoch(chatId, round > 0);
      const identity = { chatId, epoch, producerId, cursorSessionId: cursorSessionId || '', coalesce };
      // Size-check every chunk with the widest clientSeq BEFORE a number is reserved or anything is recorded.
      const probe = valid.map((item) => ({ clientSeq: WIDEST_CLIENT_SEQ, rec: item.rec }));
      for (const { operation, payload } of buildCommands(identity, probe, largePositions)) {
        if (operation !== 'appendEvents') continue;
        const bytes = toWireJson(payload).bytes;
        if (bytes > commandByteBudget(payload)) {
          refuseHistory('history_record_too_large', 'A chunk exceeds the command byte limit; nothing was appended', { commitState: 'not_committed', conflictKind: 'history_command_too_large', bytes, maxBytes: commandByteBudget(payload) });
        }
      }
      /** @type {Array<{ clientSeq: number, rec: Record<string, unknown> }>} */
      let events;
      if (queueProducerId === undefined) {
        const first = await pendingBuffer.reserveClientSeq(producerId, valid.length);
        events = valid.map((item, index) => ({ clientSeq: first + index, rec: item.rec }));
      } else {
        events = valid.map((item) => ({ clientSeq: /** @type {number} */ (item.clientSeq), rec: item.rec }));
      }
      const commands = buildCommands(identity, events, largePositions);
      const batchId = `hist.batch.${randomUUID()}`;
      const entries = await pendingBuffer.recordMany(commands.map(({ operation, payload }, index) => ({
        commandId: `hist.${COMMAND_ABBREVIATION[operation]}.${randomUUID()}`, producerId, operation, chatId, payload,
        batch: { id: batchId, index, count: commands.length, digest },
      })));
      try {
        return await driveAppendBatch(entries, { chatId, epoch, producerId, events, priority: callOptions.priority });
      } catch (error) {
        if (conflictKindOf(error) === 'history_stale_epoch' && autoEpoch && round < 2) {
          // The chat moved to a new epoch (delete/reset/fork) between the read and the write: nothing committed (a first-chunk
          // refusal drops the whole plan), learn the new identity.
          epochs.delete(chatId);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Retry of a recorded batch (see `appendChatHistoryEvents`).
   * @param {string} chatId @param {string} token @param {string} digest @param {string} producerId
   */
  async function resumeAppendBatch(chatId, token, digest, producerId, priority) {
    const entries = pendingBuffer.listBatch(token);
    const batch = entries[0]?.batch;
    if (!batch || entries.length !== batch.count || entries.some((entry, index) => entry.batch?.index !== index)) {
      refuseHistory('history_batch_unknown', 'No complete pending batch has this retry token (it completed, was dropped or was quarantined)', { retryToken: token });
    }
    if (batch.digest !== digest || entries[0].chatId !== chatId) {
      refuseHistory('history_batch_mismatch', 'The retry inputs differ from the recorded batch', { retryToken: token });
    }
    stats.batchesResumed += 1;
    const events = entries.flatMap((entry) => /** @type {any[]} */ (entry.payload.events ?? [entry.payload.event]));
    return driveAppendBatch(entries, { chatId, epoch: String(entries[0].payload.chatEpoch), producerId, events, priority });
  }

  /**
   * Server-authored watcher notice (same record as the legacy `appendChatNotice`).
   * @param {string} chatId @param {string} text @param {Record<string, unknown>} [meta]
   */
  async function appendChatNotice(chatId, text, meta = {}) {
    const item = buildChatNoticeItem(text, meta);
    if (!item) return { ok: false, error: 'Empty notice' };
    return appendChatHistoryEvents(chatId, '', [item]);
  }

  /** @param {Array<{ seq: number, rec: Record<string, unknown>, producerId: string }>} events */
  const presentEvents = (events) => events.map((event) => ({ seq: event.seq, rec: presentHistoryRecord(event.producerId, event.rec) }));

  /** @param {string} chatId @param {unknown} sinceSeq @param {unknown} limit */
  async function getChatHistorySince(chatId, sinceSeq = 0, limit = 1000) {
    const page = /** @type {any} */ (await store.readPage({
      ...lenient(chatId), afterSeq: Math.max(0, Math.floor(Number(sinceSeq)) || 0), limit: clampPullLimit(limit),
    }));
    rememberEpoch(chatId, page.chatEpoch);
    if (page.events.length === 0 && page.headSeq === 0 && !page.cursorSessionId) {
      return { ok: true, chatId, cursorSessionId: '', headSeq: 0, events: [], hasMore: false, identity: identityOf(page) };
    }
    return { ok: true, chatId, cursorSessionId: page.cursorSessionId, headSeq: page.headSeq, events: presentEvents(page.events), hasMore: page.hasMore, identity: identityOf(page) };
  }

  /** @param {string} chatId @param {unknown} seq */
  async function getChatHistoryEvent(chatId, seq) {
    const wanted = Number(seq);
    const empty = { ok: true, chatId, headSeq: 0, event: null, events: [], identity: null };
    if (!Number.isInteger(wanted) || wanted <= 0) return empty;
    // Both bounds make this an exact lookup: a gap never returns a neighbour.
    const page = /** @type {any} */ (await store.readPage({ ...lenient(chatId), afterSeq: wanted - 1, beforeSeq: wanted + 1, limit: 1 }));
    const events = presentEvents(page.events);
    return { ok: true, chatId, headSeq: page.headSeq, event: events[0] ?? null, events, identity: identityOf(page) };
  }

  /**
   * Newest window before `beforeSeq`, extended backwards to a stream boundary
   * and to the opening user turn exactly like the legacy pager, but reading
   * older rows in bounded chunks instead of holding the whole chat.
   * @param {string} chatId @param {{ beforeSeq?: number, limit?: number }} [pageOptions]
   */
  async function getChatHistoryPage(chatId, pageOptions = {}) {
    const beforeSeq = Math.max(0, Number(pageOptions.beforeSeq) || 0);
    const lim = Math.min(HISTORY_PULL_MAX_LIMIT, Math.max(1, Number(pageOptions.limit) || HISTORY_TAIL_DEFAULT_LIMIT));
    for (let attempt = 0; attempt < READ_PIN_ATTEMPTS; attempt += 1) {
      const first = /** @type {any} */ (await store.readLatest({ ...lenient(chatId), limit: lim, ...(beforeSeq > 0 ? { beforeSeq } : {}) }));
      rememberEpoch(chatId, first.chatEpoch);
      if (first.events.length === 0 && first.headSeq === 0 && !first.cursorSessionId) {
        return { ok: true, chatId, cursorSessionId: '', headSeq: 0, events: [], oldestSeq: 0, hasOlder: false, identity: identityOf(first) };
      }
      let pool = presentEvents(first.events);
      let olderAvailable = first.hasMore;
      let slice = pool;
      let broken = false;
      for (;;) {
        const bounded = extendHistorySliceToStreamBoundary(pool, pool.slice(-lim), HISTORY_PULL_MAX_LIMIT);
        slice = extendHistorySliceToTurnStart(pool, bounded, HISTORY_PULL_MAX_LIMIT);
        // Older rows are fetched only when an extension was requested and had run out of loaded rows.
        const streamWanted = pool.length >= lim && Boolean(readSdkHistoryStreamKind(pool[pool.length - lim]?.rec));
        const turnWanted = bounded.length > 0 && !isUserTurnBoundaryRecord(bounded[0].rec) && bounded.some((row) => isHistoryRunFragmentRecord(row.rec));
        const exhausted = slice.length === pool.length;
        if (!exhausted || !(streamWanted || turnWanted) || !olderAvailable || pool.length >= HISTORY_PULL_MAX_LIMIT) break;
        // Every extension chunk is read under the epoch of the first page and must still see its revision: a reset,
        // fork, trim or coalesce in between restarts the whole read instead of gluing two contexts together.
        let older;
        try {
          older = /** @type {any} */ (await store.readLatest({ ...pinned(chatId, first.chatEpoch), limit: OLDER_CHUNK, beforeSeq: pool[0].seq }));
        } catch (error) {
          if (!isPinBroken(error)) throw error;
          broken = true;
          break;
        }
        if (older.revision !== first.revision) {
          broken = true;
          break;
        }
        if (older.events.length === 0) break;
        pool = [...presentEvents(older.events), ...pool];
        olderAvailable = older.hasMore;
      }
      if (broken) {
        epochs.delete(chatId);
        continue;
      }
      return {
        ok: true, chatId, cursorSessionId: first.cursorSessionId, headSeq: first.headSeq, events: slice, oldestSeq: first.oldestSeq,
        hasOlder: slice.length > 0 && slice[0].seq > first.oldestSeq, identity: identityOf(first),
      };
    }
    return unstableRead(chatId);
  }

  /**
   * Full retained load with an explicit byte cap. A chat above the cap is
   * REFUSED (`history_load_too_large`), never silently cut.
   * @param {string} chatId @param {{ maxBytes?: number }} [loadOptions]
   */
  async function loadChatHistory(chatId, loadOptions = {}) {
    const cap = loadOptions.maxBytes ?? loadMaxBytes;
    for (let attempt = 0; attempt < READ_PIN_ATTEMPTS; attempt += 1) {
      /** @type {Array<{ seq: number, rec: Record<string, unknown> }>} */
      const events = [];
      let bytes = 0;
      let after = 0;
      let meta = null;
      let broken = false;
      for (;;) {
        // The first page learns the identity; every later page is read under that epoch and must report the same
        // revision, otherwise the load restarts (bounded) and never returns a mix of two chat states.
        let page;
        try {
          page = /** @type {any} */ (await store.readPage({ ...(meta?.chatEpoch ? pinned(chatId, meta.chatEpoch) : lenient(chatId)), afterSeq: after, limit: HISTORY_PULL_MAX_LIMIT }));
        } catch (error) {
          if (!isPinBroken(error)) throw error;
          broken = true;
          break;
        }
        if (meta && page.revision !== meta.revision) {
          broken = true;
          break;
        }
        rememberEpoch(chatId, page.chatEpoch);
        meta = meta ?? page;
        for (const event of presentEvents(page.events)) {
          bytes += Buffer.byteLength(JSON.stringify(event.rec));
          if (bytes > cap) refuseHistory('history_load_too_large', 'The chat exceeds the full-load byte cap; read it in pages', { chatId, maxBytes: cap });
          events.push(event);
        }
        if (!page.hasMore || page.events.length === 0) break;
        after = page.events[page.events.length - 1].seq;
      }
      if (broken) {
        epochs.delete(chatId);
        continue;
      }
      if (!meta || (meta.headSeq === 0 && events.length === 0 && !meta.cursorSessionId)) return null;
      return {
        v: 1, chatId, cursorSessionId: meta.cursorSessionId, headSeq: meta.headSeq, updatedAt: meta.updatedAt ?? '', events,
        usageSummary: summarizeChatHistoryUsage(events), identity: identityOf(meta),
      };
    }
    return unstableRead(chatId);
  }

  /** @param {string} source @param {string} target @param {string} cursor @param {string | undefined} upTo */
  async function copy(source, target, cursor, upTo, retryToken) {
    const payload = {
      sourceChatId: source, targetChatId: target, targetChatEpoch: `fork.${randomUUID()}`, targetCursorSessionId: cursor || '',
      ...(upTo === undefined ? {} : { upToCreatedAt: String(upTo ?? '') }),
    };
    const outcome = await executeDurably('copyChat', target, defaultProducerId, payload, retryToken);
    epochs.delete(target);
    await emitCommitted({ operation: 'copy', chatId: target, sourceChatId: source, headSeq: outcome.result.headSeq, replayed: outcome.replayed, commandId: outcome.commandId });
    return outcome.result;
  }

  return {
    appendChatHistoryEvents,
    appendChatNotice,
    getChatHistorySince,
    getChatHistoryEvent,
    getChatHistoryPage,
    loadChatHistory,
    async copyChatHistory(source, target, cursor, callOptions = {}) {
      const result = await copy(source, target, cursor, undefined, callOptions.retryToken);
      return { ok: true, headSeq: result.headSeq };
    },
    async copyChatHistoryUntil(source, target, cursor, upToCreatedAt, callOptions = {}) {
      const result = await copy(source, target, cursor, upToCreatedAt ?? '', callOptions.retryToken);
      // The copy is already committed (the store caps it at HISTORY_MAX_COPY_BYTES), so read it back under that same
      // cap: the default load cap must never turn a committed fork into an error that looks like "not committed".
      let doc;
      try {
        doc = await loadChatHistory(target, { maxBytes: HISTORY_MAX_COPY_BYTES });
      } catch (cause) {
        return refuseHistory('history_committed_readback_failed', 'The fork committed but reading it back failed; read the target in pages', {
          commitState: 'committed', operation: 'copyChatHistoryUntil', sourceChatId: source, targetChatId: target, headSeq: result.headSeq,
          cause: /** @type {any} */ (cause)?.code ?? 'unknown',
        });
      }
      return { ok: true, headSeq: result.headSeq, events: doc ? doc.events : [] };
    },
    async deleteChatHistory(chatId, callOptions = {}) {
      const outcome = await executeDurably('deleteChat', chatId, defaultProducerId, { chatId, newChatEpoch: `del.${randomUUID()}` }, callOptions.retryToken);
      epochs.delete(chatId);
      await emitCommitted({ operation: 'delete', chatId, replayed: outcome.replayed, commandId: outcome.commandId });
    },
    async listChatHistoryHeadSeqs() {
      /** @type {Record<string, { headSeq: number, updatedAt: string }>} */
      const out = {};
      let afterChatId = '';
      for (;;) {
        const page = /** @type {any} */ (await store.listHeads({ afterChatId, limit: 500 }));
        for (const chat of page.chats) out[chat.chatId] = { headSeq: chat.headSeq, updatedAt: chat.updatedAt || '' };
        if (!page.hasMore || page.chats.length === 0) break;
        afterChatId = page.chats[page.chats.length - 1].chatId;
      }
      return out;
    },
    async getChatHistoryUsage(chatId) {
      const result = /** @type {any} */ (await store.readUsage(lenient(chatId)));
      return { usageSummary: result.usageSummary, headSeq: result.headSeq, eventCount: result.eventCount, updatedAt: result.updatedAt };
    },
    /**
     * Replay every persisted pending command (call once at startup, before
     * serving writes). A replay of a committed command returns its receipt; a
     * definitive refusal (stale epoch, fenced producer, other generation)
     * moves the entry to quarantine instead of dropping it.
     */
    async recoverPending() {
      const summary = { replayed: 0, committed: 0, quarantined: /** @type {Array<{ commandId: string, reason: string }>} */ ([]), unresolved: /** @type {string[]} */ ([]) };
      /** @param {import('./history-pending-buffer.js').PendingEntry[]} group @param {string} reason */
      const quarantineGroup = async (group, reason) => {
        for (const entry of group) {
          await pendingBuffer.quarantine(entry.commandId, reason);
          summary.quarantined.push({ commandId: entry.commandId, reason });
          stats.quarantined += 1;
        }
      };
      /** @type {Map<string, import('./history-pending-buffer.js').PendingEntry[]>} */
      const batches = new Map();
      /** @type {Array<import('./history-pending-buffer.js').PendingEntry[]>} replay units in recorded order */
      const units = [];
      for (const entry of pendingBuffer.list()) {
        if (!entry.batch) {
          units.push([entry]);
          continue;
        }
        let group = batches.get(entry.batch.id);
        if (!group) {
          group = [];
          batches.set(entry.batch.id, group);
          units.push(group);
        }
        group.push(entry);
      }
      for (const group of units) {
        const batch = group[0].batch;
        if (group.some((entry) => entry.payload.datasetGeneration !== datasetGeneration)) {
          await quarantineGroup(group, 'generation_mismatch');
          continue;
        }
        if (batch) {
          group.sort((a, b) => /** @type {any} */ (a.batch).index - /** @type {any} */ (b.batch).index);
          const complete = group.length === batch.count && group.every((entry, index) => entry.batch?.index === index);
          if (!complete) {
            if (group[0].batch?.index === 0) {
              // A recorded PREFIX: the crash hit while the plan was being written, so nothing was dispatched.
              await quarantineGroup(group, 'batch_incomplete_record');
            } else {
              // A SUFFIX looks like an interrupted acknowledgement, but a failed record/cleanup can leave the same shape with
              // NOTHING dispatched. Only a committed receipt of EVERY remaining fragment proves the ACK; anything else is kept.
              let proven = true;
              let lookupFailed = false;
              for (const entry of group) {
                try {
                  const receipt = /** @type {any} */ (await lookupReceipt({ commandId: entry.commandId }));
                  if (receipt?.outcome !== 'committed') { proven = false; break; }
                } catch {
                  lookupFailed = true;
                  break;
                }
              }
              if (lookupFailed) summary.unresolved.push(...group.map((entry) => entry.commandId));
              else if (proven) await pendingBuffer.ackMany(group.map((entry) => entry.commandId));
              else await quarantineGroup(group, 'batch_suffix_unproven');
            }
            continue;
          }
        }
        let headSeq = 0;
        let failed = false;
        for (const entry of group) {
          try {
            const outcome = await dispatch(entry);
            headSeq = outcome.result.headSeq ?? headSeq;
            summary.replayed += 1;
            if (!outcome.replayed) summary.committed += 1;
          } catch (error) {
            failed = true;
            if (/** @type {any} */ (error)?.code === 'history_commit_unknown' || isTransientRefusal(error)) {
              summary.unresolved.push(entry.commandId);
              break;
            }
            const reason = conflictKindOf(error) ?? /** @type {any} */ (error)?.code ?? 'refused';
            await quarantineGroup(group.filter((item) => pendingBuffer.get(item.commandId)), String(reason));
            break;
          }
        }
        if (failed) continue;
        await ackEntries(group);
        const first = group[0];
        if (group.some((entry) => entry.operation === 'appendEvents' || entry.operation === 'appendLarge')) {
          await emitCommitted({ operation: 'append', chatId: first.chatId, headSeq, appended: [], replayed: true, recovered: true, commandId: first.commandId, ...(batch ? { batchId: batch.id } : {}) });
        } else {
          await emitCommitted({ operation: first.operation === 'deleteChat' ? 'delete' : 'copy', chatId: first.chatId, replayed: true, recovered: true, commandId: first.commandId });
        }
      }
      return summary;
    },
    /** Receipt lookup of a command this adapter has pending (never an ACK for a different generation). */
    lookupReceipt,
    /**
     * Housekeeping of the large-record staging. Superseded stages (chat gone, new epoch, fenced producer) can never
     * be finalized and go unconditionally. A stage of THIS adapter's server producers that no pending entry refers
     * to and that is older than `olderThanMs` was abandoned (its input was refused and discarded): it is removed
     * with a creation-time guard. Browser-queue stages are never aged out here: their pending input lives elsewhere.
     * @param {{ olderThanMs?: number, nowMs?: number }} [gcOptions]
     */
    async gcLargeStaging(gcOptions = {}) {
      const olderThanMs = gcOptions.olderThanMs ?? 3_600_000;
      const nowMs = gcOptions.nowMs ?? Date.now();
      const summary = { superseded: 0, abandoned: 0, kept: 0 };
      for (let round = 0; round < 64; round += 1) {
        const outcome = /** @type {any} */ (await store.gcSupersededStages({ datasetGeneration, commandId: `hist.gc.${randomUUID()}` }));
        summary.superseded += outcome.result.removed;
        if (!outcome.result.more) break;
      }
      const referenced = new Set(pendingBuffer.list().filter((entry) => entry.operation === 'appendLarge')
        .map((entry) => `${entry.chatId}\u0000${entry.payload.producerId}\u0000${entry.payload.event.clientSeq}`));
      const cutoff = nowMs - olderThanMs;
      /** @type {any} */
      let after;
      for (;;) {
        const page = /** @type {any} */ (await store.listStages({ datasetGeneration, ...(after ? { after } : {}) }));
        for (const stage of page.stages) {
          if (!isServerProducerId(stage.producerId) || referenced.has(`${stage.chatId}\u0000${stage.producerId}\u0000${stage.clientSeq}`) || stage.createdAt > cutoff) {
            summary.kept += 1;
            continue;
          }
          const gone = /** @type {any} */ (await store.abandonStage({
            datasetGeneration, chatId: stage.chatId, producerId: stage.producerId, clientSeq: stage.clientSeq, createdBefore: cutoff, commandId: `hist.gc.${randomUUID()}`,
          }));
          if (gone.result.abandoned) summary.abandoned += 1;
          else summary.kept += 1;
        }
        if (!page.hasMore || page.stages.length === 0) break;
        const last = page.stages[page.stages.length - 1];
        after = { chatId: last.chatId, producerId: last.producerId, clientSeq: last.clientSeq };
      }
      return summary;
    },
    diagnose() {
      return { backend: 'sqlite', datasetGeneration, producerId: defaultProducerId, pending: pendingBuffer.stats(), ...stats, limits: { maxCommandBytes: HISTORY_MAX_COMMAND_BYTES, maxRecordBytes: HISTORY_MAX_RECORD_BYTES, maxLargeRecordBytes: HISTORY_MAX_LARGE_RECORD_BYTES } };
    },
  };
}
