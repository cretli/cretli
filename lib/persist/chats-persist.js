/**
 * Chat list persistence (SDK + OpenRouter harnesses).
 * data/chats.json: { chats: [ { id, title, cursorSessionId, agentTransport, createdAt } ] }
 *
 * Two API generations share this module during the mixed phase (ADR docs/storage-chats-metadata-decision.md, B1-B4):
 * - the synchronous exports below are the LEGACY `chats.json` implementation (unchanged behavior);
 * - the `*Async` exports go through the active chats runtime (lib/persist/chats-runtime.js), which owns an adapter:
 *   `chats-backend-legacy` (this file's sync code) or `chats-backend-sqlite`. Naming rule and caller list:
 *   docs/storage-chats-b-caller-inventory.md.
 * The sync API throws `chats_sync_api_unavailable` when the active runtime is not the legacy one.
 */

import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic, writeTextAtomic } from './atomic-write.js';
import { backupChatsBeforeWrite } from './chats-shrink-backup.js';
import { resolveDataPath, assertDataWriteAllowed } from '../runtime-paths.js';
import {
  applyAutoTitleToRow,
  applyChatUpdates,
  applyReadMarks,
  applySessionField,
  applyTitleLock,
  conversationForkArgs,
  isTemporaryForkOf,
  listView,
  migrateWorkspaceIdsOnList,
  planAddChat,
  publishAutoTitle,
  publishChatRead,
  publishChatUpdated,
  publishTitleLock,
  rotatedSdkChat,
  withTitleSource,
  temporaryForkTitle,
} from './chats-backend-domain.js';
import { broadcastChatListChanged } from '../chat-list-updates.js';
import { notifyChatCreated } from '../chat-created-push.js';
import { assertSyncChatsApi, createChatsRuntime, getActiveChatsRuntime } from './chats-runtime.js';
import { createLegacyChatsBackend } from './chats-backend-legacy.js';

export {
  CHAT_TITLE_SOURCES,
  createFreshSdkContextEntry,
  DEFAULT_CHAT_TITLE_RE,
  inferChatTitleSource,
  onChatArchived,
  setChatArchiveRejector,
  withTitleSource,
} from './chats-backend-domain.js';

/** @typedef {import('../shared-types/persist-records.js').ChatRecord} ChatRecord */

const DATA_FILE = resolveDataPath('chats.json');

/**
 * Parsed chat list keyed by inode, size and mtime. `saveChats` drops it.
 * Callers receive shallow copies so a title edit cannot dirty the cache.
 *
 * @type {{ signature: string, contentRevision?: string, chats: Record<string, any>[] } | null}
 */
let chatsCache = null;

/**
 * id -> cached row, built lazily from `chatsCache.chats` and dropped with it. Rows are the cache's own
 * objects (read-only for callers); lookups never copy the list.
 *
 * @type {{ source: Record<string, any>[], byId: Map<string, Record<string, any>> } | null}
 */
let chatsIndex = null;

/** Read counters for diagnostics and tests: file parses vs. cache hits vs. per-call list copies. */
const chatsReadStats = { parses: 0, hits: 0, listCopies: 0 };

/**
 * @returns {{ parses: number, hits: number, listCopies: number }}
 */
export function getChatsReadStats() {
  return { ...chatsReadStats };
}

/**
 * @returns {string}
 */
function readChatsFileSignature() {
  try {
    const stat = fs.statSync(DATA_FILE);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * @param {Record<string, any>[]} chats
 * @returns {Record<string, any>[]}
 */
function copyChats(chats) {
  chatsReadStats.listCopies += 1;
  const out = new Array(chats.length);
  for (let i = 0; i < chats.length; i += 1) out[i] = copyChatOnWrite(chats[i]);
  return out;
}

/**
 * Preserve the private-row behavior of loadChats without eagerly enumerating every field.
 * Cached rows are immutable; a returned row gets a shallow private copy on its first write.
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function copyChatOnWrite(row) {
  // Wrap the underlying row, never another copy-on-write proxy: rows of a committed list stay proxies, and nesting
  // them on every archive made each write slower than the one before.
  const base = cowTargets.get(row);
  if (base) row = base.copy() || base.target;
  let copy = null;
  const proxy = new Proxy(row, {
    get(target, key, receiver) {
      return Reflect.get(copy || target, key, receiver);
    },
    set(target, key, value) {
      if (!copy) copy = { ...target };
      return Reflect.set(copy, key, value);
    },
    deleteProperty(target, key) {
      if (!copy) copy = { ...target };
      return Reflect.deleteProperty(copy, key);
    },
    defineProperty(target, key, descriptor) {
      if (!copy) copy = { ...target };
      return Reflect.defineProperty(copy, key, descriptor);
    },
    ownKeys(target) {
      return Reflect.ownKeys(copy || target);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(copy || target, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    has(target, key) {
      return Reflect.has(copy || target, key);
    },
  });
  const target = row;
  cowTargets.set(proxy, { target, copy: () => copy });
  return proxy;
}

/**
 * Copy-on-write proxy -> its row and private copy, so serialization reads the plain object (no proxy traps) and
 * hits `rowJsonCache` for every row the caller did not change.
 *
 * @type {WeakMap<object, { target: Record<string, any>, copy: () => Record<string, any> | null }>}
 */
const cowTargets = new WeakMap();

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * @returns {import('../shared-types/persist-records.js').ChatRecord[]}
 */
export function loadChats() {
  assertSyncChatsApi();
  ensureDir();
  return readChatsForSignature(readChatsFileSignature());
}

/**
 * Read-side snapshot for the ChatCatalog: the same copy `loadChats()` returns plus
 * the store revision. The revision is a hash of the bytes actually read ('' when no
 * file exists), so it always describes the rows returned with it, even when the file
 * is rewritten with the same size and mtime. Never writes.
 *
 * @returns {{ chats: Record<string, any>[], revision: string }}
 */
export function loadChatsSnapshot() {
  assertSyncChatsApi();
  return readChatsSnapshot(true);
}

/**
 * Read-only snapshot with the same revision contract as `loadChatsSnapshot()`, but without copying
 * cached rows. Callers must never mutate the returned rows.
 *
 * @returns {{ chats: readonly Record<string, any>[], revision: string }}
 */
export function peekChatsSnapshot() {
  assertSyncChatsApi();
  return readChatsSnapshot(false);
}

/**
 * @param {boolean} copy
 * @returns {{ chats: Record<string, any>[] | readonly Record<string, any>[], revision: string }}
 */
function readChatsSnapshot(copy) {
  ensureDir();
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE);
  } catch {
    return { chats: [], revision: '' };
  }
  const revision = createHash('sha1').update(raw).digest('hex');
  if (chatsCache?.contentRevision === revision) {
    return { chats: copy ? copyChats(chatsCache.chats) : chatsCache.chats, revision };
  }
  try {
    const data = JSON.parse(raw.toString('utf8'));
    const all = Array.isArray(data.chats) ? data.chats : [];
    const chats = all.filter((chat) => chat && typeof chat === 'object').map(withTitleSource);
    chatsCache = { signature: readChatsFileSignature(), contentRevision: revision, chats };
    return { chats: copy ? copyChats(chats) : chats, revision };
  } catch {
    // Same recovery as readCachedChatRows: back up the damaged file instead of losing it.
    chatsCache = null;
    if (copy) return { chats: readChatsForSignature(readChatsFileSignature()), revision };
    return { chats: readCachedChatRows(readChatsFileSignature()) || [], revision };
  }
}

/**
 * @param {string} signature
 * @returns {Record<string, any>[]}
 */
function readChatsForSignature(signature) {
  if (!signature) return [];
  if (chatsCache?.signature === signature) {
    chatsReadStats.hits += 1;
    return copyChats(chatsCache.chats);
  }
  const cached = readCachedChatRows(signature);
  if (cached) return copyChats(cached);
  return [];
}

/**
 * Cached rows (no copy) for a file signature; parses the file once when the cache is stale.
 * Returned rows are shared: callers must not mutate them.
 *
 * @param {string} signature
 * @returns {Record<string, any>[] | null} null when the file is missing or unreadable
 */
function readCachedChatRows(signature) {
  if (!signature) return null;
  if (chatsCache?.signature === signature) {
    chatsReadStats.hits += 1;
    return chatsCache.chats;
  }
  try {
    chatsReadStats.parses += 1;
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const all = Array.isArray(data.chats) ? data.chats : [];
    const chats = all.filter((chat) => chat && typeof chat === 'object').map(withTitleSource);
    chatsCache = { signature, chats };
    return chats;
  } catch (err) {
    chatsCache = null;
    // Returning [] silently would let the next saveChats() overwrite the damaged
    // file and destroy every chat, so keep a copy the user can recover from.
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      assertDataWriteAllowed(DATA_FILE);
      fs.renameSync(DATA_FILE, backup);
      console.error(`[cretli] ${DATA_FILE} is unreadable (${err.message}). Moved to ${backup}.`);
    } catch (renameErr) {
      console.error(
        `[cretli] ${DATA_FILE} is unreadable (${err.message}) and could not be backed up: ${renameErr.message}`,
      );
    }
    return null;
  }
}

/**
 * Read-only view of the persisted rows without the per-call copy `loadChats()` makes. Hot polling paths
 * only; never mutate the returned rows.
 *
 * @returns {readonly Record<string, any>[]}
 */
export function peekChats() {
  assertSyncChatsApi();
  ensureDir();
  return readCachedChatRows(readChatsFileSignature()) || [];
}

/**
 * O(ids) lookup of persisted rows by id (read-only shared rows, unknown ids skipped, request order kept).
 *
 * @param {Iterable<string>} ids
 * @returns {Record<string, any>[]}
 */
export function peekChatsByIds(ids) {
  assertSyncChatsApi();
  const rows = peekChats();
  if (!chatsIndex || chatsIndex.source !== rows) {
    const byId = new Map();
    for (const row of rows) {
      if (typeof row.id === 'string') byId.set(row.id, row);
    }
    chatsIndex = { source: /** @type {Record<string, any>[]} */ (rows), byId };
  }
  const found = [];
  for (const id of ids) {
    const row = chatsIndex.byId.get(id);
    if (row) found.push(row);
  }
  return found;
}

/**
 * One persisted row by id as a private shallow copy, without copying the whole list. Prefer this over
 * `loadChats().find(...)` in read-only lookups.
 *
 * @param {string} id
 * @returns {Record<string, any> | null}
 */
export function getChatById(id) {
  assertSyncChatsApi();
  const key = String(id || '').trim();
  if (!key) return null;
  const row = peekChatsByIds([key])[0];
  return row ? { ...row } : null;
}

/**
 * @param {string} cursorSessionId
 * @returns {import('../shared-types/persist-records.js').ChatRecord | null}
 */
export function getChatByCursorSessionId(cursorSessionId) {
  assertSyncChatsApi();
  const row = peekChats().find((c) => c.cursorSessionId === cursorSessionId);
  return row ? { ...row } : null;
}

/**
 * @param {Array<ChatRecord>} chats
 */
export function saveChats(chats) {
  assertSyncChatsApi();
  ensureDir();
  // Cache-only count (like commitChatUpdate): never full-parse the file just for the shrink check.
  const previousCount = chatsCache ? chatsCache.chats.length : null;
  backupChatsBeforeWrite(DATA_FILE, previousCount, chats.length);
  chatsCache = null;
  chatsIndex = null;
  writeJsonAtomic(DATA_FILE, { chats });
}

/**
 * Serialized `JSON.stringify(row, null, 2)` text per row object, already indented for the `chats` array.
 * Cached rows are immutable (copy-on-write), so an unchanged row is never re-serialized.
 *
 * @type {WeakMap<object, string>}
 */
const rowJsonCache = new WeakMap();

/**
 * @param {Record<string, any>} row
 * @returns {string}
 */
function serializedRow(row) {
  const cow = cowTargets.get(row);
  if (cow) row = cow.copy() || cow.target;
  let text = rowJsonCache.get(row);
  if (text === undefined) {
    text = `    ${JSON.stringify(row, null, 2).replace(/\n/g, '\n    ')}`;
    rowJsonCache.set(row, text);
  }
  return text;
}

/**
 * Same bytes as `JSON.stringify({ chats }, null, 2)`, reusing per-row text for rows that did not change.
 *
 * @param {Record<string, any>[]} chats
 * @returns {string}
 */
function serializeChatsFile(chats) {
  if (!chats.length) return '{\n  "chats": []\n}';
  const parts = new Array(chats.length);
  for (let i = 0; i < chats.length; i += 1) {
    // JSON.stringify yields "null" for an undefined element; keep that shape.
    parts[i] = chats[i] && typeof chats[i] === 'object' ? serializedRow(chats[i]) : '    null';
  }
  return `{\n  "chats": [\n${parts.join(',\n')}\n  ]\n}`;
}

/**
 * Single-chat update, step 1: a list whose target row is a private copy and whose other rows are the
 * cache's shared (read-only) rows. Only a pointer array is copied, never the rows. Pair with
 * `commitChatUpdate`; the whole read-modify-write runs synchronously, so no other writer interleaves.
 *
 * @param {string} id
 * @returns {Record<string, any>[]}
 */
function loadChatsForUpdate(id) {
  ensureDir();
  const rows = readCachedChatRows(readChatsFileSignature());
  if (!rows) return [];
  const list = rows.slice();
  const idx = list.findIndex((c) => c.id === id);
  if (idx !== -1) list[idx] = { ...list[idx] };
  return list;
}

/**
 * Single-chat update, step 2: writes the list atomically (temp file + rename) and installs it as the
 * read cache, so the next read needs no re-parse. The previous cache array and its rows stay untouched
 * for readers that still hold them.
 *
 * @param {Record<string, any>[]} chats list from `loadChatsForUpdate`
 */
function commitChatUpdate(chats) {
  ensureDir();
  // Cache-only count: a single-chat update must not re-parse the whole file.
  backupChatsBeforeWrite(DATA_FILE, chatsCache ? chatsCache.chats.length : null, chats.length);
  chatsCache = null;
  chatsIndex = null;
  writeTextAtomic(DATA_FILE, serializeChatsFile(chats));
  const signature = readChatsFileSignature();
  if (signature) chatsCache = { signature, chats };
}


/**
 * @param {string} cursorSessionId - SDK session key (uuid)
 * @param {string} [title] - optional title
 * @param {string} [workspaceFile] - absolute path to the .code-workspace file (multi-root)
 * @param {string} [workspaceFolder] - logical workspace folder; also the default runner cwd
 * @param {string} [model] - agent model (e.g. Auto)
 * @param {{ executionFolder?: string, sdkMode?: string, sdkUiMode?: string, sdkSystemPrompt?: string, todoId?: string, isTemporary?: boolean, forkParentChatId?: string, forkKind?: string, summaries?: unknown[], delegationSessionIdentity?: string, delegationSessionGeneration?: number, agentTransport?: string, [key: string]: any }} [extras]
 * @returns {import('../shared-types/persist-records.js').ChatRecord}
 */
export function addChat(cursorSessionId, title, workspaceFile, workspaceFolder, model, extras = null) {
  assertSyncChatsApi();
  const chats = loadChats();
  const plan = planAddChat(listView(chats), cursorSessionId, title, workspaceFile, workspaceFolder, model, extras);
  if ('existing' in plan) return /** @type {any} */ (plan.existing);
  const entry = /** @type {any} */ (plan.entry);
  chats.push(entry);
  saveChats(chats);
  broadcastChatListChanged({ reason: 'create', chatId: entry.id });
  // Temporary fork chats (title/summary helpers) are internal and stay silent.
  if (entry.isTemporary !== true) {
    notifyChatCreated({ chatId: entry.id, chatTitle: entry.title });
  }
  return /** @type {any} */ (entry);
}

/**
 * Creates a persistent conversation fork with a new session and the source chat metadata.
 * @param {Record<string, any>} parentChat
 * @param {{
 *   workspaceFile?: string,
 *   workspaceFolder?: string,
 *   agentTransport?: string,
 *   model?: string,
 *   title?: string,
 *   forkKind?: string,
 * }} [overrides]
 * @returns {Record<string, any>}
 */
export function createConversationForkChat(parentChat, overrides = null) {
  return addChat(...conversationForkArgs(parentChat, overrides));
}

/**
 * Creates a temporary SDK chat for a fork (title / summary), replacing a previous fork of the same kind.
 * @param {string} parentChatId
 * @param {'title'|'summary'} forkKind
 * @param {string} [workspaceFile]
 * @param {string|null} [workspaceFolder]
 * @param {string} [model]
 * @returns {Record<string, any>}
 */
export function createTemporaryForkChat(parentChatId, forkKind, workspaceFile, workspaceFolder, model) {
  deleteTemporaryForkChats(parentChatId, forkKind);
  return addChat(randomUUID(), temporaryForkTitle(forkKind), workspaceFile, workspaceFolder, model || undefined, {
    isTemporary: true,
    forkParentChatId: parentChatId,
    forkKind,
    sdkMode: 'agent',
  });
}

/**
 * Removes the temporary fork chats linked to a source chat.
 * @param {string} parentChatId
 * @param {'title'|'summary'} [forkKind]
 * @returns {Array<Record<string, any>>}
 */
export function deleteTemporaryForkChats(parentChatId, forkKind) {
  assertSyncChatsApi();
  const chats = loadChats();
  const doomed = chats.filter((c) => isTemporaryForkOf(c, parentChatId, forkKind));
  if (doomed.length === 0) return [];
  const doomedIds = new Set(doomed.map((c) => c.id));
  saveChats(chats.filter((c) => !doomedIds.has(c.id)));
  return doomed;
}

/**
 * @param {string} id - our own chat id (uuid)
 */
export function removeChat(id) {
  assertSyncChatsApi();
  // filter() builds a fresh array and nothing mutates the rows, so the per-call row copy of
  // loadChats() is skipped; saveChats() drops the shared cache before writing.
  const chats = /** @type {Array<ChatRecord>} */ (peekChats().filter((c) => c.id !== id));
  saveChats(chats);
}

/**
 * Full server-side chat removal: the list entry plus any related data (chat history, title history, manifests,
 * Browser screenshots, media). Runs on the active chats runtime, so it is the same call on every adapter.
 *
 * The durable history delete runs FIRST: when it fails (typed adapter error, `details.retryToken` for an unknown
 * commit) the chat list entry and the other metadata are untouched, so the caller can retry with the same token and
 * nothing is orphaned. Once the history is gone, the remaining removals are local and idempotent.
 *
 * @param {string} id - chat id (uuid)
 * @param {{ retryToken?: string }} [options]
 */
export async function deleteChat(id, options = {}) {
  return getActiveChatsRuntime().api.deleteChatAsync(id, options);
}

/**
 * @param {string} id - chat id (uuid)
 * @param {{ title?: string, model?: string, sdkMode?: string, sdkUiMode?: string, sdkSystemPrompt?: string|null, summary?: string, summaryTitle?: string, todoId?: string|null, archived?: boolean, forkParentChatId?: string|null, executionFolder?: string|null, delegationSessionIdentity?: string|null, delegationSessionGeneration?: number, widgetPinnedUrl?: string|null, [key: string]: any }} updates - fields to update; summary + summaryTitle append one entry to summaries
 * @returns {import('../shared-types/persist-records.js').ChatRecord | null}
 */
export function updateChat(id, updates) {
  assertSyncChatsApi();
  // Archive and widget-pin dedupe rewrite OTHER rows. Those must be private copies: the shared cache rows carry a
  // cached serialized text (rowJsonCache), so an in-place edit would never reach the file.
  const touchesOtherRows = Object.prototype.hasOwnProperty.call(updates, 'archived')
    || Object.prototype.hasOwnProperty.call(updates, 'widgetPinnedUrl');
  const chats = touchesOtherRows ? loadChats() : loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const info = applyChatUpdates(chats, idx, id, updates);
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  publishChatUpdated(id, chats[idx], updates, info);
  return { ...chats[idx] };
}

/**
 * Archives several chats (each with its fork subtree, exactly like `updateChat(id, { archived: true })`) in ONE
 * list read and ONE durable write. Ids are processed in order and processing stops at the first failure (an
 * unknown id counts as a failure); everything applied before it is committed.
 *
 * @param {string[]} ids chat ids, children before parents
 * @returns {{ archived: string[], failed: boolean }} `archived` lists the ids whose archive was committed
 */
export function archiveChats(ids) {
  assertSyncChatsApi();
  const chats = loadChats();
  /** @type {{ id: string, idx: number, info: ReturnType<typeof applyChatUpdates> }[]} */
  const applied = [];
  let failed = false;
  for (const id of ids) {
    const idx = chats.findIndex((c) => c.id === id);
    if (idx === -1) { failed = true; break; }
    try {
      const info = applyChatUpdates(chats, idx, id, { archived: true });
      chats[idx].updatedAt = new Date().toISOString();
      applied.push({ id, idx, info });
    } catch {
      failed = true;
      break;
    }
  }
  if (applied.length) {
    commitChatUpdate(chats);
    for (const entry of applied) publishChatUpdated(entry.id, chats[entry.idx], { archived: true }, entry.info);
  }
  return { archived: applied.map((entry) => entry.id), failed };
}

/**
 * Records the read markers of a chat (`lastFinishedAt` / `lastSeenAt`) without
 * touching `updatedAt`, so the row never moves in the list. Broadcasts one
 * `read` frame that carries both values; clients patch the row in place.
 *
 * @param {string} id - chat id
 * @param {{ finishedAt?: string, seenAt?: string }} marks ISO timestamps
 * @returns {{ lastFinishedAt: string, lastSeenAt: string } | null} null when the chat is
 *   unknown or nothing changed
 */
export function markChatReadState(id, marks = {}) {
  assertSyncChatsApi();
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const state = applyReadMarks(chats[idx], marks);
  if (!state) return null;
  commitChatUpdate(chats);
  publishChatRead(id, state);
  return state;
}

/**
 * Applies a generated title. The only place that decides "auto never overwrites manual":
 * the chat is re-read synchronously right before the write, so a rename made while the
 * (slow) generation was running wins.
 *
 * @param {string} id - chat id (uuid)
 * @param {string} title
 * @param {{ reason?: string, expectedVersion?: number, force?: boolean }} [options]
 *   expectedVersion: titleRev observed when generation started (CAS); force: explicit regenerate
 * @returns {{ applied: boolean, skipped?: 'not_found' | 'empty' | 'manual' | 'stale' | 'unchanged', chat: Record<string, any> | null }}
 */
export function applyAutoTitle(id, title, options = {}) {
  assertSyncChatsApi();
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return { applied: false, skipped: 'not_found', chat: null };
  const chat = chats[idx];
  const outcome = applyAutoTitleToRow(chat, title, options);
  if (!outcome.applied) return { applied: false, skipped: outcome.skipped, chat };
  commitChatUpdate(chats);
  publishAutoTitle(id, chat, outcome.nextTitle, options.reason);
  return { applied: true, chat: { ...chat } };
}

/**
 * Title lock toggle (chat settings): locked => 'manual' (auto never overwrites it); unlocked =>
 * back to 'default' for a placeholder name, otherwise 'auto'. The title text itself is unchanged.
 *
 * @param {string} id - chat id (uuid)
 * @param {boolean} locked
 * @returns {Record<string, any> | null} the updated chat, or null when not found
 */
export function setChatTitleLocked(id, locked) {
  assertSyncChatsApi();
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const chat = chats[idx];
  if (!applyTitleLock(chat, locked)) return chat;
  commitChatUpdate(chats);
  publishTitleLock(id, chat);
  return { ...chat };
}

/**
 * Sets one server-owned session id field (see CHAT_SESSION_FIELDS) and returns the chat, or null when unknown.
 *
 * @param {string} id
 * @param {string} field
 * @param {string | null | undefined} value an empty value removes the field
 * @returns {Record<string, any> | null}
 */
function setChatSessionField(id, field, value) {
  assertSyncChatsApi();
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  if (!applySessionField(chats[idx], field, value)) return chats[idx];
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * Cloud @cursor/sdk agent id — set only by the server (SDK WebSocket), never through the public PATCH.
 * @param {string} id - chat id (uuid)
 * @param {string | null | undefined} sdkAgentId - e.g. bc-…; an empty value removes the field
 * @returns {Record<string, any> | null}
 */
export function setChatSdkAgentId(id, sdkAgentId) {
  return setChatSessionField(id, 'sdkAgentId', sdkAgentId);
}

/**
 * OpenCode session id — set by server when session.create succeeds.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} opencodeSessionId
 * @returns {Record<string, any> | null}
 */
export function setChatOpenCodeSessionId(id, opencodeSessionId) {
  return setChatSessionField(id, 'opencodeSessionId', opencodeSessionId);
}

/**
 * CodeBuddy session id — set by server from the SDK system/init message.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} codebuddySessionId
 * @returns {Record<string, any> | null}
 */
export function setChatCodeBuddySessionId(id, codebuddySessionId) {
  return setChatSessionField(id, 'codebuddySessionId', codebuddySessionId);
}

/**
 * DeepSeek Harness session id — set by the server from the first SDK run.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} deepseekSessionId
 * @returns {Record<string, any> | null}
 */
export function setChatDeepSeekSessionId(id, deepseekSessionId) {
  return setChatSessionField(id, 'deepseekSessionId', deepseekSessionId);
}

/**
 * Codex SDK thread id — set by the server from thread.started.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} codexThreadId
 * @returns {Record<string, any> | null}
 */
export function setChatCodexThreadId(id, codexThreadId) {
  return setChatSessionField(id, 'codexThreadId', codexThreadId);
}

/**
 * Qwen Code session id — set by the server after the first successful query().
 * @param {string} id - chat uuid
 * @param {string | null | undefined} qwenSessionId
 * @returns {Record<string, any> | null}
 */
export function setChatQwenSessionId(id, qwenSessionId) {
  return setChatSessionField(id, 'qwenSessionId', qwenSessionId);
}

/**
 * Claude Agent SDK session id — set by the server after the first query().
 * @param {string} id - chat uuid
 * @param {string | null | undefined} claudeSessionId
 * @returns {Record<string, any> | null}
 */
export function setChatClaudeSessionId(id, claudeSessionId) {
  return setChatSessionField(id, 'claudeSessionId', claudeSessionId);
}

/**
 * Detaches the chat from its old agent and local store by rotating the SDK session key.
 *
 * @param {string} id
 * @returns {Record<string, any> | null}
 */
export function rotateChatSdkSession(id) {
  assertSyncChatsApi();
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((chat) => chat.id === id);
  if (idx === -1) return null;
  chats[idx] = rotatedSdkChat(chats[idx]);
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * Fill `workspaceId` on chats whose folder belongs to exactly one registry
 * workspace. Never removes or rewrites existing fields (`workspaceFile` stays);
 * chats that already have a `workspaceId`, no folder, or an ambiguous folder
 * are skipped and counted.
 *
 * @param {Record<string, any>} settings - settings carrying the SQL registry view
 * @param {{ dryRun?: boolean }} [options] - dryRun (default true) only reports
 * @returns {{ dryRun: boolean, total: number, updated: number, alreadySet: number, noFolder: number, unmatched: number, ambiguous: number, assignments: Array<{ chatId: string, workspaceId: string }> }}
 */
export function migrateChatWorkspaceIds(settings, options = {}) {
  assertSyncChatsApi();
  const chats = loadChats();
  const report = migrateWorkspaceIdsOnList(chats, settings, options);
  if (!report.dryRun && report.updated > 0) saveChats(chats);
  return report;
}

// ---------------------------------------------------------------------------------------------------
// Async API (adapter-neutral). Convention: the same name with an `Async` suffix; see the caller inventory.
// ---------------------------------------------------------------------------------------------------

/**
 * Legacy adapter over the synchronous code of this file. It executes the sync body inside the async wrapper
 * (no await before it), so sync and async calls share one cache and are serialized by the event loop.
 */
export const legacyChatsBackend = createLegacyChatsBackend({
  loadChats, loadChatsSnapshot, peekChatsSnapshot, peekChats, peekChatsByIds, getChatById, getChatByCursorSessionId,
  saveChats, addChat, removeChat, deleteTemporaryForkChats, updateChat, markChatReadState, applyAutoTitle,
  setChatTitleLocked, setChatSessionField, rotateChatSdkSession, migrateChatWorkspaceIds, archiveChats,
});

// The default (and, until B5, only production) runtime.
getActiveChatsRuntime.installDefault(() => createChatsRuntime({ backend: legacyChatsBackend, backendKind: 'legacy' }));

/** @param {string} name */
const viaRuntime = (name) => (...args) => getActiveChatsRuntime().api[name](...args);

export const loadChatsAsync = viaRuntime('loadChatsAsync');
export const loadChatsSnapshotAsync = viaRuntime('loadChatsSnapshotAsync');
export const peekChatsSnapshotAsync = viaRuntime('peekChatsSnapshotAsync');
export const pageChatsAsync = viaRuntime('pageChatsAsync');
export const chatCountsAsync = viaRuntime('chatCountsAsync');
export const peekChatsAsync = viaRuntime('peekChatsAsync');
export const peekChatsByIdsAsync = viaRuntime('peekChatsByIdsAsync');
export const getChatByIdAsync = viaRuntime('getChatByIdAsync');
export const getChatByCursorSessionIdAsync = viaRuntime('getChatByCursorSessionIdAsync');
export const saveChatsAsync = viaRuntime('saveChatsAsync');
export const addChatAsync = viaRuntime('addChatAsync');
export const createConversationForkChatAsync = viaRuntime('createConversationForkChatAsync');
export const createTemporaryForkChatAsync = viaRuntime('createTemporaryForkChatAsync');
export const deleteTemporaryForkChatsAsync = viaRuntime('deleteTemporaryForkChatsAsync');
export const removeChatAsync = viaRuntime('removeChatAsync');
export const deleteChatAsync = viaRuntime('deleteChatAsync');
export const updateChatAsync = viaRuntime('updateChatAsync');
export const archiveChatsAsync = viaRuntime('archiveChatsAsync');
export const markChatReadStateAsync = viaRuntime('markChatReadStateAsync');
export const applyAutoTitleAsync = viaRuntime('applyAutoTitleAsync');
export const setChatTitleLockedAsync = viaRuntime('setChatTitleLockedAsync');
export const setChatSdkAgentIdAsync = viaRuntime('setChatSdkAgentIdAsync');
export const setChatOpenCodeSessionIdAsync = viaRuntime('setChatOpenCodeSessionIdAsync');
export const setChatCodeBuddySessionIdAsync = viaRuntime('setChatCodeBuddySessionIdAsync');
export const setChatDeepSeekSessionIdAsync = viaRuntime('setChatDeepSeekSessionIdAsync');
export const setChatCodexThreadIdAsync = viaRuntime('setChatCodexThreadIdAsync');
export const setChatQwenSessionIdAsync = viaRuntime('setChatQwenSessionIdAsync');
export const setChatClaudeSessionIdAsync = viaRuntime('setChatClaudeSessionIdAsync');
export const rotateChatSdkSessionAsync = viaRuntime('rotateChatSdkSessionAsync');
export const migrateChatWorkspaceIdsAsync = viaRuntime('migrateChatWorkspaceIdsAsync');
export const importChatsBatchAsync = viaRuntime('importChatsBatchAsync');
export const readChatsStrictAsync = viaRuntime('readChatsStrictAsync');
export const rollbackImportedChatsAsync = viaRuntime('rollbackImportedChatsAsync');
