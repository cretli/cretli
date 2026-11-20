/**
 * Revision + delta + gap-resync state for the chat list (docs/architecture-list-sync-contract.md).
 *
 * Read side only. The writer (`chats-persist.js`) is untouched: the sync state OBSERVES
 * catalog snapshots. When the observed key (store revision + derived flags) changes it
 * diffs per-row DTO digests against the previous observation and appends one bounded
 * ring entry; the monotonic `seq` counts those transitions. A client holds
 * `<epoch>.<seq>`; the server answers with a delta, a noop, or an explicit resync
 * (restart, gap, too large, ahead). Observation is memoized per key, so any number of
 * concurrent requests at one revision share a single O(N) pass.
 */

import { randomUUID } from 'node:crypto';
import { isChatInScope } from './chat-catalog.js';
import { toChatListDto } from './chat-list-dto.js';
import { readForkParentChatId, isChatArchived } from './chat-tree.js';

/** Frozen API payload caps (docs/architecture-baseline.md §5, frozen by human decision 2026-10-17). */
export const CHAT_LIST_SYNC_MAX_ROWS = 100;
export const CHAT_LIST_SYNC_MAX_BYTES = 128 * 1024;
export const CHAT_LIST_SYNC_RING_SIZE = 32;

export const CHAT_LIST_RESYNC_REASONS = Object.freeze({
  NO_SINCE: 'no-since',
  EPOCH: 'epoch',
  GAP: 'gap',
  AHEAD: 'ahead',
  TOO_LARGE: 'too-large',
});

/**
 * @param {unknown} token
 * @returns {{ epoch: string, seq: number } | null}
 */
export function parseSyncToken(token) {
  const match = /^([A-Za-z0-9-]{1,64})\.(\d{1,15})$/.exec(String(token ?? ''));
  return match ? { epoch: match[1], seq: Number(match[2]) } : null;
}

/**
 * @param {{ epoch: string, seq: number }} state
 * @returns {string}
 */
export function formatSyncToken(state) {
  return `${state.epoch}.${state.seq}`;
}

/**
 * Scope-relevant fields of a row; kept per id so a removal can be authorized for the
 * scope that could see the row without retaining the whole DTO.
 *
 * @param {Record<string, any>} dto
 * @returns {Record<string, any>}
 */
function scopeFieldsOf(dto) {
  return {
    id: dto.id,
    widgetInstallationId: dto.widgetInstallationId,
    widgetPageSessionId: dto.widgetPageSessionId,
    workspaceFolder: dto.workspaceFolder,
    workspaceFile: dto.workspaceFile,
  };
}

/**
 * The serialized DTO is its own digest: collision-free and cheaper than hashing it
 * (measured ~9 ms of ~38 ms per pass at 20 000 chats); memory is one DTO string per chat.
 *
 * @param {Record<string, any>} dto
 * @returns {string}
 */
function digestDto(dto) {
  return JSON.stringify(dto);
}

/**
 * @param {{ epoch?: string, ringSize?: number, maxRows?: number, maxBytes?: number }} [options]
 */
export function createChatListSyncState(options = {}) {
  const epoch = options.epoch || randomUUID();
  const ringSize = options.ringSize || CHAT_LIST_SYNC_RING_SIZE;
  const maxRows = options.maxRows || CHAT_LIST_SYNC_MAX_ROWS;
  const maxBytes = options.maxBytes || CHAT_LIST_SYNC_MAX_BYTES;
  let seq = 0;
  let observedKey = null;
  /** @type {Map<string, { h: string, s: Record<string, any> }>} id -> digest and scope fields of the latest observation */
  let digests = new Map();
  /** @type {Array<{ toSeq: number, overflow: boolean, changes: Array<{ id: string, prev: Record<string, any> | null, next: Record<string, any> | null }> }>} */
  const ring = [];

  /**
   * Observe a catalog snapshot. Memoized per (revision, extras key): repeated calls at
   * the same key are O(1) and return the same position, which is the in-flight
   * coalescing guarantee (N concurrent requests -> one diff pass).
   *
   * @param {{ revision: string, list: Function }} catalog
   * @param {{ worktreeTodoIds?: Set<string> }} [extras]
   * @returns {{ epoch: string, seq: number, revision: string }}
   */
  function observe(catalog, extras = {}) {
    const worktreeIds = extras.worktreeTodoIds instanceof Set ? [...extras.worktreeTodoIds].sort() : [];
    const key = `${catalog.revision}|${worktreeIds.join(',')}`;
    if (key === observedKey) return { epoch, seq, revision: catalog.revision };
    const wtSet = new Set(worktreeIds);
    /** @type {Map<string, Record<string, any>>} */
    const nextDtos = new Map();
    const nextRows = new Map();
    for (const chat of catalog.list()) {
      const todoId = typeof chat.todoId === 'string' ? chat.todoId.trim() : '';
      const dto = toChatListDto(chat, { onWorktree: Boolean(todoId && wtSet.has(todoId)) });
      // Duplicate ids keep the first row (catalog contract).
      if (!dto || nextRows.has(dto.id)) continue;
      const h = digestDto(dto);
      nextRows.set(dto.id, { h, s: scopeFieldsOf(dto) });
      if (observedKey !== null && digests.get(dto.id)?.h !== h) nextDtos.set(dto.id, dto);
    }
    if (observedKey === null) {
      seq = 1;
    } else {
      const changes = [];
      let overflow = false;
      for (const id of nextDtos.keys()) {
        if (changes.length >= maxRows) { overflow = true; break; }
        changes.push({ id, prev: digests.get(id)?.s ?? null, next: nextRows.get(id).s });
      }
      for (const id of digests.keys()) {
        if (nextRows.has(id)) continue;
        if (changes.length >= maxRows) { overflow = true; break; }
        changes.push({ id, prev: digests.get(id).s, next: null });
      }
      seq += 1;
      ring.push({ toSeq: seq, overflow, changes });
      if (ring.length > ringSize) ring.shift();
    }
    digests = nextRows;
    observedKey = key;
    return { epoch, seq, revision: catalog.revision };
  }

  return Object.freeze({ epoch, observe, ring, getSeq: () => seq, internals: { maxRows, maxBytes } });
}

/**
 * Build the delta answer for a client token. Pure over (state, catalog, request).
 *
 * Ring entries keep ids plus scope-relevant fields of the previous/next row. A touched id
 * is upserted from the CURRENT catalog when it is in scope, and reported as removed only
 * when it left scope or disappeared AND some observed state of it was visible to this scope.
 *
 * @param {ReturnType<typeof createChatListSyncState>} state
 * @param {{ revision: string, get: (id: string) => Record<string, any> | null, list: Function }} catalog
 * @param {{ since?: string, scope?: Record<string, any>, matcher?: (chat: Record<string, any>, scope: Record<string, any>) => boolean, worktreeTodoIds?: Set<string> }} request
 * @returns {Record<string, any>}
 */
export function buildChatListSyncResponse(state, catalog, request = {}) {
  const position = state.observe(catalog, { worktreeTodoIds: request.worktreeTodoIds });
  const base = { dtoVersion: 1, epoch: position.epoch, seq: position.seq, revision: position.revision };
  const resync = (reason) => ({ ...base, mode: 'resync', reason });
  if (request.since === undefined || request.since === '') return resync(CHAT_LIST_RESYNC_REASONS.NO_SINCE);
  const since = parseSyncToken(request.since);
  if (!since) {
    const err = /** @type {Error & { code?: string }} */ (new Error('Malformed since token'));
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }
  if (since.epoch !== position.epoch) return resync(CHAT_LIST_RESYNC_REASONS.EPOCH);
  if (since.seq > position.seq) return resync(CHAT_LIST_RESYNC_REASONS.AHEAD);
  if (since.seq === position.seq) return { ...base, mode: 'noop', since: since.seq };
  const entries = state.ring.filter((entry) => entry.toSeq > since.seq);
  if (entries.length !== position.seq - since.seq) return resync(CHAT_LIST_RESYNC_REASONS.GAP);
  if (entries.some((entry) => entry.overflow)) return resync(CHAT_LIST_RESYNC_REASONS.TOO_LARGE);
  const scope = request.scope || {};
  const matcher = request.matcher;
  // id -> true when any observed state of the row since the client position was visible to this scope.
  const touched = new Map();
  for (const entry of entries) {
    for (const change of entry.changes) {
      const visible = [change.prev, change.next].some((row) => row && isChatInScope(row, scope, matcher));
      touched.set(change.id, touched.get(change.id) === true || visible);
    }
  }
  const wt = request.worktreeTodoIds instanceof Set ? request.worktreeTodoIds : new Set();
  const dtoOf = (chat) => {
    const todoId = typeof chat.todoId === 'string' ? chat.todoId.trim() : '';
    return toChatListDto(chat, { onWorktree: Boolean(todoId && wt.has(todoId)) });
  };
  const upserts = new Map();
  const removed = [];
  for (const [id, wasVisible] of touched) {
    const chat = catalog.get(id);
    if (chat && isChatInScope(chat, scope, matcher)) upserts.set(id, dtoOf(chat));
    // A removal is only reported when this scope could see the row, so ids of foreign
    // chats never leak to a widget.
    else if (wasVisible) removed.push(id);
  }
  // Archived ancestors of an upserted live row travel with it, so a row that is
  // un-archived or moved never arrives without its parent chain.
  for (const dto of [...upserts.values()]) {
    if (isChatArchived(dto)) continue;
    const seen = new Set();
    let parentId = readForkParentChatId(dto);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = catalog.get(parentId);
      if (!parent || !isChatArchived(parent) || !isChatInScope(parent, scope, matcher)) break;
      if (!upserts.has(parentId)) upserts.set(parentId, dtoOf(parent));
      parentId = readForkParentChatId(parent);
    }
  }
  const response = { ...base, mode: 'delta', since: since.seq, upserts: [...upserts.values()], removed };
  if (response.upserts.length + removed.length > state.internals.maxRows) return resync(CHAT_LIST_RESYNC_REASONS.TOO_LARGE);
  if (JSON.stringify(response).length > state.internals.maxBytes) return resync(CHAT_LIST_RESYNC_REASONS.TOO_LARGE);
  return response;
}

/** @type {ReturnType<typeof createChatListSyncState> | null} */
let processState = null;

/**
 * Process-wide sync state (one epoch per server process, so a restart forces a resync).
 *
 * @returns {ReturnType<typeof createChatListSyncState>}
 */
export function getChatListSyncState() {
  if (!processState) processState = createChatListSyncState();
  return processState;
}

/**
 * Drops the process state (tests only).
 * @returns {void}
 */
export function __resetChatListSyncStateForTest() {
  processState = null;
}
