/**
 * Durable pending buffer and producer identity for the SQLite history backend
 * (stage 2a; docs/storage-history-migration.md "Pending buffer").
 *
 * A history write must have its identity (`commandId`, `producerId`, the
 * producer-scoped `clientSeq` numbers) fixed and persisted BEFORE it is
 * dispatched, and removed only after the durable receipt came back. That is
 * the only thing that lets a crash, a lost worker reply or `unknown_commit` be
 * resolved by replaying the SAME command (the store's receipt makes the replay
 * a no-op when it had committed) instead of guessing and duplicating.
 *
 * A LOGICAL batch (one adapter append that needs several store commands) is
 * persisted as `batch: { id, index, count, digest }` entries, ALL of them before
 * the first dispatch, and acknowledged together only after the whole logical
 * result is assembled, so a retry or restart replays the same plan (the
 * store's receipts answer the chunks that had committed). An open buffer
 * distinguishes a partially RECORDED batch (a prefix `0..k-1`, never
 * dispatched) from a partially ACKNOWLEDGED one (a suffix, already committed).
 *
 * Open-time reads are bounded BEFORE any file is read: entry count, per-file
 * size (`lstat`, `O_NOFOLLOW`) and total bytes; going over a bound is a typed
 * `history_pending_corrupt` refusal, never a warning followed by RAM growth.
 * A damaged or foreign producer-counter file is quarantined under a durable
 * `.counter-corrupt` name and DENIES that producer (`history_producer_counter_corrupt`)
 * on every later run; it is never read as "counter 0". A producer with NO
 * counter file is a never-seen producer and starts at 0: server producers carry
 * a per-attempt random component and queue producers bring their own
 * `clientSeq`, so a missing file cannot alias an earlier numbering.
 *
 * Layout (one directory, owned by one server instance):
 *   entries/<sha256(commandId)>.json   one pending command each
 *   producers/<sha256(producerId)>.json  `{ nextClientSeq }` high-water block
 *   quarantine/<same name>             entries that can no longer be replayed
 * Every file is replaced atomically (tmp + fsync + rename + directory fsync); record/ack calls are coalesced
 * into bounded groups that share ONE entries-directory fsync (format unchanged);
 * the buffer is bounded (entry count, entry bytes, total bytes) and refuses
 * with a typed `history_pending_full` / `history_pending_entry_too_large`
 * instead of dropping or truncating a pending write.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_MAX_LARGE_RECORD_BYTES } from '../storage/history-large-record.js';
import { toWireJson } from '../storage/worker-wire.js';
import { ChatHistoryAdapterError, refuseHistory } from './chat-history-errors.js';

export const PENDING_BUFFER_SCHEMA = 1;
/** Allowance per entry (file header around the wire JSON) used by admission before the entry is rendered. */
const ADMISSION_ENTRY_OVERHEAD_BYTES = 512;

export const PENDING_DEFAULT_MAX_ENTRIES = 4096;
/** One regular entry: a command of up to 264 KiB (a single 256 KiB record) plus the envelope. */
export const PENDING_DEFAULT_MAX_ENTRY_BYTES = 320 * 1024;
/**
 * One `appendLarge` entry holds the WHOLE large record (up to HISTORY_MAX_LARGE_RECORD_BYTES) as ONE durable file,
 * so persisting it costs one fsync instead of one per fragment; the fragment commands are derived from it at dispatch.
 */
export const PENDING_LARGE_MAX_ENTRY_BYTES = HISTORY_MAX_LARGE_RECORD_BYTES + 64 * 1024;
export const PENDING_DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** `clientSeq` numbers claimed per durable counter write; the unused rest of a block is skipped after a restart. */
export const PENDING_CLIENT_SEQ_BLOCK = 1024;
/** Prefix of producers owned by the server. Their `clientSeq` is adapter-allocated and never shown to browsers. */
export const SERVER_PRODUCER_PREFIX = 'server:';
/** Counter files are `{v,producerId,nextClientSeq}`: anything bigger is not one. */
const MAX_COUNTER_FILE_BYTES = 1024;
const MAX_PRODUCER_FILES = 65536;
/** Directory entries tolerated beyond `maxEntries` (torn temp files, foreign junk) before open() refuses without reading. */
const ENTRY_DIR_SLACK = 256;
const COUNTER_CORRUPT_SUFFIX = '.counter-corrupt';
/** Microbatch bounds: one coalescing window never groups more than this many entries / bytes (the first request always fits). */
const GROUP_MAX_ENTRIES = 256;
const GROUP_MAX_BYTES = 8 * 1024 * 1024;
/** Files of one group written concurrently (temp + fsync + rename each); the directory is fsynced ONCE after all of them. */
const GROUP_WRITE_CONCURRENCY = 16;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER - 1;

/** @param {string} value @returns {string} */
const hashName = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Server producer identity of one run attempt, `server:run:<runId>:attempt:<attemptId>`.
 * Identifiers that do not fit the producer alphabet or length fall back to a
 * digest, so the identity is always valid and stable for the same inputs.
 *
 * @param {{ runId: string, attemptId: string }} input
 * @returns {string}
 */
export function buildServerProducerId({ runId, attemptId }) {
  const readable = `${SERVER_PRODUCER_PREFIX}run:${runId}:attempt:${attemptId}`;
  if (typeof runId === 'string' && typeof attemptId === 'string' && IDENTITY_PATTERN.test(readable)) return readable;
  return `${SERVER_PRODUCER_PREFIX}h:${hashName(`${runId}\u0000${attemptId}`).slice(0, 48)}`;
}

/** @param {unknown} producerId @returns {boolean} */
export function isServerProducerId(producerId) {
  return typeof producerId === 'string' && producerId.startsWith(SERVER_PRODUCER_PREFIX);
}

/**
 * @typedef {{ id: string, index: number, count: number, digest: string }} PendingBatch
 * @typedef {{
 *   commandId: string, producerId: string, operation: string, chatId: string,
 *   payload: Record<string, unknown>, createdAt: number, order: number, batch?: PendingBatch,
 * }} PendingEntry
 */

/**
 * @param {{
 *   dir: string,
 *   maxEntries?: number,
 *   maxEntryBytes?: number,
 *   maxTotalBytes?: number,
 *   now?: () => number,
 *   durable?: boolean,
 * }} options `durable: false` skips fsync (benchmarks only; never for the server).
 */
export function createHistoryPendingBuffer(options) {
  const { dir } = options || {};
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('Pending buffer needs an absolute dir');
  const maxEntries = options.maxEntries ?? PENDING_DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? PENDING_DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? PENDING_DEFAULT_MAX_TOTAL_BYTES;
  const now = options.now ?? Date.now;
  const durable = options.durable !== false;
  const entriesDir = path.join(dir, 'entries');
  const producersDir = path.join(dir, 'producers');
  const quarantineDir = path.join(dir, 'quarantine');
  /** @type {Map<string, { file: string, bytes: number, entry: PendingEntry }>} */
  const index = new Map();
  /** @type {Map<string, { next: number, ceiling: number }>} */
  const counters = new Map();
  /** @type {Set<string>} hashed names of producers whose counter file was damaged */
  const deniedCounters = new Set();
  const stats_ = { openQuarantined: 0 };
  let totalBytes = 0;
  let order = 0;
  let opened = false;
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  /** Serialize every mutation: the index and the files must not interleave. */
  const serialized = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function fsyncDir(target) {
    if (!durable) return;
    const handle = await fsp.open(target, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function writeDurable(file, text) {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      if (durable) await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
    await fsyncDir(path.dirname(file));
  }

  /** @param {any} value @returns {PendingBatch | null} */
  function parseBatch(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !IDENTITY_PATTERN.test(value.id)
      || !Number.isSafeInteger(value.index) || !Number.isSafeInteger(value.count) || value.index < 0 || value.count < 1
      || value.index >= value.count || typeof value.digest !== 'string') return null;
    return { id: value.id, index: value.index, count: value.count, digest: value.digest };
  }

  /** @param {string} text @returns {PendingEntry | null} */
  function parseEntry(text) {
    try {
      const value = JSON.parse(text);
      if (value && value.v === PENDING_BUFFER_SCHEMA && typeof value.commandId === 'string' && typeof value.producerId === 'string'
        && typeof value.operation === 'string' && typeof value.chatId === 'string' && value.payload && typeof value.payload === 'object') {
        const batch = parseBatch(value.batch);
        if (value.batch !== undefined && !batch) return null;
        // Freshly parsed (detached from disk and from callers) and frozen BEFORE it is published to the index, like recorded entries.
        return deepFreeze({ commandId: value.commandId, producerId: value.producerId, operation: value.operation, chatId: value.chatId,
          payload: value.payload, createdAt: Number(value.createdAt) || 0, order: Number(value.order) || 0, ...(batch ? { batch } : {}) });
      }
    } catch { /* unreadable entries are quarantined by open() */ }
    return null;
  }

  /**
   * Read a regular file without following symlinks, refusing anything above
   * `maxBytes` BEFORE its content is read.
   *
   * @param {string} file @param {number} maxBytes
   * @returns {Promise<{ ok: true, text: string, bytes: number } | { ok: false, reason: string }>}
   */
  async function readBounded(file, maxBytes) {
    let info;
    try {
      info = await fsp.lstat(file);
    } catch {
      return { ok: false, reason: 'vanished' };
    }
    if (!info.isFile()) return { ok: false, reason: 'not_regular_file' };
    if (info.size > maxBytes) return { ok: false, reason: 'oversized' };
    let handle;
    try {
      handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return { ok: false, reason: 'oversized' };
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      return { ok: true, text: buffer.toString('utf8', 0, bytesRead), bytes: bytesRead };
    } finally {
      await handle.close();
    }
  }

  /** @param {string} dirPath @param {string} name @param {string} suffix */
  async function moveToQuarantine(dirPath, name, suffix) {
    await fsp.rename(path.join(dirPath, name), path.join(quarantineDir, `${name}.${Date.now()}${suffix}`));
  }

  async function open() {
    if (opened) return stats();
    await fsp.mkdir(entriesDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(producersDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
    const entryNames = await fsp.readdir(entriesDir);
    if (entryNames.length > maxEntries + ENTRY_DIR_SLACK) {
      refuseHistory('history_pending_corrupt', 'The pending entries directory holds more files than the budget allows; nothing was read', { files: entryNames.length, maxEntries });
    }
    for (const name of entryNames) {
      const file = path.join(entriesDir, name);
      if (name.endsWith('.tmp')) {
        // A torn temp file never became an entry: the dispatch it belonged to had not started.
        await fsp.rm(file, { force: true });
        continue;
      }
      // A lowered configuration must not turn an older valid entry into "corrupt": the per-file ceiling never drops below the default.
      const fileCeiling = Math.max(maxEntryBytes, PENDING_DEFAULT_MAX_ENTRY_BYTES, PENDING_LARGE_MAX_ENTRY_BYTES);
      const loaded = await readBounded(file, Math.min(fileCeiling, maxTotalBytes - totalBytes));
      if (!loaded.ok && loaded.reason === 'oversized' && (await fsp.lstat(file).then((info) => info.size, () => 0)) <= fileCeiling) {
        refuseHistory('history_pending_corrupt', 'Pending entries exceed the total byte budget; refusing to load them', { maxTotalBytes });
      }
      const entry = loaded.ok ? parseEntry(loaded.text) : null;
      if (!loaded.ok || !entry || `${hashName(entry.commandId)}.json` !== name || !IDENTITY_PATTERN.test(entry.producerId)) {
        stats_.openQuarantined += 1;
        await moveToQuarantine(entriesDir, name, '.corrupt');
        continue;
      }
      if (index.size >= maxEntries) {
        // Valid entries beyond the budget: stop here, nothing further is read or kept in memory.
        refuseHistory('history_pending_corrupt', 'More pending entries than the entry budget; refusing to load them', { maxEntries });
      }
      index.set(entry.commandId, { file, bytes: loaded.bytes, entry });
      totalBytes += loaded.bytes;
      order = Math.max(order, entry.order);
    }
    for (const name of await fsp.readdir(quarantineDir)) {
      if (name.endsWith(COUNTER_CORRUPT_SUFFIX)) deniedCounters.add(name.slice(0, name.indexOf('.json')));
    }
    const producerNames = await fsp.readdir(producersDir);
    if (producerNames.length > MAX_PRODUCER_FILES) {
      refuseHistory('history_pending_corrupt', 'Too many producer counter files; nothing was read', { files: producerNames.length });
    }
    for (const name of producerNames) {
      const file = path.join(producersDir, name);
      if (name.endsWith('.tmp')) {
        await fsp.rm(file, { force: true });
        continue;
      }
      const loaded = await readBounded(file, MAX_COUNTER_FILE_BYTES);
      let value = null;
      if (loaded.ok) {
        try { value = JSON.parse(loaded.text); } catch { value = null; }
      }
      const valid = value && typeof value.producerId === 'string' && IDENTITY_PATTERN.test(value.producerId)
        && `${hashName(value.producerId)}.json` === name && Number.isSafeInteger(value.nextClientSeq)
        && value.nextClientSeq >= 0 && value.nextClientSeq <= MAX_SAFE_COUNTER;
      if (!valid) {
        // Never read as "counter 0": the producer behind this name stays denied until an operator reconciles it.
        deniedCounters.add(name.endsWith('.json') ? name.slice(0, -'.json'.length) : name);
        stats_.openQuarantined += 1;
        await moveToQuarantine(producersDir, name, COUNTER_CORRUPT_SUFFIX);
        continue;
      }
      counters.set(value.producerId, { next: value.nextClientSeq, ceiling: value.nextClientSeq });
    }
    // A pending entry may carry numbers above the stored block (counter file written after the entry): never reuse them.
    for (const { entry } of index.values()) {
      const used = Array.isArray(entry.payload.events) ? entry.payload.events.map((event) => Number(event?.clientSeq)).filter(Number.isSafeInteger) : [];
      if (used.length === 0) continue;
      const counter = counters.get(entry.producerId) ?? { next: 0, ceiling: 0 };
      const floor = Math.max(...used) + 1;
      if (counter.next < floor) counters.set(entry.producerId, { next: floor, ceiling: floor });
      else if (!counters.has(entry.producerId)) counters.set(entry.producerId, counter);
    }
    opened = true;
    return stats();
  }

  function assertOpen() {
    if (!opened) refuseHistory('history_adapter_closed', 'Pending buffer is not open');
  }

  /**
   * Reserve `count` consecutive producer-scoped `clientSeq` numbers. The
   * high-water block is made durable before the numbers are handed out, so a
   * crash can skip numbers but never reuse one.
   *
   * @param {string} producerId
   * @param {number} [count]
   * @returns {Promise<number>} the first reserved number
   */
  function reserveClientSeq(producerId, count = 1) {
    return serialized(async () => {
      assertOpen();
      if (!IDENTITY_PATTERN.test(producerId) || !Number.isSafeInteger(count) || count < 1) throw new TypeError('Invalid producer or count');
      if (deniedCounters.has(hashName(producerId))) {
        refuseHistory('history_producer_counter_corrupt', 'The counter file of this producer was damaged; the producer is denied until an operator reconciles it', { producerId });
      }
      const counter = counters.get(producerId) ?? { next: 0, ceiling: 0 };
      if (counter.next + count > MAX_SAFE_COUNTER) refuseHistory('history_pending_full', 'Producer counter is exhausted', { producerId });
      if (counter.next + count > counter.ceiling) {
        const ceiling = counter.next + Math.max(count, PENDING_CLIENT_SEQ_BLOCK);
        await writeDurable(path.join(producersDir, `${hashName(producerId)}.json`), `${JSON.stringify({ v: PENDING_BUFFER_SCHEMA, producerId, nextClientSeq: ceiling })}\n`);
        counter.ceiling = ceiling;
      }
      const first = counter.next;
      counter.next += count;
      counters.set(producerId, counter);
      return first;
    });
  }

  /**
   * Private, deeply frozen JSON copy of a caller entry. Taken synchronously, before the write is queued, so neither
   * a later mutation by the caller nor `toJSON`/getters running a second time can change what is persisted,
   * dispatched or returned. Unsupported values (cycles, BigInt, functions, Map/Set) are refused up front.
   * @param {Omit<PendingEntry, 'createdAt' | 'order'>} entry @returns {Omit<PendingEntry, 'createdAt' | 'order'>}
   */
  function snapshotEntry(entry) {
    let copy;
    try {
      const wire = toWireJson(entry).json;
      copy = JSON.parse(wire);
      snapshotBytes.set(copy, Buffer.byteLength(wire) + ADMISSION_ENTRY_OVERHEAD_BYTES);
    } catch (error) {
      refuseHistory('history_pending_entry_unserializable', 'Pending command is not plain JSON data; nothing was recorded', { reason: String(/** @type {Error} */ (error)?.message ?? error).slice(0, 120) });
    }
    return deepFreeze(copy);
  }

  /** Admission size of each snapshot (wire bytes + file header allowance), keyed by the private copy. */
  const snapshotBytes = new WeakMap();
  /** Entries/bytes of record requests admitted but not yet published to the index nor refused (queued + in the running group). */
  let reservedEntries = 0;
  let reservedBytes = 0;

  /** @param {any} value @returns {any} */
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }

  /** @param {Omit<PendingEntry, 'createdAt' | 'order'>} entry already snapshotted @param {number} nextOrder @returns {{ full: PendingEntry, text: string, bytes: number }} */
  function prepareEntry(entry, nextOrder) {
    if (index.has(entry.commandId)) refuseHistory('history_pending_full', 'Command is already pending', { commandId: entry.commandId });
    const full = deepFreeze({ ...entry, createdAt: now(), order: nextOrder });
    const text = `${JSON.stringify({ v: PENDING_BUFFER_SCHEMA, ...full })}\n`;
    const bytes = Buffer.byteLength(text);
    const entryLimit = entry.operation === 'appendLarge' ? Math.max(maxEntryBytes, PENDING_LARGE_MAX_ENTRY_BYTES) : maxEntryBytes;
    if (bytes > entryLimit) refuseHistory('history_pending_entry_too_large', 'Pending command exceeds the entry limit', { bytes, maxEntryBytes: entryLimit });
    return { full, text, bytes };
  }

  /**
   * Run `fn` over `list` with at most `limit` in flight. `fn` must not throw (it records its own error). Every worker is
   * awaited, so when this returns NO write of the group is still running and no late rename can appear.
   * @template T @param {T[]} list @param {number} limit @param {(item: T) => Promise<void>} fn
   */
  async function forEachBounded(list, limit, fn) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) await fn(list[cursor++]);
    };
    await Promise.allSettled(Array.from({ length: Math.min(limit, list.length) }, worker));
  }

  /** Temp + write + fsync + rename of one entry file. The directory fsync is the group's job. */
  async function writeEntryFile(job) {
    job.touched = true;
    try {
      const handle = await fsp.open(job.temp, 'wx', 0o600);
      try {
        await handle.writeFile(job.item.text);
        if (durable) await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(job.temp, job.file);
    } catch (error) {
      job.error = error;
    }
  }

  /** Remove EVERY path a job may have created (temp, and the final name even if its rename succeeded). @returns {Promise<boolean>} all removals confirmed */
  async function removeJobFiles(jobs) {
    let confirmed = true;
    for (const job of jobs) {
      if (!job.touched) continue;
      for (const target of [job.temp, job.file]) {
        try { await fsp.rm(target, { force: true }); } catch { confirmed = false; job.leftover = true; }
      }
    }
    return confirmed;
  }

  /** @type {Array<{ snapshots: any[], resolve: (v: PendingEntry[]) => void, reject: (e: unknown) => void }>} */
  const recordQueue = [];
  let recordFlushScheduled = false;
  /** Command ids kept in the index because a failed group could not prove their files are gone (fail closed until acknowledged). */
  const uncertainIds = new Set();

  function scheduleRecordFlush() {
    if (recordFlushScheduled) return;
    recordFlushScheduled = true;
    setImmediate(() => {
      recordFlushScheduled = false;
      serialized(runRecordGroup).catch(() => {});
    });
  }

  /** Take the next requests that fit the group bounds: each accepted request is prepared (snapshots, unique ids, quota, order) in queue order. */
  function collectRecordGroup() {
    const group = [];
    const groupIds = new Set();
    let entriesInGroup = 0;
    let bytesInGroup = 0;
    let nextOrder = order;
    while (recordQueue.length > 0) {
      const req = recordQueue[0];
      let prepared;
      try {
        assertOpen();
        if (uncertainIds.size > 0) {
          refuseHistory('history_cleanup_uncertain', 'An earlier pending write could not prove its files were discarded; they may still be replayed. Acknowledge or restart before recording more', { commandIds: [...uncertainIds].slice(0, 16), commitState: 'uncertain' });
        }
        const seen = new Set();
        for (const entry of req.snapshots) {
          if (seen.has(entry.commandId) || groupIds.has(entry.commandId)) refuseHistory('history_pending_full', 'Command is already pending', { commandId: entry.commandId });
          seen.add(entry.commandId);
        }
        prepared = req.snapshots.map((entry, offset) => prepareEntry(entry, nextOrder + 1 + offset));
        const addedBytes = prepared.reduce((sum, item) => sum + item.bytes, 0);
        if (index.size + entriesInGroup + prepared.length > maxEntries || totalBytes + bytesInGroup + addedBytes > maxTotalBytes) {
          refuseHistory('history_pending_full', 'Pending buffer is full; earlier commands must be acknowledged first', { entries: index.size + entriesInGroup, totalBytes: totalBytes + bytesInGroup, needed: prepared.length, neededBytes: addedBytes });
        }
        // The FIRST request of a group is always accepted (a single batch may exceed the group bounds, never the quota above).
        if (group.length > 0 && (entriesInGroup + prepared.length > GROUP_MAX_ENTRIES || bytesInGroup + addedBytes > GROUP_MAX_BYTES)) break;
        recordQueue.shift();
        for (const item of prepared) groupIds.add(item.full.commandId);
        entriesInGroup += prepared.length;
        bytesInGroup += addedBytes;
        nextOrder += prepared.length;
        group.push({ req, prepared });
      } catch (error) {
        recordQueue.shift();
        req.reject(error);
      }
    }
    return group;
  }

  /** Persist one coalesced group: parallel temp/fsync/rename, ONE directory fsync, and only then publish and resolve. */
  async function runRecordGroup() {
    const group = collectRecordGroup();
    if (recordQueue.length > 0) scheduleRecordFlush();
    if (group.length === 0) return;
    try {
      for (const member of group) {
        member.jobs = member.prepared.map((item) => {
          const file = path.join(entriesDir, `${hashName(item.full.commandId)}.json`);
          return { item, file, temp: `${file}.${randomBytes(6).toString('hex')}.tmp`, touched: false, error: null };
        });
      }
      await forEachBounded(group.flatMap((member) => member.jobs), GROUP_WRITE_CONCURRENCY, writeEntryFile);
      const failed = group.filter((member) => member.jobs.some((job) => job.error));
      const clean = new Set(group.filter((member) => !failed.includes(member)));
      for (const member of failed) member.cleaned = await removeJobFiles(member.jobs);
      const touchedAny = group.some((member) => member.jobs.some((job) => job.touched));
      let syncError = null;
      if (touchedAny) await fsyncDir(entriesDir).catch((error) => { syncError = error; });
      const uncertain = new Set();
      let syncUnproven = false;
      if (syncError) {
        // The renames (and removals) are not provably durable: discard every path of the whole group, then prove it with a second fsync.
        for (const member of group) if (!(await removeJobFiles(member.jobs))) uncertain.add(member);
        const secondSync = await fsyncDir(entriesDir).then(() => null, (error) => error);
        if (secondSync) { syncUnproven = true; for (const member of group) uncertain.add(member); }
      } else {
        for (const member of failed) if (!member.cleaned) uncertain.add(member);
      }
      for (const member of group) {
        const jobs = member.jobs;
        if (uncertain.has(member)) {
          rejectUncertain(member, syncError ?? jobs.find((job) => job.error)?.error, syncUnproven);
        } else if (syncError || !clean.has(member)) {
          member.req.reject(jobs.find((job) => job.error)?.error ?? syncError);
        } else {
          for (const job of jobs) {
            index.set(job.item.full.commandId, { file: job.file, bytes: job.item.bytes, entry: job.item.full });
            totalBytes += job.item.bytes;
            order = Math.max(order, job.item.full.order);
          }
          member.req.resolve(member.prepared.map((item) => item.full));
        }
      }
    } catch (error) {
      // Unexpected: never leave a caller hanging. Nothing was published for requests not settled above, but a file may exist:
      // prove its removal (and the directory) or keep the plan fenced exactly like an ordinary cleanup failure.
      for (const member of group) {
        if (member.req.settled) continue;
        const confirmed = member.jobs ? await removeJobFiles(member.jobs) : true;
        const dirError = member.jobs?.some((job) => job.touched) ? await fsyncDir(entriesDir).then(() => null, (e) => e) : null;
        if (!confirmed || dirError) rejectUncertain(member, error, Boolean(dirError));
        else member.req.reject(error);
      }
    }
  }

  /**
   * A group member failed and its files cannot be proven gone: keep every file that MAY exist (not the ones whose rename never
   * happened) in the index as a fenced, replayable plan, and tell the caller with the stable logical batch identity. A
   * restart does not clear the fence: recovery only ACKs a partial plan whose receipts are all committed.
   * @param {any} member @param {any} cause @param {boolean} wholeGroupUnproven the directory itself could not be proven durable
   */
  function rejectUncertain(member, cause, wholeGroupUnproven) {
    for (const job of member.jobs) {
      if (!job.touched || (!job.leftover && !wholeGroupUnproven)) continue;
      if (index.has(job.item.full.commandId)) continue;
      index.set(job.item.full.commandId, { file: job.file, bytes: job.item.bytes, entry: job.item.full });
      totalBytes += job.item.bytes;
      order = Math.max(order, job.item.full.order);
      uncertainIds.add(job.item.full.commandId);
    }
    const batchId = member.prepared[0]?.full.batch?.id;
    member.req.reject(new ChatHistoryAdapterError('history_cleanup_uncertain', 'A pending write failed and its files could not be proven discarded; they may still be replayed', {
      commandIds: member.jobs.map((job) => job.item.full.commandId).slice(0, 16), commitState: 'uncertain', cause: String(cause?.code ?? 'cleanup_failed'),
      ...(batchId === undefined ? {} : { batchId, retryToken: batchId }),
    }));
  }

  /**
   * Persist one command, or an entire logical batch, BEFORE anything is
   * dispatched. Concurrent callers are coalesced (one `setImmediate` window, bounded by entries and bytes): the
   * whole batch is budget-checked first, files are written in parallel and the directory is fsynced ONCE for the
   * group before any caller is resolved. A write failure removes every path the request created, so a refusal
   * never leaves a half-recorded plan behind (and never reports "not recorded" while recovery could still replay it).
   *
   * @param {Array<Omit<PendingEntry, 'createdAt' | 'order'>>} entries
   * @returns {Promise<PendingEntry[]>}
   */
  function recordMany(entries) {
    // Snapshot BEFORE the call is queued behind other writers (see snapshotEntry).
    let snapshots;
    try {
      snapshots = Array.from(entries, snapshotEntry);
    } catch (error) {
      return Promise.reject(error);
    }
    // Admission BEFORE the snapshot is retained: queued + running + indexed must fit the same count/byte quota the group enforces.
    const entriesNeeded = snapshots.length;
    const bytesNeeded = snapshots.reduce((sum, snap) => sum + (snapshotBytes.get(snap) ?? 0), 0);
    try {
      assertOpen();
      if (index.size + reservedEntries + entriesNeeded > maxEntries || totalBytes + reservedBytes + bytesNeeded > maxTotalBytes) {
        refuseHistory('history_pending_full', 'Pending buffer is full (queued writes included); earlier commands must be acknowledged first', {
          entries: index.size + reservedEntries, totalBytes: totalBytes + reservedBytes, needed: entriesNeeded, neededBytes: bytesNeeded, commitState: 'not_recorded',
        });
      }
    } catch (error) {
      return Promise.reject(error);
    }
    reservedEntries += entriesNeeded;
    reservedBytes += bytesNeeded;
    return new Promise((resolve, reject) => {
      const req = { snapshots, settled: false, resolve: (/** @type {any} */ value) => { release(); resolve(value); }, reject: (/** @type {any} */ error) => { release(); reject(error); } };
      // Synchronous with the index publication in the callers, so a reservation never counts together with its own index entry.
      function release() {
        if (req.settled) return;
        req.settled = true;
        reservedEntries -= entriesNeeded;
        reservedBytes -= bytesNeeded;
      }
      recordQueue.push(req);
      scheduleRecordFlush();
    });
  }

  /**
   * Persist a command before it is dispatched.
   *
   * @param {Omit<PendingEntry, 'createdAt' | 'order'>} entry
   * @returns {Promise<PendingEntry>}
   */
  async function record(entry) {
    const [full] = await recordMany([entry]);
    return full;
  }

  /** @type {Array<{ ids: string[], single: boolean, resolve: (v: any) => void, reject: (e: unknown) => void }>} */
  const ackQueue = [];
  let ackFlushScheduled = false;

  /** Bound on queued ACK ids. A refused ACK loses nothing: the pending file (and the committed receipt) stay, and a later ACK or recovery removes it. */
  function admitAck(count, reject) {
    const queued = ackQueue.reduce((sum, req) => sum + req.ids.length, 0);
    if (queued + count > maxEntries) {
      reject(new ChatHistoryAdapterError('history_pending_full', 'Too many acknowledgements are queued; the pending entries stay until a later acknowledgement or recovery', { queued, commitState: 'committed_unacknowledged' }));
      return false;
    }
    return true;
  }

  function scheduleAckFlush() {
    if (ackFlushScheduled) return;
    ackFlushScheduled = true;
    setImmediate(() => {
      ackFlushScheduled = false;
      serialized(runAckGroup).catch(() => {});
    });
  }

  /** A logical batch (several ids) keeps its own sequential unlink + directory fsync per id, so a crash part way leaves a SUFFIX. */
  async function runSequentialAck(req) {
    let removed = 0;
    for (const commandId of req.ids) {
      const held = index.get(commandId);
      if (!held) continue;
      await fsp.rm(held.file, { force: true });
      await fsyncDir(entriesDir);
      index.delete(commandId);
      uncertainIds.delete(commandId);
      totalBytes -= held.bytes;
      removed += 1;
    }
    return removed;
  }

  async function runAckGroup() {
    /** @type {Array<{ req: any, commandId: string, held: any, error?: unknown }>} */
    const group = [];
    const groupIds = new Set();
    const groupBatches = new Set();
    const flushGroup = async () => {
      if (group.length === 0) return;
      await forEachBounded(group, GROUP_WRITE_CONCURRENCY, async (member) => {
        try { await fsp.rm(member.held.file, { force: true }); } catch (error) { member.error = error; }
      });
      let syncError = null;
      if (group.some((member) => !member.error)) await fsyncDir(entriesDir).catch((error) => { syncError = error; });
      for (const member of group) {
        if (member.error || syncError) { member.req.reject(member.error ?? syncError); continue; }
        index.delete(member.commandId);
        uncertainIds.delete(member.commandId);
        totalBytes -= member.held.bytes;
        member.req.resolve(member.req.single ? true : 1);
      }
      group.length = 0;
      groupIds.clear();
      groupBatches.clear();
    };
    try {
      while (ackQueue.length > 0 && group.length < GROUP_MAX_ENTRIES) {
        const req = ackQueue[0];
        try { assertOpen(); } catch (error) { ackQueue.shift(); req.reject(error); continue; }
        if (req.ids.length > 1) {
          if (group.length > 0) break;
          ackQueue.shift();
          try { req.resolve(await runSequentialAck(req)); } catch (error) { req.reject(error); }
          continue;
        }
        const commandId = req.ids[0];
        const held = commandId === undefined ? undefined : index.get(commandId);
        if (!held) {
          ackQueue.shift();
          req.resolve(req.single ? false : 0);
          continue;
        }
        const batchId = held.entry.batch?.id;
        // Same id or same logical batch twice in one group would break the suffix guarantee: it goes to the next group.
        if (groupIds.has(commandId) || (batchId !== undefined && groupBatches.has(batchId))) break;
        ackQueue.shift();
        groupIds.add(commandId);
        if (batchId !== undefined) groupBatches.add(batchId);
        group.push({ req, commandId, held });
      }
      await flushGroup();
    } catch (error) {
      for (const member of group) member.req.reject(error);
    }
    if (ackQueue.length > 0) scheduleAckFlush();
  }

  /**
   * Remove several entries, lowest batch index first (a crash part way leaves a
   * SUFFIX, which open-time recovery recognises as an already committed batch).
   * A single-id call is coalesced with concurrent ones into one directory fsync.
   *
   * @param {string[]} commandIds
   * @returns {Promise<number>} how many entries were removed
   */
  function ackMany(commandIds) {
    const ids = Array.from(commandIds);
    return new Promise((resolve, reject) => {
      if (!admitAck(ids.length, reject)) return;
      ackQueue.push({ ids, single: false, resolve, reject });
      scheduleAckFlush();
    });
  }

  /** @param {string} batchId @returns {PendingEntry[]} the batch's entries by index */
  function listBatch(batchId) {
    assertOpen();
    return [...index.values()].map((held) => held.entry).filter((entry) => entry.batch?.id === batchId).sort((a, b) => /** @type {PendingBatch} */ (a.batch).index - /** @type {PendingBatch} */ (b.batch).index);
  }

  /**
   * Remove a command whose durable receipt was observed (or that is known not
   * to have committed and was reported as failed to its caller).
   *
   * @param {string} commandId
   * @returns {Promise<boolean>}
   */
  function ack(commandId) {
    return new Promise((resolve, reject) => {
      if (!admitAck(1, reject)) return;
      ackQueue.push({ ids: [commandId], single: true, resolve, reject });
      scheduleAckFlush();
    });
  }

  /**
   * Move an entry that can never be replayed (stale epoch, other generation)
   * out of the replay set without deleting it: an operator can inspect it.
   *
   * @param {string} commandId
   * @param {string} reason
   * @returns {Promise<boolean>}
   */
  function quarantine(commandId, reason) {
    return serialized(async () => {
      assertOpen();
      const held = index.get(commandId);
      if (!held) return false;
      const target = path.join(quarantineDir, `${path.basename(held.file, '.json')}.${now()}.json`);
      await writeDurable(target, `${JSON.stringify({ v: PENDING_BUFFER_SCHEMA, reason, ...held.entry })}\n`);
      await fsp.rm(held.file, { force: true });
      await fsyncDir(entriesDir);
      index.delete(commandId);
      uncertainIds.delete(commandId);
      totalBytes -= held.bytes;
      return true;
    });
  }

  /** @param {string[]} commandIds @param {string} reason @returns {Promise<number>} */
  async function quarantineMany(commandIds, reason) {
    let moved = 0;
    for (const commandId of commandIds) if (await quarantine(commandId, reason)) moved += 1;
    return moved;
  }

  /** @returns {PendingEntry[]} pending commands in the order they were recorded */
  function list() {
    assertOpen();
    return [...index.values()].map((held) => held.entry).sort((a, b) => a.order - b.order);
  }

  /** @param {string} commandId @returns {PendingEntry | null} */
  function get(commandId) {
    return index.get(commandId)?.entry ?? null;
  }

  function stats() {
    return { entries: index.size, totalBytes, producers: counters.size, deniedProducers: deniedCounters.size, openQuarantined: stats_.openQuarantined };
  }

  return Object.freeze({ open, reserveClientSeq, record, recordMany, ack, ackMany, quarantine, quarantineMany, list, listBatch, get, stats, get isOpen() { return opened; } });
}

export { ChatHistoryAdapterError };
