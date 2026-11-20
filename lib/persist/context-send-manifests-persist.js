/**
 * Per-chat context send manifests, stored outside the repo through the Cretli
 * persist layer (`data/context-send-manifests.json`).
 *
 * Shape: { v, chats: { [chatId]: Manifest[] }, previews: { [chatId]: Preview } }
 * Manifests are newest-last. A manifest never holds prompt text, block text or
 * tool results; only ids, hashes, sizes and reasons (see context-send-manifest.js).
 *
 * Writes go to an append-only journal (`.journal`) replayed on load and folded
 * into the snapshot on compaction, so a send never rewrites the whole file.
 *
 * Retention: the 20 latest sends per chat, nothing older than 7 days, and the
 * whole record goes away with the chat (`deleteContextSendManifests`). Size
 * bounds on top of that: only the newest 3 manifests per chat keep the heavy
 * per-entry `entries`/`blocks` arrays (older rows are compacted to the fields
 * the history list reads), and the whole snapshot is capped at
 * `STORE_MAX_BYTES` by dropping the oldest rows across chats first, always
 * keeping the newest 2 manifests of every chat that still exists.
 * Scope: this file belongs to ONE Cretli instance (its data dir). Cretli has no
 * shared persistence backend for manifests, so a second instance keeps its own
 * copy; the API reports `persistenceScope: 'local'` so the UI can say so.
 * Writes are idempotent by `sendId`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { recordWriteStat, writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

const STORE_VERSION = 1;
export const MAX_MANIFESTS_PER_CHAT = 20;
export const MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Newest manifests per chat that keep `entries`/`blocks` (the panel reads only the latest). */
export const FULL_MANIFESTS_PER_CHAT = 3;
/** Newest manifests per chat that the byte cap never evicts. */
export const PROTECTED_MANIFESTS_PER_CHAT = 2;
/** Approximate serialized size cap for all manifests together. */
export const STORE_MAX_BYTES = 8 * 1024 * 1024;
/** Heavy fields stripped from rows beyond the newest `FULL_MANIFESTS_PER_CHAT`. */
const HEAVY_FIELDS = ['entries', 'blocks', 'warnings', 'selection', 'budget'];
/** Journal lines that trigger a compaction (snapshot rewrite + journal reset). */
export const JOURNAL_COMPACT_LINES = 200;
/** Journal bytes that trigger a compaction, whichever limit is hit first. */
export const JOURNAL_COMPACT_BYTES = 2 * 1024 * 1024;

function storeFile() {
  return resolveDataPath('context-send-manifests.json');
}

/**
 * Append-only journal next to the snapshot. Each send appends one small line
 * instead of rewriting the whole snapshot; the snapshot is rewritten only on
 * compaction. Readers replay the journal over the snapshot, so nothing is lost
 * on restart and the snapshot format stays unchanged for existing consumers.
 */
function journalFile() {
  return `${storeFile()}.journal`;
}

/** @type {{ file: string, sig: string, store: any, journalLines: number, journalBytes: number, backupRequired?: boolean } | null} */
let cache = null;
/** Counts snapshot rewrites (observable from tests). */
let snapshotWrites = 0;

export function getContextManifestSnapshotWrites() {
  return snapshotWrites;
}

/** @param {string} file */
function statSig(file) {
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.ino}:${st.mtimeNs ?? BigInt(Math.round(Number(st.mtimeMs) * 1e6))}:${st.size}`;
  } catch {
    return '-';
  }
}

function currentSig() {
  return `${statSig(storeFile())}|${statSig(journalFile())}`;
}

/**
 * @param {{ chats: Record<string, any[]>, previews: Record<string, any> }} store
 * @param {any} op
 */
function applyOp(store, op) {
  if (!op || typeof op !== 'object' || !op.chatId) return;
  if (op.op === 'append' && op.row) {
    const list = Array.isArray(store.chats[op.chatId]) ? store.chats[op.chatId] : [];
    if (!list.some((row) => row?.sendId === op.row.sendId)) list.push(op.row);
    store.chats[op.chatId] = list;
  } else if (op.op === 'preview' && op.preview) {
    store.previews[op.chatId] = op.preview;
  } else if (op.op === 'delete') {
    delete store.chats[op.chatId];
    delete store.previews[op.chatId];
  }
}

/** Drop heavy fields from a row (kept: ids, hashes, counts, delivery, preview). */
function compactRow(row) {
  if (!row || row.compacted || !HEAVY_FIELDS.some((key) => key in row)) return row;
  const slim = { ...row, compacted: true };
  for (const key of HEAVY_FIELDS) delete slim[key];
  return slim;
}

/** Compact every row except the newest `FULL_MANIFESTS_PER_CHAT` of a chat. */
function compactOlderRows(list) {
  const cut = list.length - FULL_MANIFESTS_PER_CHAT;
  return cut > 0 ? list.map((row, i) => (i < cut ? compactRow(row) : row)) : list;
}

/**
 * Apply retention to every chat, compact older rows, enforce the byte cap and
 * drop chats left empty.
 */
function pruneStore(store, nowMs) {
  /** @type {{ chatId: string, row: any, at: number, size: number, rank: number }[]} */
  const evictable = [];
  let changed = false;
  let total = 0;
  for (const chatId of Object.keys(store.chats)) {
    const original = Array.isArray(store.chats[chatId]) ? store.chats[chatId] : [];
    const kept = compactOlderRows(applyRetention(original, nowMs));
    const originalRows = new Set(original);
    if (kept.length !== original.length || kept.some((row) => !originalRows.has(row))) changed = true;
    if (!kept.length) {
      delete store.chats[chatId];
      if (original.length) changed = true;
      continue;
    }
    store.chats[chatId] = kept;
    kept.forEach((row, i) => {
      const size = Buffer.byteLength(JSON.stringify(row));
      total += size;
      // rank = distance from the newest row; the newest PROTECTED rows are never evicted.
      const rank = kept.length - 1 - i;
      if (rank >= PROTECTED_MANIFESTS_PER_CHAT) evictable.push({ chatId, row, at: Date.parse(row?.recordedAt || '') || 0, size, rank });
    });
  }
  if (total <= STORE_MAX_BYTES) return changed;
  evictable.sort((a, b) => a.at - b.at);
  const drop = new Set();
  for (const item of evictable) {
    if (total <= STORE_MAX_BYTES) break;
    drop.add(item.row);
    total -= item.size;
  }
  if (!drop.size) return changed;
  changed = true;
  for (const chatId of Object.keys(store.chats)) store.chats[chatId] = store.chats[chatId].filter((row) => !drop.has(row));
  return changed;
}

/** Above this snapshot size a shrinking load first keeps a one-time backup. */
export const BACKUP_BEFORE_PRUNE_BYTES = 1024 * 1024;

/** Drop preview markers older than the manifest window (orphans never expire otherwise). */
function pruneOrphanPreviews(store, nowMs) {
  let changed = false;
  for (const chatId of Object.keys(store.previews)) {
    const at = Date.parse(store.previews[chatId]?.previewedAt || '');
    if (!(chatId in store.chats) && Number.isFinite(at) && nowMs - at > MANIFEST_MAX_AGE_MS) {
      delete store.previews[chatId];
      changed = true;
    }
  }
  return changed;
}

/** Copy an oversized snapshot to `<file>.pre-prune.bak` once, before it is shrunk. */
function backupSnapshotBeforePrune(file) {
  const backup = `${file}.pre-prune.bak`;
  try {
    if (fs.existsSync(backup) || fs.statSync(file).size < BACKUP_BEFORE_PRUNE_BYTES) return true;
    fs.copyFileSync(file, backup);
    return true;
  } catch {
    /* Keep the original snapshot if its required backup cannot be created. */
    return false;
  }
}

/** @returns {{ chats: Record<string, any[]>, previews: Record<string, any> }} */
function loadStore() {
  const file = storeFile();
  if (cache && cache.file === file && cache.sig === currentSig()) return cache.store;
  let store = { chats: {}, previews: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    store = {
      chats: data && typeof data.chats === 'object' && data.chats ? data.chats : {},
      previews: data && typeof data.previews === 'object' && data.previews ? data.previews : {},
    };
  } catch {
    /* missing or unreadable snapshot: start empty, the journal may still replay */
  }
  let lines = 0;
  let bytes = 0;
  try {
    const raw = fs.readFileSync(journalFile(), 'utf8');
    bytes = Buffer.byteLength(raw);
    for (const line of raw.split('\n')) {
      if (!line) continue;
      lines += 1;
      try { applyOp(store, JSON.parse(line)); } catch { /* torn tail line from a crash */ }
    }
  } catch {
    /* no journal */
  }
  cache = { file, sig: currentSig(), store, journalLines: lines, journalBytes: bytes };
  // Shrink an oversized legacy snapshot / replayed journal once, at load.
  const nowMs = Date.now();
  const chatRowsShrunk = pruneStore(store, nowMs);
  const previewsShrunk = pruneOrphanPreviews(store, nowMs);
  const shrunk = chatRowsShrunk || previewsShrunk;
  const backupReady = !shrunk || backupSnapshotBeforePrune(file);
  cache.backupRequired = !backupReady;
  if ((lines > 0 || shrunk) && backupReady) compact();
  return store;
}

/** Rewrite the snapshot from the cached store and reset the journal. */
function compact() {
  if (!cache) return;
  if (cache.backupRequired) {
    if (!backupSnapshotBeforePrune(storeFile())) return;
    cache.backupRequired = false;
  }
  pruneStore(cache.store, Date.now());
  writeJsonAtomic(storeFile(), { v: STORE_VERSION, ...cache.store }, 'utf8', { compact: true });
  snapshotWrites += 1;
  try { fs.rmSync(journalFile(), { force: true }); } catch { /* best effort */ }
  cache.journalLines = 0;
  cache.journalBytes = 0;
  cache.sig = currentSig();
}

/** Append one op to the journal (synchronous, small); compact when it grows. */
function journal(op) {
  const line = `${JSON.stringify(op)}\n`;
  const dir = path.dirname(journalFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ioStart = process.hrtime.bigint();
  fs.appendFileSync(journalFile(), line);
  recordWriteStat({
    filePath: journalFile(),
    bytes: Buffer.byteLength(line),
    ioMs: Number(process.hrtime.bigint() - ioStart) / 1e6,
  });
  cache.journalLines += 1;
  cache.journalBytes += Buffer.byteLength(line);
  if (cache.journalLines >= JOURNAL_COMPACT_LINES || cache.journalBytes >= JOURNAL_COMPACT_BYTES) compact();
  else cache.sig = currentSig();
}

/**
 * @param {any[]} list
 * @param {number} nowMs
 * @returns {any[]}
 */
function applyRetention(list, nowMs) {
  const fresh = list.filter((row) => {
    const at = Date.parse(row?.recordedAt || '');
    return Number.isFinite(at) && nowMs - at <= MANIFEST_MAX_AGE_MS;
  });
  return compactOlderRows(fresh.slice(-MAX_MANIFESTS_PER_CHAT));
}

/**
 * @param {string} chatId
 * @param {{ now?: () => number }} [options]
 * @returns {any[]} Newest last.
 */
export function listContextSendManifests(chatId, options = {}) {
  if (!chatId) return [];
  const nowMs = (options.now || Date.now)();
  const list = loadStore().chats[chatId];
  return Array.isArray(list) ? applyRetention(list, nowMs) : [];
}

/**
 * Store one manifest; a repeated `sendId` is a no-op (returns false).
 *
 * @param {string} chatId
 * @param {{ sendId: string, recordedAt?: string }} manifest
 * @param {{ now?: () => number }} [options]
 * @returns {boolean} Whether a new row was written.
 */
export function appendContextSendManifest(chatId, manifest, options = {}) {
  const sendId = String(manifest?.sendId || '');
  if (!chatId || !sendId) return false;
  const nowMs = (options.now || Date.now)();
  const store = loadStore();
  const list = Array.isArray(store.chats[chatId]) ? store.chats[chatId] : [];
  if (list.some((row) => row?.sendId === sendId)) return false;
  const row = { ...manifest, recordedAt: manifest.recordedAt || new Date(nowMs).toISOString() };
  store.chats[chatId] = applyRetention([...list, row], nowMs);
  journal({ op: 'append', chatId, row });
  return true;
}

/**
 * Remember the latest preview revision so the next send can flag a change.
 *
 * @param {string} chatId
 * @param {{ revision: string, adapter: string, previewedAt: string }} preview
 */
export function setContextPreviewMarker(chatId, preview) {
  if (!chatId || !preview?.revision) return;
  const store = loadStore();
  const marker = {
    revision: String(preview.revision),
    adapter: String(preview.adapter || ''),
    previewedAt: String(preview.previewedAt || ''),
  };
  const previous = store.previews[chatId];
  if (previous
    && previous.revision === marker.revision
    && previous.adapter === marker.adapter
    && previous.previewedAt === marker.previewedAt) return;
  store.previews[chatId] = marker;
  journal({ op: 'preview', chatId, preview: marker });
}

/**
 * @param {string} chatId
 * @returns {{ revision: string, adapter: string, previewedAt: string } | null}
 */
export function getContextPreviewMarker(chatId) {
  const marker = loadStore().previews[chatId];
  return marker && marker.revision ? marker : null;
}

/** @param {string} chatId */
export function deleteContextSendManifests(chatId) {
  if (!chatId) return;
  const store = loadStore();
  if (!(chatId in store.chats) && !(chatId in store.previews)) return;
  delete store.chats[chatId];
  delete store.previews[chatId];
  journal({ op: 'delete', chatId });
}
