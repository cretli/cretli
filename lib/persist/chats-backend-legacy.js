/**
 * Legacy adapter of the chats facade: the `chats.json` code, behavior unchanged.
 *
 * The file code still lives in `chats-persist.js` (its synchronous exports have ~300 importers and are removed only
 * in B5, when the file code moves in here); this adapter receives those functions by injection, which avoids an
 * import cycle and keeps ONE cache and ONE read-modify-write path for sync and async callers. Each async method runs
 * the sync body before its first `await`, so a sync call and an async call in one process can never interleave.
 */

import fs from 'node:fs';
import { resolveDataPath } from '../runtime-paths.js';
import { lastActivityOf, workspaceKeyOf } from '../storage/chats-store.js';

const PAGE_DEFAULT_LIMIT = 50;
const PAGE_MAX_LIMIT = 500;

/** @param {Record<string, any>} chat */
const isArchivedRow = (chat) => String(chat.archivedAt || '').trim() !== '';

/**
 * Same scope rules as the SQLite store (`normalizeScope` / `scopeCondition`): catalog scope matches folder
 * first, then file; widget scope is raw equality on the installation (+ page session, file, folder when given).
 *
 * @param {Record<string, any> | null | undefined} scope
 * @returns {(chat: Record<string, any>) => boolean}
 */
function legacyScopeMatcher(scope) {
  const s = scope && typeof scope === 'object' ? scope : {};
  const widget = s.widget && typeof s.widget === 'object' ? s.widget : null;
  const installationId = String(widget?.installationId || s.widgetInstallationId || '');
  if (installationId) {
    const pageSessionId = typeof widget?.pageSessionId === 'string' && widget.pageSessionId !== '' ? widget.pageSessionId : '';
    const file = String(widget?.workspaceFile || s.workspaceFile || '');
    const folder = String(widget?.workspaceFolder || s.workspaceFolder || '');
    return (chat) => chat.widgetInstallationId === installationId
      && (!pageSessionId || (chat.widgetPageSessionId || '') === pageSessionId)
      && (!file || chat.workspaceFile === file) && (!folder || chat.workspaceFolder === folder);
  }
  const folder = workspaceKeyOf(s.workspaceFolder);
  const file = workspaceKeyOf(s.workspaceFile);
  if (!folder && !file) return () => true;
  return (chat) => {
    const chatFolder = workspaceKeyOf(chat.workspaceFolder);
    const chatFile = workspaceKeyOf(chat.workspaceFile);
    if (folder && file) return chatFolder === folder || (chatFolder === '' && chatFile === file);
    if (folder) return chatFolder === folder;
    return chatFile === file;
  };
}

/** @param {string} la @param {string} id @param {string} revision */
const encodePageCursor = (la, id, revision) => Buffer.from(JSON.stringify({ l: la, i: id, r: revision }), 'utf8').toString('base64url');

/** @type {WeakMap<object, { row: Record<string, any>, la: string }[]>} */
const orderedBySnapshot = new WeakMap();

/** Rows ordered like the SQLite index (`last_activity_at DESC, id DESC`), sorted once per snapshot. */
function orderedRows(chats) {
  let ordered = orderedBySnapshot.get(chats);
  if (!ordered) {
    ordered = chats.filter((row) => row && typeof row.id === 'string' && row.id)
      .map((row) => ({ row, la: lastActivityOf(row) }))
      .sort((a, b) => (a.la === b.la ? (a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0) : (a.la < b.la ? 1 : -1)));
    orderedBySnapshot.set(chats, ordered);
  }
  return ordered;
}

/**
 * Page with the SQLite `pageChats` shape: `{ items, ancestors?, chats, nextCursor, revision, storeRevision }`.
 *
 * @param {{ chats: Record<string, any>[], revision?: string }} snapshot
 * @param {Record<string, any>} query
 */
function legacyPage(snapshot, query) {
  const matches = legacyScopeMatcher(query.scope);
  const mode = ({ undefined: 'all', include: 'all', all: 'all', exclude: 'live', live: 'live', only: 'archived', archived: 'archived', tree: 'tree' })[String(query.archived)];
  if (!mode) throw new TypeError(`Unknown archive filter: ${String(query.archived)}`);
  const requested = Number.isSafeInteger(query.limit) ? query.limit : PAGE_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), PAGE_MAX_LIMIT);
  let after = null;
  if (query.cursor) {
    try {
      const v = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8'));
      if (typeof v?.l === 'string' && typeof v?.i === 'string') after = v;
    } catch { /* rejected below */ }
    if (!after) throw new TypeError('chat_cursor_invalid');
  }
  const revision = String(snapshot.revision ?? '');
  const ordered = orderedRows(snapshot.chats);
  let start = 0;
  if (after) {
    // First position strictly after the cursor key in descending order (binary search).
    let lo = 0;
    let hi = ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = ordered[mid];
      if (e.la < after.l || (e.la === after.l && e.row.id < after.i)) hi = mid; else lo = mid + 1;
    }
    start = lo;
  }
  const items = [];
  let more = false;
  for (let i = start; i < ordered.length; i += 1) {
    const { row } = ordered[i];
    if (mode === 'live' || mode === 'tree' ? isArchivedRow(row) : mode === 'archived' && !isArchivedRow(row)) continue;
    if (!matches(row)) continue;
    if (items.length >= limit) { more = true; break; }
    items.push(row);
  }
  const last = items.at(-1);
  const result = {
    items, nextCursor: more && last ? encodePageCursor(lastActivityOf(last), last.id, revision) : null,
    revision, storeRevision: revision,
  };
  if (mode !== 'tree') return { ...result, chats: items };
  const byId = new Map(snapshot.chats.map((row) => [row.id, row]));
  const ancestors = new Map();
  for (const row of items) {
    let parentId = String(row.forkParentChatId || '').trim();
    while (parentId && !ancestors.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent || !isArchivedRow(parent) || !matches(parent)) break;
      ancestors.set(parentId, parent);
      parentId = String(parent.forkParentChatId || '').trim();
    }
  }
  const list = [...ancestors.values()];
  return { ...result, ancestors: list, chats: [...items, ...list] };
}

/** @param {{ chats: Record<string, any>[], revision?: string }} snapshot @param {Record<string, any>} query */
function legacyCounts(snapshot, query) {
  const matches = legacyScopeMatcher(query.scope);
  let total = 0; let archived = 0; let roots = 0;
  const archivedCounts = Object.create(null);
  for (const chat of snapshot.chats) {
    if (!chat || !matches(chat)) continue;
    total += 1;
    if (!String(chat.forkParentChatId || '').trim()) roots += 1;
    if (!isArchivedRow(chat)) continue;
    archived += 1;
    const key = `${String(chat.workspaceFile || '')}\n${String(chat.workspaceFolder || '')}`;
    archivedCounts[key] = (archivedCounts[key] || 0) + 1;
  }
  const revision = String(snapshot.revision ?? '');
  return { total, archived, live: total - archived, roots, archivedCounts: { ...archivedCounts }, revision, storeRevision: revision };
}

/** Operations every chats adapter implements (names shared with lib/persist/chats-runtime.js). */
export const CHATS_BACKEND_OPERATIONS = Object.freeze([
  'loadChats', 'loadChatsSnapshot', 'peekChatsSnapshot', 'peekChats', 'peekChatsByIds', 'getChatById',
  'pageChats', 'chatCounts',
  'getChatByCursorSessionId', 'saveChats', 'addChat', 'removeChat', 'deleteTemporaryForkChats', 'updateChat',
  'markChatReadState', 'applyAutoTitle', 'setChatTitleLocked', 'setChatSessionField', 'rotateChatSdkSession',
  'migrateChatWorkspaceIds', 'importChatsBatch', 'readChatsStrict', 'rollbackImportedChats',
]);

/**
 * @param {Record<string, (...args: any[]) => any>} syncApi the synchronous implementations, one per operation
 * @returns {Record<string, (...args: any[]) => Promise<any>>}
 */
export function createLegacyChatsBackend(syncApi) {
  /** @type {Record<string, (...args: any[]) => Promise<any>>} */
  const backend = {};
  for (const name of CHATS_BACKEND_OPERATIONS) {
    if (['importChatsBatch', 'readChatsStrict', 'rollbackImportedChats', 'pageChats', 'chatCounts'].includes(name)) continue;
    if (typeof syncApi[name] !== 'function') throw new TypeError(`Legacy chats backend is missing ${name}`);
    // No await before the call: the sync body runs to completion inside this tick.
    backend[name] = async (...args) => syncApi[name](...args);
  }
  // Optional batch archive: only adapters with a cheaper-than-N-writes path provide it.
  if (typeof syncApi.archiveChats === 'function') backend.archiveChats = async (ids) => syncApi.archiveChats(ids);
  backend.readChatsStrict = async () => {
    let raw;
    try { raw = fs.readFileSync(resolveDataPath('chats.json'), 'utf8'); }
    catch (err) { if (err?.code === 'ENOENT') return { chats: [], revision: '' }; throw err; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      const failure = /** @type {Error & { code?: string }} */ (new Error(`chats.json is not valid JSON: ${err.message}`));
      failure.code = 'SOURCE_CORRUPT';
      throw failure;
    }
    if (!parsed || !Array.isArray(parsed.chats)) {
      const failure = /** @type {Error & { code?: string }} */ (new Error('chats.json has an unexpected shape'));
      failure.code = 'SOURCE_CORRUPT';
      throw failure;
    }
    return syncApi.loadChatsSnapshot();
  };
  /** @type {{ sig: string, snapshot: { chats: Record<string, any>[], revision?: string } } | null} */
  let walkSnapshot = null;
  const fileSignature = () => {
    try { const st = fs.statSync(resolveDataPath('chats.json')); return `${st.size}:${st.mtimeMs}`; } catch { return ''; }
  };
  backend.pageChats = async (query = {}) => {
    // The first page always reads (and hashes) the file. A continuation page reuses that snapshot while the file
    // signature is unchanged, so a full walk costs one read instead of one read per page.
    const sig = query.cursor ? fileSignature() : '';
    if (!(query.cursor && walkSnapshot && walkSnapshot.sig === sig && sig !== '')) {
      walkSnapshot = { sig: fileSignature(), snapshot: syncApi.peekChatsSnapshot() };
    }
    const result = legacyPage(walkSnapshot.snapshot, query);
    // The last page ends the walk: drop the parsed snapshot (and its sorted index) instead of keeping
    // tens of MB alive between list reads, where it slowed every later chat write through GC pressure.
    if (!result?.nextCursor) walkSnapshot = null;
    return result;
  };
  backend.chatCounts = async (query = {}) => legacyCounts(syncApi.peekChatsSnapshot(), query);
  backend.importChatsBatch = async (entries) => {
    const current = syncApi.loadChats();
    const ids = new Set(current.map((chat) => chat.id));
    const added = entries.filter((chat) => {
      if (ids.has(chat.id)) return false;
      ids.add(chat.id);
      return true;
    });
    if (added.length) syncApi.saveChats([...current, ...added]);
    return { added: added.length, addedIds: added.map((chat) => String(chat.id)), revision: syncApi.peekChatsSnapshot().revision };
  };
  backend.rollbackImportedChats = async (ids) => {
    const doomed = new Set(ids);
    const current = syncApi.loadChats();
    if (current.some((chat) => doomed.has(chat.id))) syncApi.saveChats(current.filter((chat) => !doomed.has(chat.id)));
  };
  return Object.freeze(backend);
}
