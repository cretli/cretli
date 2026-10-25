/**
 * IndexedDB chat metadata schema — pure helpers (DOM-free, node-testable).
 *
 * Stage 5.1: whitelist, index fields, retention selection. Archive reads belong to 7.1.
 */

import { sanitizeChatRowForBootCache } from './chatLocalBootCache.js';

/** Browser database name for chat metadata (distinct from `cretli-sdk-chat`). */
export const CHAT_METADATA_IDB_NAME = 'cretli-chat-metadata';

/** Bump when object stores or indexes change. */
export const CHAT_METADATA_IDB_VERSION = 1;

export const CHAT_METADATA_STORE_META = 'meta';
export const CHAT_METADATA_STORE_CHATS = 'chats';

export const CHAT_METADATA_INDEX_WORKSPACE = 'byWorkspace';
export const CHAT_METADATA_INDEX_ARCHIVED = 'byArchived';
export const CHAT_METADATA_INDEX_RANKING = 'byRankingMs';

/** Max chat metadata rows in IDB (independent of boot snapshot cap 300). */
export const CHAT_METADATA_MAX_CHAT_ROWS = 5000;

/** Fields that must never be persisted (runtime / network handles). */
export const CHAT_METADATA_RUNTIME_DENYLIST = Object.freeze([
  'pane',
  'ws',
  'socket',
  'view',
  'el',
  'element',
  '_buffer',
  '_pushPreview',
]);

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseIsoMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * @param {unknown} chat
 * @returns {string}
 */
export function deriveWorkspaceKey(chat) {
  if (!chat || typeof chat !== 'object') return '';
  const file = typeof chat.workspaceFile === 'string' ? chat.workspaceFile.trim() : '';
  const folder = typeof chat.workspaceFolder === 'string' ? chat.workspaceFolder.trim() : '';
  if (file && folder) return `${file}\0${folder}`;
  if (file) return file;
  if (folder) return `\0${folder}`;
  return '';
}

/**
 * @param {unknown} chat
 * @returns {0 | 1}
 */
export function deriveArchivedFlag(chat) {
  if (!chat || typeof chat !== 'object') return 0;
  const archivedAt = typeof chat.archivedAt === 'string' ? chat.archivedAt.trim() : '';
  return archivedAt ? 1 : 0;
}

/**
 * @param {unknown} chat
 * @returns {number}
 */
export function deriveRankingUpdatedAtMs(chat) {
  if (!chat || typeof chat !== 'object') return 0;
  return Math.max(parseIsoMs(chat.updatedAt), parseIsoMs(chat.createdAt));
}

/**
 * Strip runtime keys recursively (one level — nested objects are copied without deny keys).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripRuntimeFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (CHAT_METADATA_RUNTIME_DENYLIST.includes(key)) continue;
    if (key.startsWith('_')) continue;
    out[key] = child;
  }
  return out;
}

/**
 * Build a storable chat metadata record (round-trip safe, no runtime objects).
 *
 * @param {unknown} chat
 * @param {{ sessionId?: string, generation?: number, savedAt?: number }} scope
 * @returns {object | null}
 */
export function buildChatMetadataRecord(chat, scope = {}) {
  const base = sanitizeChatRowForBootCache(stripRuntimeFields(chat));
  if (!base || typeof base !== 'object' || !base.id) return null;
  const sessionId = typeof scope.sessionId === 'string' ? scope.sessionId : '';
  const generation = Number.isFinite(Number(scope.generation)) ? Math.floor(Number(scope.generation)) : 1;
  const savedAt = Number.isFinite(Number(scope.savedAt)) ? Number(scope.savedAt) : Date.now();
  return {
    ...base,
    sessionId,
    generation,
    savedAt,
    workspaceKey: deriveWorkspaceKey(base),
    archivedFlag: deriveArchivedFlag(base),
    rankingUpdatedAtMs: deriveRankingUpdatedAtMs(base),
  };
}

/**
 * @param {unknown} record
 * @returns {boolean}
 */
export function isChatMetadataRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  return Boolean(id);
}

/**
 * Choose ids to delete when over retention cap (lowest rank first; pinned kept).
 *
 * @param {Array<{ id: string, rankingUpdatedAtMs?: number, watcherPinned?: boolean }>} rows
 * @param {number} [maxRows]
 * @returns {string[]}
 */
export function selectChatMetadataRetentionDeletes(rows, maxRows = CHAT_METADATA_MAX_CHAT_ROWS) {
  const cap = Number.isFinite(Number(maxRows)) ? Math.max(0, Math.floor(Number(maxRows))) : 0;
  if (!Array.isArray(rows) || rows.length <= cap) return [];
  const pinned = new Set();
  const candidates = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;
    if (row.watcherPinned === true) {
      pinned.add(id);
      continue;
    }
    candidates.push({
      id,
      rank: Number.isFinite(Number(row.rankingUpdatedAtMs)) ? Number(row.rankingUpdatedAtMs) : 0,
    });
  }
  const overflow = rows.length - cap;
  if (overflow <= 0) return [];
  candidates.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  /** @type {string[]} */
  const deletes = [];
  for (const item of candidates) {
    if (deletes.length >= overflow) break;
    if (pinned.has(item.id)) continue;
    deletes.push(item.id);
  }
  return deletes;
}
