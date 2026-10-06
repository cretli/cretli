/**
 * Synchronous cold-start bootstrap in localStorage (task 5.3).
 *
 * Keeps a tiny JSON document for first paint: active chat, header workspace context,
 * watcher-pinned rows, and the first N ranked list rows. Full snapshots (up to 300 rows)
 * live in IndexedDB via the persistence adapter; this key is never migrated off localStorage.
 *
 * Budget source: `docs/ui-freeze-baseline-2026-10-05.md` — small bootstrap ≤40 rows,
 * parse ≤5 ms, snapshot ≤64 KB on the reference machine.
 */

import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import {
  comparePreparedRankingUpdatedAtMsDesc,
  prepareChatRankingUpdatedAtMs,
} from './chatListSort.js';
import {
  CHAT_LOCAL_BOOT_CACHE_VERSION,
  parseChatLocalBootCache,
  readChatLocalBootCache,
  sanitizeChatRowForBootCache,
  sanitizeWorkspaceForBootCache,
} from './chatLocalBootCache.js';
import { getUiFreezeCounters } from '../../lib/uiFreezeCounters.js';

/** localStorage key for the synchronous bootstrap document. */
export const CHAT_LOCAL_BOOT_SYNC_KEY = 'cretli-chat-boot-sync-v1';

/** Schema version; mismatch discards the document. */
export const CHAT_LOCAL_BOOT_SYNC_VERSION = 1;

/**
 * Max chat rows in the sync bootstrap (N). Baseline 0.1: «mały bootstrap (≤40 wierszy)».
 */
export const CHAT_LOCAL_BOOT_SYNC_MAX_ROWS = 40;

/**
 * Max UTF-16 JSON size for the sync bootstrap. Baseline 0.1: ≤64 KB (65 536 B).
 */
export const CHAT_LOCAL_BOOT_SYNC_MAX_BYTES = 65536;

/** Workspaces copied into the sync doc (enough for grouping on cold start). */
export const CHAT_LOCAL_BOOT_SYNC_MAX_WORKSPACES = 10;

/**
 * @param {unknown} value
 * @returns {string}
 */
function readTrimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown[]} chats
 * @param {unknown} activeChatId
 * @param {number} maxRows
 * @returns {object[]}
 */
export function selectChatsForSyncBootstrap(chats, activeChatId, maxRows = CHAT_LOCAL_BOOT_SYNC_MAX_ROWS) {
  const cap = Number.isFinite(Number(maxRows)) ? Math.max(1, Number(maxRows)) : CHAT_LOCAL_BOOT_SYNC_MAX_ROWS;
  const rows = (Array.isArray(chats) ? chats : [])
    .map(sanitizeChatRowForBootCache)
    .filter(Boolean);
  const activeId = readTrimmed(activeChatId);
  const kept = new Set();
  /** @type {object[]} */
  const required = [];
  /** @type {object[]} */
  const rest = [];
  for (const row of rows) {
    if (kept.has(row.id)) continue;
    if (row.watcherPinned === true || (activeId && row.id === activeId)) {
      required.push(row);
      kept.add(row.id);
      continue;
    }
    rest.push(row);
  }
  const rankedRest = prepareChatRankingUpdatedAtMs(rest).sort(comparePreparedRankingUpdatedAtMsDesc);
  let selected = required.slice();
  for (const { chat: row } of rankedRest) {
    if (selected.length >= cap) break;
    if (kept.has(row.id)) continue;
    selected.push(row);
    kept.add(row.id);
  }
  if (selected.length <= cap) return selected;
  /** @type {object | null} */
  let activeRow = null;
  /** @type {object[]} */
  const pinnedRows = [];
  /** @type {object[]} */
  const otherRequired = [];
  for (const row of required) {
    if (activeId && row.id === activeId) {
      activeRow = row;
      continue;
    }
    if (row.watcherPinned === true) pinnedRows.push(row);
    else otherRequired.push(row);
  }
  const rankedPinned = prepareChatRankingUpdatedAtMs(pinnedRows)
    .sort(comparePreparedRankingUpdatedAtMsDesc)
    .map(({ chat }) => chat);
  const rankedOtherRequired = prepareChatRankingUpdatedAtMs(otherRequired)
    .sort(comparePreparedRankingUpdatedAtMsDesc)
    .map(({ chat }) => chat);
  /** @type {object[]} */
  const prioritizedRequired = [];
  if (activeRow) prioritizedRequired.push(activeRow);
  prioritizedRequired.push(...rankedPinned, ...rankedOtherRequired);
  selected = prioritizedRequired.slice(0, cap);
  const selectedIds = new Set(selected.map((row) => row.id));
  for (const { chat: row } of rankedRest) {
    if (selected.length >= cap) break;
    if (selectedIds.has(row.id)) continue;
    selected.push(row);
    selectedIds.add(row.id);
  }
  return selected.slice(0, cap);
}

/**
 * @param {{
 *   v?: number,
 *   savedAt: number,
 *   activeChatId: string,
 *   workspaceContext: { workspaceFile: string, workspaceFolder: string },
 *   workspaces: object[],
 *   chats: object[],
 *   fullSignature?: string,
 * }} doc
 * @returns {typeof doc}
 */
export function trimSyncBootstrapToByteBudget(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const activeId = readTrimmed(doc.activeChatId);
  /** @type {Set<string>} */
  const requiredIds = new Set();
  for (const row of Array.isArray(doc.chats) ? doc.chats : []) {
    if (!row || typeof row !== 'object') continue;
    const id = readTrimmed(row.id);
    if (!id) continue;
    if (row.watcherPinned === true || (activeId && id === activeId)) requiredIds.add(id);
  }
  let chats = (Array.isArray(doc.chats) ? doc.chats : []).slice();
  while (chats.length > 0) {
    const json = JSON.stringify({ ...doc, chats });
    if (json.length <= CHAT_LOCAL_BOOT_SYNC_MAX_BYTES) {
      return { ...doc, chats };
    }
    let removed = false;
    for (let index = chats.length - 1; index >= 0; index -= 1) {
      const id = readTrimmed(chats[index]?.id);
      if (id && requiredIds.has(id)) continue;
      chats = chats.slice(0, index).concat(chats.slice(index + 1));
      removed = true;
      break;
    }
    if (!removed) break;
  }
  return { ...doc, chats };
}

/**
 * @param {Parameters<typeof import('./chatLocalBootCache.js').buildChatLocalBootCache>[0] | {
 *   v?: number,
 *   savedAt?: number,
 *   activeChatId?: string,
 *   workspaceContext?: { workspaceFile?: unknown, workspaceFolder?: unknown },
 *   workspaces?: unknown[],
 *   chats?: unknown[],
 *   fullSignature?: string,
 * }} input
 * @param {{ now?: number, fullSignature?: string }} [options]
 * @returns {ReturnType<typeof trimSyncBootstrapToByteBudget>}
 */
export function buildChatLocalBootSyncDoc(input = {}, options = {}) {
  const workspaceContext = input.workspaceContext && typeof input.workspaceContext === 'object'
    ? input.workspaceContext
    : {};
  const chats = selectChatsForSyncBootstrap(input.chats, input.activeChatId);
  const workspaces = (Array.isArray(input.workspaces) ? input.workspaces : [])
    .map(sanitizeWorkspaceForBootCache)
    .filter(Boolean)
    .slice(0, CHAT_LOCAL_BOOT_SYNC_MAX_WORKSPACES);
  const doc = {
    v: CHAT_LOCAL_BOOT_SYNC_VERSION,
    savedAt: Number.isFinite(Number(input.savedAt))
      ? Number(input.savedAt)
      : (Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()),
    activeChatId: readTrimmed(input.activeChatId),
    workspaceContext: {
      workspaceFile: readTrimmed(workspaceContext.workspaceFile),
      workspaceFolder: readTrimmed(workspaceContext.workspaceFolder),
    },
    workspaces,
    chats,
    fullSignature: typeof options.fullSignature === 'string' ? options.fullSignature : readTrimmed(input.fullSignature),
  };
  if (doc.chats.length === 0) return null;
  const trimmed = trimSyncBootstrapToByteBudget(doc);
  if (!trimmed || trimmed.chats.length > CHAT_LOCAL_BOOT_SYNC_MAX_ROWS) return null;
  const serialized = JSON.stringify(trimmed);
  if (serialized.length > CHAT_LOCAL_BOOT_SYNC_MAX_BYTES) return null;
  return trimmed;
}

/**
 * @param {unknown} raw
 * @returns {ReturnType<typeof buildChatLocalBootSyncDoc> | null}
 */
export function parseChatLocalBootSync(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  if (text.length > CHAT_LOCAL_BOOT_SYNC_MAX_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (Number(parsed.v) !== CHAT_LOCAL_BOOT_SYNC_VERSION) return null;
  const chats = Array.isArray(parsed.chats)
    ? parsed.chats.map(sanitizeChatRowForBootCache).filter(Boolean)
    : [];
  if (chats.length === 0) return null;
  const workspaces = Array.isArray(parsed.workspaces)
    ? parsed.workspaces.map(sanitizeWorkspaceForBootCache).filter(Boolean)
    : [];
  const workspaceContext = parsed.workspaceContext && typeof parsed.workspaceContext === 'object'
    ? parsed.workspaceContext
    : {};
  const doc = trimSyncBootstrapToByteBudget({
    v: CHAT_LOCAL_BOOT_SYNC_VERSION,
    savedAt: Number(parsed.savedAt) || 0,
    activeChatId: readTrimmed(parsed.activeChatId),
    workspaceContext: {
      workspaceFile: readTrimmed(workspaceContext.workspaceFile),
      workspaceFolder: readTrimmed(workspaceContext.workspaceFolder),
    },
    workspaces,
    chats,
    fullSignature: readTrimmed(parsed.fullSignature),
  });
  const serialized = JSON.stringify(doc);
  if (serialized.length > CHAT_LOCAL_BOOT_SYNC_MAX_BYTES) return null;
  return doc;
}

/**
 * @param {Storage | null | undefined} storage
 * @returns {ReturnType<typeof parseChatLocalBootSync>}
 */
export function readChatLocalBootSync(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    return parseChatLocalBootSync(readStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_SYNC_KEY, ''));
  } catch (_) {
    return null;
  }
}

/**
 * @param {Storage | null | undefined} storage
 * @param {ReturnType<typeof buildChatLocalBootSyncDoc> | Parameters<typeof buildChatLocalBootSyncDoc>[0]} docOrInput
 * @param {{ fullSignature?: string }} [options]
 * @returns {boolean}
 */
export function writeChatLocalBootSync(storage, docOrInput, options = {}) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  const doc = docOrInput && typeof docOrInput === 'object' && Array.isArray(docOrInput.chats)
    && Number(docOrInput.v) === CHAT_LOCAL_BOOT_SYNC_VERSION
    ? trimSyncBootstrapToByteBudget(docOrInput)
    : buildChatLocalBootSyncDoc(docOrInput, options);
  if (!doc) return false;
  const payload = JSON.stringify(doc);
  if (payload.length > CHAT_LOCAL_BOOT_SYNC_MAX_BYTES) return false;
  try {
    writeStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_SYNC_KEY, payload);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {Storage | null | undefined} storage
 */
export function clearChatLocalBootSync(storage) {
  if (!storage || typeof storage.removeItem !== 'function') return;
  try {
    removeStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_SYNC_KEY);
  } catch (_) {}
}

/**
 * Map a sync bootstrap document into the shape expected by `parseChatLocalBootCache`.
 *
 * @param {NonNullable<ReturnType<typeof parseChatLocalBootSync>>} syncDoc
 * @returns {ReturnType<typeof import('./chatLocalBootCache.js').parseChatLocalBootCache>}
 */
export function bootCacheViewFromSyncDoc(syncDoc) {
  return {
    v: CHAT_LOCAL_BOOT_CACHE_VERSION,
    savedAt: syncDoc.savedAt,
    activeChatId: syncDoc.activeChatId,
    workspaceContext: syncDoc.workspaceContext,
    workspaces: syncDoc.workspaces,
    chats: syncDoc.chats,
  };
}

/**
 * @param {Storage | null | undefined} storage
 * @param {import('./chatLocalBootCache.js').ReturnType<typeof import('./chatLocalBootCache.js').parseChatLocalBootCache>} [legacyFull]
 * @returns {ReturnType<typeof import('./chatLocalBootCache.js').parseChatLocalBootCache> | null}
 */
export function resolveColdStartBootCacheView(storage, legacyFull = null) {
  const syncDoc = readChatLocalBootSync(storage);
  if (syncDoc) return bootCacheViewFromSyncDoc(syncDoc);
  const legacy = legacyFull ?? null;
  if (legacy && legacy.chats.length > 0) {
    const syncSlice = buildChatLocalBootSyncDoc({
      savedAt: legacy.savedAt,
      activeChatId: legacy.activeChatId,
      workspaceContext: legacy.workspaceContext,
      workspaces: legacy.workspaces,
      chats: legacy.chats,
    });
    if (syncSlice) return bootCacheViewFromSyncDoc(syncSlice);
  }
  return legacy;
}

/**
 * @param {Storage | null | undefined} storage
 * @returns {ReturnType<typeof parseChatLocalBootCache>}
 */
export function readChatLocalBootCacheForColdStart(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  const counters = getUiFreezeCounters();
  if (counters) {
    counters.bump('cache.reads');
    counters.bump('storage.reads');
  }
  try {
    const legacyFull = readChatLocalBootCache(storage);
    return resolveColdStartBootCacheView(storage, legacyFull);
  } catch (_) {
    return null;
  }
}
