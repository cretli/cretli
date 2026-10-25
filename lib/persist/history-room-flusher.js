/**
 * Durable, serialized history flusher for in-memory record buffers (stage 2b).
 *
 * The harness room kernel and the SDK websocket buffer history records in memory and
 * flush them in batches. With the legacy file store a flush could not fail in a way the
 * caller cared about; with the SQLite adapter an append is an asynchronous durable
 * command that can be refused, time out with an unknown outcome, or commit only a
 * prefix. This module owns the contract callers must follow
 * (docs/storage-history-migration.md "Logical append batches and the retry API"):
 *
 *   - records leave the buffer ONLY after the adapter acknowledged them (the call
 *     returned `ok`) or the adapter proved they can never apply (dead letter, kept and
 *     logged, never silently dropped);
 *   - the in-flight batch is kept byte-for-byte and re-sent with the SAME `retryToken`
 *     whenever an error carries one (`history_commit_unknown`, resumable
 *     `history_batch_incomplete`, `history_committed_readback_failed`, ...), so a retry
 *     can never duplicate or reorder what already committed;
 *   - flushes of one buffer are serialized (one in-flight batch per room), and a
 *     retry is scheduled with backoff even when no new record arrives;
 *   - a non-resumable partial commit acknowledges exactly the committed prefix
 *     (`details.committedEvents`) and dead-letters the remainder;
 *   - a deterministic permanent refusal of a multi-record batch is bisected down to
 *     the offending record so one oversized record cannot starve its neighbours.
 *
 * It holds no timers for rooms that have nothing to retry, and its timers are unref'ed
 * (a process exit with retained records is a crash-equivalent, exactly like losing the
 * in-memory buffer before this change; the adapter's own pending journal starts at
 * `appendChatHistoryEvents`).
 */
import { isValidSdkHistoryRecord } from './chat-history-validate.js';

/** Largest number of records / estimated bytes sent as one adapter call (the adapter allows 1024 / 8 MiB). */
export const FLUSH_MAX_EVENTS = 512;
export const FLUSH_MAX_BYTES = 6 * 1024 * 1024;
export const FLUSH_BACKOFF_MS = Object.freeze([250, 1000, 4000, 15000]);
export const DEAD_LETTER_LIMIT = 50;

/** Refusals after which retrying can never help and the input must be kept untouched (not dead-lettered). */
const TERMINAL_CODES = new Set(['history_producer_fenced']);

/** Refusals that are deterministic for the same input: retrying them can only fail again. */
const PERMANENT_CODES = new Set([
  'history_record_too_large',
  'history_batch_too_large',
  'history_record_unserializable',
  'history_unnamespaced_input',
  'history_invalid_chat_id',
]);

/**
 * Rooms that currently hold unacknowledged records, by chat id. `settleHistoryFlushes` lets a chat delete wait for
 * in-flight flushes (so a late flush cannot resurrect a deleted chat) and `discardBufferedHistory` drops what a
 * failing flush still retains once the chat is gone for good.
 * @type {Map<string, Set<any>>}
 */
const roomsByChat = new Map();

/** @param {any} room @returns {number} records set aside (never acknowledged) and not yet discarded */
function deadLetterCount(room) {
  return Array.isArray(room?._persistDeadLetter) ? room._persistDeadLetter.reduce((n, row) => n + (row?.items?.length || 0), 0) : 0;
}

/** @param {any} room */
function trackRoom(room) {
  const chatId = String(room?.chatId || '');
  if (!chatId) return;
  if (!roomsByChat.has(chatId)) roomsByChat.set(chatId, new Set());
  roomsByChat.get(chatId)?.add(room);
}

/** @param {any} room */
function untrackRoom(room) {
  const chatId = String(room?.chatId || '');
  const rooms = roomsByChat.get(chatId);
  if (!rooms) return;
  rooms.delete(room);
  if (rooms.size === 0) roomsByChat.delete(chatId);
}

/**
 * Wait for the flush chains of every room of a chat.
 * @param {string} chatId @returns {Promise<void>}
 */
export async function settleHistoryFlushes(chatId) {
  const rooms = [...(roomsByChat.get(String(chatId)) || [])];
  await Promise.all(rooms.map((room) => Promise.resolve(room._persistFlushChain).catch(() => {})));
}

/**
 * Shutdown barrier: try to commit everything still buffered in any room, bounded by `timeoutMs`.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, rooms: number, pending: number, deadLettered: number }>} `pending` = records still unacknowledged, `deadLettered` = records set aside without an acknowledgement
 */
export async function flushAllBufferedHistory(options = {}) {
  const rooms = [...roomsByChat.values()].flatMap((set) => [...set]);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 5000;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([
      Promise.all(rooms.map((room) => Promise.resolve(typeof room._flushHistory === 'function' ? room._flushHistory() : null).catch(() => {}))),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const pending = rooms.reduce((sum, room) => sum + (Array.isArray(room._persistBuf) ? room._persistBuf.length : 0) + (room._persistInflight?.items?.length || 0), 0);
  const deadLettered = rooms.reduce((sum, room) => sum + deadLetterCount(room), 0);
  // A dead-lettered record was never acknowledged by the adapter: it is not durable, so the barrier is not ok.
  return { ok: pending === 0 && deadLettered === 0, rooms: rooms.length, pending, deadLettered };
}

/**
 * Drop every record still buffered for a chat that was deleted (timers included).
 * @param {string} chatId @returns {number} records dropped
 */
export function discardBufferedHistory(chatId) {
  let dropped = 0;
  for (const room of [...(roomsByChat.get(String(chatId)) || [])]) {
    dropped += (Array.isArray(room._persistBuf) ? room._persistBuf.length : 0) + (room._persistInflight?.items?.length || 0);
    room._persistBuf = [];
    room._persistInflight = null;
    room._persistDeadLetter = [];
    // A deleted chat must not be resurrected by a late append (stream callback, retry timer, queued flush).
    room._persistDiscarded = true;
    if (room._persistRetryTimer) clearTimeout(room._persistRetryTimer);
    room._persistRetryTimer = null;
    if (room._persistTimer) clearTimeout(room._persistTimer);
    room._persistTimer = null;
    untrackRoom(room);
  }
  return dropped;
}

/** @param {unknown} error @returns {Record<string, any>} */
const detailsOf = (error) => /** @type {any} */ (error)?.details ?? {};

/**
 * @param {{
 *   append: (room: any, items: Array<{ rec: Record<string, unknown>, clientSeq?: number }>, callOptions: { retryToken?: string }) => Promise<unknown>,
 *   label?: string,
 *   warn?: (message: string, ...rest: unknown[]) => void,
 *   backoffMs?: readonly number[],
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 *   onDeadLetter?: (room: any, entry: { items: unknown[], code: string, message: string }) => void,
 * }} options
 */
export function createHistoryFlusher(options) {
  const { append } = options;
  if (typeof append !== 'function') throw new TypeError('A history flusher needs an append function');
  const label = options.label || 'history';
  const warn = options.warn || ((...args) => console.warn(...args));
  const backoff = options.backoffMs || FLUSH_BACKOFF_MS;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;

  /** Records that must be sent alone (isolated by a bisect after a permanent refusal). */
  const solo = new WeakSet();

  /** @param {any} room */
  const bufferOf = (room) => (Array.isArray(room._persistBuf) ? room._persistBuf : (room._persistBuf = []));

  /** @param {any} room @returns {number} records buffered or in flight, i.e. not yet acknowledged */
  function pending(room) {
    return bufferOf(room).length + (room?._persistInflight?.items?.length || 0);
  }

  /** @param {any} room */
  function track(room) {
    // A room holding unacknowledged dead letters stays visible to the shutdown barrier until it is discarded.
    if (pending(room) > 0 || deadLetterCount(room) > 0) trackRoom(room);
    else untrackRoom(room);
  }

  /** @param {any} room @param {unknown[]} items @param {string} code @param {string} message */
  function deadLetter(room, items, code, message) {
    if (items.length === 0) return;
    const list = Array.isArray(room._persistDeadLetter) ? room._persistDeadLetter : (room._persistDeadLetter = []);
    // Never evict older entries: a full list blocks the drain (see `deadLetterFull`) instead of losing records.
    list.push({ at: new Date().toISOString(), code, message: String(message).slice(0, 200), items });
    warn(`[${label}] history records set aside (${code}): ${String(message).slice(0, 200)} - ${items.length} record(s) kept in room._persistDeadLetter`);
    options.onDeadLetter?.(room, { items, code, message });
  }

  /** @param {any} room */
  const deadLetterFull = (room) => Array.isArray(room._persistDeadLetter) && room._persistDeadLetter.length >= DEAD_LETTER_LIMIT;

  /** Freeze one send unit's bytes: later caller mutation of the buffered object can never change a retry. */
  function snapshotItem(item) {
    return { ...item, rec: structuredClone(item.rec) };
  }

  /** Take the next send unit off the buffer; invalid records are set aside, never sent. */
  function takeUnit(room) {
    const buf = bufferOf(room);
    const invalid = [];
    while (buf.length > 0 && !isValidSdkHistoryRecord(buf[0]?.rec)) invalid.push(buf.shift());
    deadLetter(room, invalid, 'history_record_invalid', 'record rejected by the history validator');
    if (buf.length === 0) return null;
    if (solo.has(buf[0])) return [snapshotItem(buf.shift())];
    const unit = [];
    let bytes = 0;
    while (buf.length > 0 && unit.length < FLUSH_MAX_EVENTS) {
      const next = buf[0];
      if (solo.has(next) || !isValidSdkHistoryRecord(next?.rec)) break;
      const size = Buffer.byteLength(JSON.stringify(next.rec), 'utf8') + 64;
      if (unit.length > 0 && bytes + size > FLUSH_MAX_BYTES) break;
      unit.push(snapshotItem(buf.shift()));
      bytes += size;
    }
    return unit;
  }

  /** @param {any} room */
  function clearRetryTimer(room) {
    if (room._persistRetryTimer) clearTimer(room._persistRetryTimer);
    room._persistRetryTimer = null;
  }

  /** @param {any} room */
  function scheduleRetry(room) {
    if (room._persistRetryTimer) return;
    const attempt = Math.min(Number(room._persistFailures) || 0, backoff.length - 1);
    const timer = setTimer(() => {
      room._persistRetryTimer = null;
      void flush(room, { reason: 'retry' });
    }, backoff[Math.max(0, attempt)]);
    timer?.unref?.();
    room._persistRetryTimer = timer;
  }

  /**
   * One serialized drain of the buffer. Resolves (never rejects) with the outcome.
   * @param {any} room
   * @returns {Promise<{ ok: boolean, pending: number, deadLettered: number, error?: { code: string, message: string } }>}
   */
  async function drain(room) {
    let deadBefore = Array.isArray(room._persistDeadLetter) ? room._persistDeadLetter.reduce((n, row) => n + row.items.length, 0) : 0;
    for (;;) {
      if (!room?.chatId || !room?.sessionKey || room._persistDiscarded) return result(room, deadBefore, undefined);
      if (room._persistBlocked) return result(room, deadBefore, room._persistBlocked);
      if (!room._persistInflight) {
        if (deadLetterFull(room) && bufferOf(room).length > 0) {
          const full = Object.assign(new Error(`dead-letter list is full (${DEAD_LETTER_LIMIT}); buffered records are kept`), { code: 'history_dead_letter_full' });
          return result(room, deadBefore, full);
        }
        let items;
        try {
          items = takeUnit(room);
        } catch (error) {
          // structuredClone failed: the record can never be serialized, set it aside (kept) and continue.
          const stuck = bufferOf(room).splice(0, 1);
          deadLetter(room, stuck, 'history_record_unserializable', String(/** @type {any} */ (error)?.message ?? error));
          continue;
        }
        if (!items) return result(room, deadBefore, undefined);
        room._persistInflight = { items, retryToken: undefined };
      }
      const inflight = room._persistInflight;
      try {
        const appended = await append(room, inflight.items, inflight.retryToken === undefined ? {} : { retryToken: inflight.retryToken });
        // An explicit soft refusal is not an acknowledgement; `undefined` is the legacy "returned without error" contract.
        if (appended && typeof appended === 'object' && /** @type {any} */ (appended).ok === false) {
          const refusal = /** @type {any} */ (appended);
          throw Object.assign(new Error(String(refusal.message || refusal.code || 'history append refused')), { code: refusal.code, details: refusal.details });
        }
        room._persistInflight = null;
        room._persistFailures = 0;
      } catch (error) {
        if (room._persistDiscarded) return result(room, deadBefore, undefined);
        const outcome = classify(room, inflight, error);
        if (outcome === 'terminal') {
          const code = String(/** @type {any} */ (error)?.code ?? 'unknown');
          room._persistBlocked = Object.assign(new Error(`history append permanently refused (${code}); records are kept`), { code });
          return result(room, deadBefore, room._persistBlocked);
        }
        if (outcome === 'retry') {
          room._persistFailures = (Number(room._persistFailures) || 0) + 1;
          scheduleRetry(room);
          return result(room, deadBefore, error);
        }
        // 'settled' and 'bisected' changed the buffer; keep draining the rest.
      }
    }
  }

  /** @param {any} room @param {number} deadBefore @param {unknown} error */
  function result(room, deadBefore, error) {
    const dead = Array.isArray(room._persistDeadLetter) ? room._persistDeadLetter.reduce((n, row) => n + row.items.length, 0) : 0;
    const unacked = deadLetterCount(room);
    const base = { ok: pending(room) === 0 && !error && unacked === 0, pending: pending(room), deadLettered: Math.max(0, dead - deadBefore) };
    if (!error && unacked > 0 && !room._persistDiscarded) {
      // Dead-lettered records were never acknowledged: stay not-ok on every later flush until they are resolved.
      return { ...base, ok: false, error: { code: 'history_dead_lettered', message: `${unacked} record(s) set aside without an acknowledgement` } };
    }
    if (!error) return base;
    return { ...base, ok: false, error: { code: String(/** @type {any} */ (error)?.code ?? 'unknown'), message: String(/** @type {any} */ (error)?.message ?? error).slice(0, 200) } };
  }

  /**
   * Decide what a failed append means for the in-flight unit.
   * @returns {'retry' | 'settled' | 'bisected' | 'terminal'}
   */
  function classify(room, inflight, error) {
    const code = String(/** @type {any} */ (error)?.code ?? '');
    const details = detailsOf(error);
    if (TERMINAL_CODES.has(code)) return 'terminal';
    if (details.retryToken !== undefined) inflight.retryToken = String(details.retryToken);
    if (code === 'history_committed_readback_failed' && details.resumable === false) {
      // Fully committed; only the read-back lost a record. The input is ACKed (it is stored); report the loss.
      room._persistInflight = null;
      warn(`[${label}] history committed but ${code} (${details.cause ?? 'unknown'}); batch acknowledged`);
      return 'settled';
    }
    if (code === 'history_batch_incomplete' && details.resumable === false) {
      const committed = Math.min(Math.max(0, Number(details.committedEvents) || 0), inflight.items.length);
      room._persistInflight = null;
      deadLetter(room, inflight.items.slice(committed), code, `a prefix of ${committed} record(s) committed, the rest can never apply (${details.cause ?? 'refused'})`);
      return 'settled';
    }
    if (code === 'history_batch_unknown' || code === 'history_batch_mismatch') {
      // The recorded plan is gone or does not match: whether it committed is unknowable from here. Keep the records.
      room._persistInflight = null;
      deadLetter(room, inflight.items, code, 'the retry token no longer identifies a pending batch; commit state unknown');
      return 'settled';
    }
    if (details.resumable === true || details.retryToken !== undefined || code === 'history_commit_unknown' || code === 'history_cleanup_uncertain') return 'retry';
    if (PERMANENT_CODES.has(code) && details.commitState !== 'committed') {
      room._persistInflight = null;
      if (inflight.items.length > 1) {
        // Isolate the offender: every record is retried alone, in order, ahead of newer records.
        for (const item of inflight.items) solo.add(item);
        bufferOf(room).unshift(...inflight.items);
        return 'bisected';
      }
      deadLetter(room, inflight.items, code, String(/** @type {any} */ (error)?.message ?? code));
      return 'settled';
    }
    return 'retry';
  }

  /**
   * Flush everything buffered. Serialized per room; callers that need the durable result await it.
   * @param {any} room
   * @param {{ reason?: string }} [flushOptions]
   */
  function flush(room, flushOptions = {}) {
    if (!room) return Promise.resolve({ ok: true, pending: 0, deadLettered: 0 });
    if (room._persistDiscarded) return Promise.resolve({ ok: true, pending: 0, deadLettered: 0 });
    if (room._persistTimer) {
      clearTimer(room._persistTimer);
      room._persistTimer = null;
    }
    if (flushOptions.reason !== 'retry') clearRetryTimer(room);
    trackRoom(room);
    // An idle room dispatches the first append synchronously (the adapter call happens before `flush` returns); a
    // flush that finds one running queues behind it, so one room never has two batches in flight.
    const previous = room._persistFlushActive > 0 ? room._persistFlushChain : null;
    room._persistFlushActive = (room._persistFlushActive || 0) + 1;
    const start = () => drain(room);
    const run = (previous ? previous.then(start, start) : start()).then((outcome) => {
      track(room);
      return outcome;
    }).finally(() => {
      room._persistFlushActive -= 1;
    });
    room._persistFlushChain = run;
    return run;
  }

  /**
   * Register a freshly buffered record: the room becomes visible to shutdown / delete barriers immediately, before
   * the debounce timer fires its first flush. Returns false when the room was discarded (chat deleted).
   * @param {any} room
   */
  function enqueue(room) {
    if (!room || room._persistDiscarded) return false;
    trackRoom(room);
    room._flushHistory = () => flush(room);
    return true;
  }

  return { flush, pending, deadLetter, enqueue };
}
