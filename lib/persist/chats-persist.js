/**
 * Chat list persistence (SDK + OpenRouter harnesses).
 * data/chats.json: { chats: [ { id, title, cursorSessionId, agentTransport, createdAt } ] }
 */

import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { normalizeAgentTransport, parseKnownAgentTransport } from '../agent-transport.js';
import { HARNESS_PLUGIN_ID_PATTERN } from '../agent-harness/harness-plugin-contract.ts';
import { normalizeSdkMode } from '../sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../sdk/sdk-ui-mode.ts';
import { writeJsonAtomic, writeTextAtomic } from './atomic-write.js';
import { deleteChatHistory, loadChatHistory } from './chat-history-service.js';
import { discardBufferedHistory, settleHistoryFlushes } from './history-room-flusher.js';
import { appendChatTitleHistory, deleteChatTitleHistory, setChatTitleHistorySeq } from './chat-title-history-persist.js';
import { deleteContextSendManifests } from './context-send-manifests-persist.js';
import { removeBrowserScreenshots } from '../browser/screenshot-file.js';
import { normalizeContextAdvisoryWarnPercent } from '../sdk/sdk-context-advisory.ts';
import { normalizeAutoContextCompressionThresholdPercent } from '../context-compression.js';
import { isSamePageUrl } from '../widget/widget-page-url.ts';
import { isChatArchived, wouldCreateChatParentCycle } from '../chat-tree.js';
import { notifyChatCreated } from '../chat-created-push.js';
import { listRegisteredWorkspacesForFolder } from '../workspace-registry-service.js';

/**
 * Optional gate installed by `chat-archive-guard.js`. Kept as a setter so this
 * persist module does not import the chat-run adapter (that import cycles).
 *
 * @type {((chats: Record<string, any>[], rootId: string) => void) | null}
 */
let rejectBusyChatArchive = null;

/**
 * @param {((chats: Record<string, any>[], rootId: string) => void) | null} rejector
 * @returns {void}
 */
export function setChatArchiveRejector(rejector) {
  rejectBusyChatArchive = typeof rejector === 'function' ? rejector : null;
}
import { broadcastChatListChanged } from '../chat-list-updates.js';

/** @typedef {import('../shared-types/persist-records.js').ChatRecord} ChatRecord */
import { resolveDataPath } from '../runtime-paths.js';

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
  for (let i = 0; i < chats.length; i += 1) out[i] = { ...chats[i] };
  return out;
}

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeAutoContextThreshold(value) {
  return normalizeAutoContextCompressionThresholdPercent(value);
}

/** Titles assigned by the backend at creation: "Claude chat 872", "Chat 3", "Local · chat 4". */
export const DEFAULT_CHAT_TITLE_RE = /^(?:\S+ )?chat \d+$/i;

/**
 * Where the current title came from. Set only by the server:
 * 'default' (placeholder), 'auto' (generated), 'manual' (user / chat_rename).
 */
export const CHAT_TITLE_SOURCES = Object.freeze(['default', 'auto', 'manual']);

/**
 * Migration for entries saved before titleSource existed: placeholder names become 'default',
 * everything else 'manual' (an old auto-name cannot be told from a manual one).
 * Temporary fork chats are not titled, so they get no source.
 *
 * @param {Record<string, any>} chat
 * @returns {'default' | 'auto' | 'manual' | ''}
 */
export function inferChatTitleSource(chat) {
  if (!chat || chat.isTemporary === true || chat.forkKind === 'title' || chat.forkKind === 'summary') return '';
  const title = typeof chat.title === 'string' ? chat.title.trim() : '';
  if (!title || DEFAULT_CHAT_TITLE_RE.test(title)) return 'default';
  if (/^\[Temp\]/i.test(title)) return '';
  return 'manual';
}

function withTitleSource(chat) {
  if (!CHAT_TITLE_SOURCES.includes(chat.titleSource)) {
    const inferred = inferChatTitleSource(chat);
    if (inferred) chat.titleSource = inferred;
  }
  return chat;
}

async function currentHeadSeq(chatId) {
  const doc = await loadChatHistory(chatId);
  return doc && Number.isFinite(doc.headSeq) ? doc.headSeq : undefined;
}

/**
 * Title-history `seq` is a derived annotation (the history head at the time of the rename). The rename itself is
 * sync and must not wait for the async history adapter, so the annotation is added after the fact. A failed read
 * leaves the entry without `seq`; it never fails or delays the rename.
 *
 * @param {string} chatId
 * @param {string} title
 */
function annotateTitleHistorySeq(chatId, title) {
  void currentHeadSeq(chatId)
    .then((seq) => { if (seq !== undefined) setChatTitleHistorySeq(chatId, title, seq); })
    .catch(() => {});
}

/**
 * @returns {import('../shared-types/persist-records.js').ChatRecord[]}
 */
export function loadChats() {
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
  return readChatsSnapshot(true);
}

/**
 * Read-only snapshot with the same revision contract as `loadChatsSnapshot()`, but without copying
 * cached rows. Callers must never mutate the returned rows.
 *
 * @returns {{ chats: readonly Record<string, any>[], revision: string }}
 */
export function peekChatsSnapshot() {
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
  const row = peekChats().find((c) => c.cursorSessionId === cursorSessionId);
  return row ? { ...row } : null;
}

/**
 * @param {Array<ChatRecord>} chats
 */
export function saveChats(chats) {
  ensureDir();
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
  chatsCache = null;
  chatsIndex = null;
  writeTextAtomic(DATA_FILE, serializeChatsFile(chats));
  const signature = readChatsFileSignature();
  if (signature) chatsCache = { signature, chats };
}

/**
 * Builds a chat entry pointing at a new, empty SDK session.
 *
 * @param {Record<string, any>} chat
 * @param {string} cursorSessionId
 * @returns {Record<string, any>}
 */
export function createFreshSdkContextEntry(chat, cursorSessionId) {
  if (!chat || typeof chat !== 'object') {
    throw new TypeError('Chat entry is required');
  }
  const nextCursorSessionId = String(cursorSessionId || '').trim();
  if (!nextCursorSessionId) {
    throw new TypeError('New cursor session id is required');
  }
  const nextChat = {
    ...chat,
    cursorSessionId: nextCursorSessionId,
  };
  delete /** @type {Record<string, unknown>} */ (nextChat).sdkAgentId;
  return nextChat;
}

/**
 * Resolve the transport value that is persisted for a new chat.
 *
 * Built-ins and the legacy `cursor` alias keep the global
 * {@link normalizeAgentTransport} behavior. The only exception is a local
 * harness id that the create route already loaded and verified: it is stored
 * verbatim (lowercased, pattern-checked) when, and only when, the caller sets
 * `extras.localHarnessTransport === true`. The flag is a server-internal marker
 * set exclusively by `POST /api/chats` after `classifyCreateHarness` succeeded,
 * so an unrecognized/legacy id from any other caller still falls back to `sdk`
 * and can never become an executable plugin id by accident.
 *
 * @param {unknown} raw
 * @param {Record<string, any> | null | undefined} extras
 * @returns {string}
 */
function resolvePersistedChatTransport(raw, extras) {
  const builtin = parseKnownAgentTransport(raw);
  if (builtin) return builtin;
  if (extras && extras.localHarnessTransport === true) {
    const token = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (token && HARNESS_PLUGIN_ID_PATTERN.test(token)) return token;
  }
  return normalizeAgentTransport(raw);
}

/**
 * Reject child creation using the current store snapshot, including callers
 * whose parent object predates its archive.
 * @param {Record<string, any>[]} chats
 * @param {unknown} parentId
 * @returns {void}
 */
function assertChatParentIsLive(chats, parentId) {
  const id = String(parentId || '').trim();
  if (!id) return;
  const parent = chats.find(chat => chat.id === id);
  if (parent?.archived !== true && !isChatArchived(parent)) return;
  const error = /** @type {Error & { code?: string }} */ (new Error('Restore the parent chat before adding a child.'));
  error.code = 'parent_archived';
  throw error;
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
  const chats = loadChats();
  const reservedId = String(extras?.id || '').trim();
  if (reservedId) {
    const existing = chats.find((row) => row.id === reservedId);
    if (existing) return existing;
  }
  assertChatParentIsLive(chats, extras?.forkParentChatId);
  assertChatParentIsLive(chats, extras?.delegationParentChatId);
  const id = reservedId || randomUUID();
  const createdAt = new Date().toISOString();
  const transport = resolvePersistedChatTransport(extras?.agentTransport, /** @type {any} */ (extras));
  const entry = {
    id,
    title: title || 'Chat ' + (chats.length + 1),
    cursorSessionId,
    createdAt,
    updatedAt: createdAt,
    agentTransport: transport,
    sdkMode: normalizeSdkMode(extras?.sdkMode),
    sdkUiMode: normalizeSdkUiMode(extras?.sdkUiMode),
  };
  if (extras && typeof extras === 'object' && typeof extras.sdkSystemPrompt === 'string') {
    const trimmedPrompt = extras.sdkSystemPrompt.trim();
    if (trimmedPrompt) entry.sdkSystemPrompt = trimmedPrompt;
  }
  if (workspaceFile) entry.workspaceFile = workspaceFile;
  if (workspaceFolder) entry.workspaceFolder = workspaceFolder;
  if (extras && typeof extras === 'object' && typeof extras.workspaceId === 'string' && extras.workspaceId.trim()) {
    entry.workspaceId = extras.workspaceId.trim();
  }
  // Explicit runner cwd, separate from the logical workspace. Absent means the
  // workspace folder is used, which keeps every existing chat unchanged.
  if (extras && typeof extras === 'object' && typeof extras.executionFolder === 'string') {
    const executionFolder = extras.executionFolder.trim();
    if (executionFolder) entry.executionFolder = executionFolder;
  }
  if (model) entry.model = model;
  if (extras && typeof extras === 'object' && extras.widgetInstallationId) {
    entry.widgetInstallationId = String(extras.widgetInstallationId);
  }
  if (extras && typeof extras === 'object' && extras.widgetPageSessionId) {
    entry.widgetPageSessionId = String(extras.widgetPageSessionId);
  }
  if (extras && typeof extras === 'object' && extras.todoId) {
    entry.todoId = String(extras.todoId);
  }
  // Marks the single durable Workspace Watcher chat. Sidebar renders it in the
  // dedicated "Workspace" section instead of the normal chat list, and the chat
  // view opens in pinned (read + command) mode rather than as a normal agent run.
  if (extras && typeof extras === 'object' && extras.watcherPinned === true) {
    entry.watcherPinned = true;
  }
  if (extras && typeof extras === 'object' && extras.isTemporary === true) {
    entry.isTemporary = true;
  }
  if (extras && typeof extras === 'object' && extras.forkParentChatId) {
    entry.forkParentChatId = String(extras.forkParentChatId);
  }
  if (extras && typeof extras === 'object' && extras.forkKind) {
    entry.forkKind = String(extras.forkKind);
  }
  if (extras && typeof extras === 'object' && extras.delegationParentChatId) {
    entry.delegationParentChatId = String(extras.delegationParentChatId);
  }
  // Delegation tree position of a child chat (see lib/delegation-tree.js).
  if (extras && typeof extras === 'object' && Number(extras.delegationDepth) >= 1) {
    entry.delegationDepth = Math.floor(Number(extras.delegationDepth));
  }
  if (extras && typeof extras === 'object' && extras.delegationRootChatId) {
    entry.delegationRootChatId = String(extras.delegationRootChatId);
  }
  if (extras && typeof extras === 'object' && extras.delegationRootDelegationId) {
    entry.delegationRootDelegationId = String(extras.delegationRootDelegationId);
  }
  // Internal grant hook: lets a child chat start a nested delegation.
  if (extras && typeof extras === 'object' && extras.delegationGrant === true) {
    entry.delegationGrant = true;
  }
  // Which automatic model-pick purpose chose this chat's model (see
  // lib/model-pick-service.js); counted as role usage so picks rotate.
  if (extras && typeof extras === 'object' && extras.pickPurpose) {
    entry.pickPurpose = String(extras.pickPurpose);
  }
  if (extras && typeof extras === 'object' && extras.delegationId) {
    entry.delegationId = String(extras.delegationId);
  }
  if (extras && typeof extras === 'object' && extras.delegationAssignment) {
    entry.delegationAssignment = String(extras.delegationAssignment);
  }
  if (extras && typeof extras === 'object' && extras.delegationSessionIdentity) {
    entry.delegationSessionIdentity = String(extras.delegationSessionIdentity).trim();
    entry.delegationSessionGeneration = Math.max(
      0,
      Math.floor(Number(extras.delegationSessionGeneration) || 0),
    );
  }
  if (extras && typeof extras === 'object' && Array.isArray(extras.summaries)) {
    entry.summaries = JSON.parse(JSON.stringify(extras.summaries));
  }
  if (extras && typeof extras === 'object' && extras.autoContextCompressionEnabled === true) {
    entry.autoContextCompressionEnabled = true;
  }
  if (extras && typeof extras === 'object' && Object.prototype.hasOwnProperty.call(extras, 'autoContextCompressionThreshold')) {
    entry.autoContextCompressionThreshold = normalizeAutoContextThreshold(
      extras.autoContextCompressionThreshold
    );
  }
  if (extras && typeof extras === 'object' && extras.autoContextCompressionReset === false) {
    entry.autoContextCompressionReset = false;
  }
  if (extras && typeof extras === 'object' && extras.opencodeSessionId) {
    entry.opencodeSessionId = String(extras.opencodeSessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.codebuddySessionId) {
    entry.codebuddySessionId = String(extras.codebuddySessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.deepseekSessionId) {
    entry.deepseekSessionId = String(extras.deepseekSessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.codexThreadId) {
    entry.codexThreadId = String(extras.codexThreadId).trim();
  }
  if (extras && typeof extras === 'object' && extras.qwenSessionId) {
    entry.qwenSessionId = String(extras.qwenSessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.claudeSessionId) {
    entry.claudeSessionId = String(extras.claudeSessionId).trim();
  }
  withTitleSource(entry);
  chats.push(entry);
  saveChats(chats);
  broadcastChatListChanged({ reason: 'create', chatId: entry.id });
  // Temporary fork chats (title/summary helpers) are internal and stay silent.
  if (entry.isTemporary !== true) {
    notifyChatCreated({ chatId: entry.id, chatTitle: entry.title });
  }
  return entry;
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
  if (!parentChat?.id) {
    throw new TypeError('Parent chat is required');
  }
  const overrideTitle = typeof overrides?.title === 'string' ? overrides.title.trim() : '';
  const title = overrideTitle || `${parentChat.title || 'Chat'} (fork)`;
  const overrideWorkspaceFile =
    typeof overrides?.workspaceFile === 'string' ? overrides.workspaceFile.trim() : '';
  const overrideWorkspaceFolder =
    typeof overrides?.workspaceFolder === 'string' ? overrides.workspaceFolder.trim() : '';
  const overrideModel = typeof overrides?.model === 'string' ? overrides.model.trim() : '';
  const hasTransportOverride =
    typeof overrides?.agentTransport === 'string' && overrides.agentTransport.trim() !== '';
  const workspaceFile = overrideWorkspaceFile || parentChat.workspaceFile;
  const workspaceFolder = overrideWorkspaceFolder || parentChat.workspaceFolder;
  const model = overrideModel || parentChat.model;
  const forkKind =
    typeof overrides?.forkKind === 'string' && overrides.forkKind.trim()
      ? overrides.forkKind.trim()
      : 'conversation';
  const extras = {
    agentTransport: hasTransportOverride
      ? normalizeAgentTransport(overrides.agentTransport)
      : parentChat.agentTransport,
    sdkMode: parentChat.sdkMode,
    sdkUiMode: parentChat.sdkUiMode,
    sdkSystemPrompt: parentChat.sdkSystemPrompt,
    forkParentChatId: parentChat.id,
    forkKind,
  };
  if (forkKind !== 'analyze') {
    // A reference fork points at the parent history, so it does not copy summaries.
    if (forkKind !== 'reference') extras.summaries = parentChat.summaries;
    extras.autoContextCompressionEnabled = parentChat.autoContextCompressionEnabled === true;
    extras.autoContextCompressionThreshold = parentChat.autoContextCompressionThreshold;
    extras.autoContextCompressionReset = parentChat.autoContextCompressionReset;
  }
  return addChat(randomUUID(), title, workspaceFile, workspaceFolder, model, extras);
}

const FORK_TEMP_TITLES = Object.freeze({
  title: '[Temp] Chat title',
  summary: '[Temp] Summary',
});

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
  const sdkSessionKey = randomUUID();
  const title = FORK_TEMP_TITLES[forkKind] || '[Temp] Agent';
  return addChat(sdkSessionKey, title, workspaceFile, workspaceFolder, model || undefined, {
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
  const chats = loadChats();
  const doomed = chats.filter(
    (c) =>
      c &&
      c.isTemporary === true &&
      c.forkParentChatId === parentChatId &&
      (!forkKind || c.forkKind === forkKind)
  );
  if (doomed.length === 0) return [];
  const doomedIds = new Set(doomed.map((c) => c.id));
  saveChats(chats.filter((c) => !doomedIds.has(c.id)));
  return doomed;
}

/**
 * @param {string} id - our own chat id (uuid)
 */
export function removeChat(id) {
  const chats = loadChats().filter((c) => c.id !== id);
  saveChats(chats);
}

/**
 * Full server-side chat removal: the list entry plus any related data.
 * Single place for all cleanup — data/chats.json, chat history, title history
 * and the chat's Browser screenshot temp dir.
 *
 * The durable history delete runs FIRST: when it fails (typed adapter error, `details.retryToken` for an unknown
 * commit) the chat list entry and the other metadata are untouched, so the caller can retry with the same token and
 * nothing is orphaned. Once the history is gone, the remaining removals are local and idempotent.
 *
 * @param {string} id - chat id (uuid)
 * @param {{ retryToken?: string }} [options]
 */
export async function deleteChat(id, options = {}) {
  // A flush still in flight for this chat must finish (commit or fail) before the delete, or it would resurrect it.
  await settleHistoryFlushes(id);
  await deleteChatHistory(id, options.retryToken === undefined ? undefined : { retryToken: options.retryToken });
  discardBufferedHistory(id);
  removeChat(id);
  deleteChatTitleHistory(id);
  deleteContextSendManifests(id);
  removeBrowserScreenshots(id);
  broadcastChatListChanged({ reason: 'delete', chatId: id });
}

/**
 * @param {string} id - chat id (uuid)
 * @param {{ title?: string, model?: string, sdkMode?: string, sdkUiMode?: string, sdkSystemPrompt?: string|null, summary?: string, summaryTitle?: string, todoId?: string|null, archived?: boolean, forkParentChatId?: string|null, executionFolder?: string|null, delegationSessionIdentity?: string|null, delegationSessionGeneration?: number, widgetPinnedUrl?: string|null, [key: string]: any }} updates - fields to update; summary + summaryTitle append one entry to summaries
 * @returns {import('../shared-types/persist-records.js').ChatRecord | null}
 */
export function updateChat(id, updates) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  // A title coming through updateChat is a manual rename (PATCH, chat_rename); generators use applyAutoTitle.
  const nextTitle = typeof updates.title === 'string' ? updates.title.trim() : '';
  const titleChanged = Boolean(nextTitle) && nextTitle !== chats[idx].title;
  if (nextTitle) {
    chats[idx].title = nextTitle;
    chats[idx].titleSource = 'manual';
    if (titleChanged) chats[idx].titleRev = (Number(chats[idx].titleRev) || 0) + 1;
  }
  if (updates.model !== undefined) chats[idx].model = updates.model || undefined;
  if (updates.sdkMode !== undefined) chats[idx].sdkMode = normalizeSdkMode(updates.sdkMode);
  if (updates.sdkUiMode !== undefined) {
    chats[idx].sdkUiMode = normalizeSdkUiMode(updates.sdkUiMode);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'sdkSystemPrompt')) {
    const nextPrompt = updates.sdkSystemPrompt == null ? '' : String(updates.sdkSystemPrompt).trim();
    if (nextPrompt) chats[idx].sdkSystemPrompt = nextPrompt;
    else delete chats[idx].sdkSystemPrompt;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'todoId')) {
    const nextTodoId = updates.todoId == null ? '' : String(updates.todoId).trim();
    if (nextTodoId) chats[idx].todoId = nextTodoId;
    else delete chats[idx].todoId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationId')) {
    const nextDelegationId = updates.delegationId == null ? '' : String(updates.delegationId).trim();
    if (nextDelegationId) chats[idx].delegationId = nextDelegationId;
    else delete chats[idx].delegationId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationGrant')) {
    if (updates.delegationGrant === true) chats[idx].delegationGrant = true;
    else delete chats[idx].delegationGrant;
  }
  if (Number(updates.delegationDepth) >= 1) {
    chats[idx].delegationDepth = Math.floor(Number(updates.delegationDepth));
  }
  if (updates.delegationRootChatId) chats[idx].delegationRootChatId = String(updates.delegationRootChatId);
  if (updates.delegationRootDelegationId) {
    chats[idx].delegationRootDelegationId = String(updates.delegationRootDelegationId);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationAssignment')) {
    const nextAssignment = updates.delegationAssignment == null
      ? ''
      : String(updates.delegationAssignment).trim();
    if (nextAssignment) chats[idx].delegationAssignment = nextAssignment;
    else delete chats[idx].delegationAssignment;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationSessionIdentity')) {
    const identity = updates.delegationSessionIdentity == null
      ? ''
      : String(updates.delegationSessionIdentity).trim();
    if (identity) chats[idx].delegationSessionIdentity = identity;
    else delete chats[idx].delegationSessionIdentity;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationSessionGeneration')) {
    chats[idx].delegationSessionGeneration = Math.max(
      0,
      Math.floor(Number(updates.delegationSessionGeneration) || 0),
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'executionFolder')) {
    const nextExecution = updates.executionFolder == null ? '' : String(updates.executionFolder).trim();
    if (nextExecution) chats[idx].executionFolder = nextExecution;
    else delete chats[idx].executionFolder;
  }
  if (typeof updates.summary === 'string' && updates.summary.trim()) {
    if (!Array.isArray(chats[idx].summaries)) chats[idx].summaries = [];
    /** @type {any[]} */ (chats[idx].summaries).push({
      summary: updates.summary.trim(),
      title: typeof updates.summaryTitle === 'string' ? updates.summaryTitle.trim() : undefined,
      at: new Date().toISOString(),
    });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionEnabled')) {
    chats[idx].autoContextCompressionEnabled = updates.autoContextCompressionEnabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionThreshold')) {
    chats[idx].autoContextCompressionThreshold = normalizeAutoContextThreshold(
      updates.autoContextCompressionThreshold
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionReset')) {
    chats[idx].autoContextCompressionReset = updates.autoContextCompressionReset !== false;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contextSettings')) {
    // Validated by the context settings resolver before it reaches this layer.
    const incoming = /** @type {any} */ (updates).contextSettings;
    if (incoming && typeof incoming === 'object') /** @type {any} */ (chats[idx]).contextSettings = incoming;
    else delete (/** @type {any} */ (chats[idx])).contextSettings;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contextAdvisoryEnabled')) {
    if (updates.contextAdvisoryEnabled === false) chats[idx].contextAdvisoryEnabled = false;
    else delete chats[idx].contextAdvisoryEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contextAdvisoryWarnPercent')) {
    chats[idx].contextAdvisoryWarnPercent = normalizeContextAdvisoryWarnPercent(
      updates.contextAdvisoryWarnPercent
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'opencodeSessionId')) {
    const nextId = updates.opencodeSessionId == null ? '' : String(updates.opencodeSessionId).trim();
    if (nextId) chats[idx].opencodeSessionId = nextId;
    else delete chats[idx].opencodeSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'codebuddySessionId')) {
    const nextId = updates.codebuddySessionId == null ? '' : String(updates.codebuddySessionId).trim();
    if (nextId) chats[idx].codebuddySessionId = nextId;
    else delete chats[idx].codebuddySessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'deepseekSessionId')) {
    const nextId = updates.deepseekSessionId == null ? '' : String(updates.deepseekSessionId).trim();
    if (nextId) chats[idx].deepseekSessionId = nextId;
    else delete chats[idx].deepseekSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'codexThreadId')) {
    const nextId = updates.codexThreadId == null ? '' : String(updates.codexThreadId).trim();
    if (nextId) chats[idx].codexThreadId = nextId;
    else delete chats[idx].codexThreadId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'qwenSessionId')) {
    const nextId = updates.qwenSessionId == null ? '' : String(updates.qwenSessionId).trim();
    if (nextId) chats[idx].qwenSessionId = nextId;
    else delete chats[idx].qwenSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'claudeSessionId')) {
    const nextId = updates.claudeSessionId == null ? '' : String(updates.claudeSessionId).trim();
    if (nextId) chats[idx].claudeSessionId = nextId;
    else delete chats[idx].claudeSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'forkParentChatId')) {
    const nextParent = updates.forkParentChatId == null ? '' : String(updates.forkParentChatId).trim();
    if (!nextParent) {
      delete chats[idx].forkParentChatId;
    } else if (nextParent === id) {
      throw new Error('Chat cannot be nested under itself');
    } else if (!chats.some((chat) => chat.id === nextParent)) {
      throw new Error('Parent chat not found');
    } else if (wouldCreateChatParentCycle(chats, id, nextParent)) {
      throw new Error('Cannot nest a chat under its descendant');
    } else {
      assertChatParentIsLive(chats, nextParent);
      chats[idx].forkParentChatId = nextParent;
    }
  }
  let archiveListReason = '';
  if (Object.prototype.hasOwnProperty.call(updates, 'archived')) {
    const archivedAt = updates.archived === true ? new Date().toISOString() : '';
    if (archivedAt && rejectBusyChatArchive) {
      rejectBusyChatArchive(chats, id);
    }
    // Archiving a parent moves the complete nested tree into the archive. Use
    // the same parent relation as the sidebar, and walk transitively so deep
    // descendants cannot remain visible without their ancestor.
    const subtreeIds = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const chat of chats) {
        const parentId = typeof chat.forkParentChatId === 'string'
          ? chat.forkParentChatId.trim()
          : '';
        if (parentId && subtreeIds.has(parentId) && !subtreeIds.has(chat.id)) {
          subtreeIds.add(chat.id);
          changed = true;
        }
      }
    }
    for (const chat of chats) {
      if (!subtreeIds.has(chat.id)) continue;
      if (archivedAt) chat.archivedAt = archivedAt;
      else delete chat.archivedAt;
      chat.updatedAt = new Date().toISOString();
    }
    archiveListReason = updates.archived === true ? 'archive' : 'restore';
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'widgetPinnedUrl')) {
    const nextPinnedUrl = updates.widgetPinnedUrl == null ? '' : String(updates.widgetPinnedUrl).trim();
    if (nextPinnedUrl) {
      for (let i = 0; i < chats.length; i += 1) {
        if (i === idx) continue;
        const otherPinnedUrl = typeof chats[i].widgetPinnedUrl === 'string'
          ? /** @type {string} */ (chats[i].widgetPinnedUrl).trim()
          : '';
        if (otherPinnedUrl && isSamePageUrl(otherPinnedUrl, nextPinnedUrl)) {
          delete chats[i].widgetPinnedUrl;
        }
      }
      chats[idx].widgetPinnedUrl = nextPinnedUrl;
    } else {
      delete chats[idx].widgetPinnedUrl;
    }
  }
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  if (titleChanged) {
    appendChatTitleHistory(id, {
      title: nextTitle,
      source: 'manual',
      reason: 'rename',
    });
    annotateTitleHistorySeq(id, nextTitle);
  }
  if (archiveListReason) {
    broadcastChatListChanged({ reason: archiveListReason, chatId: id });
  } else if (titleChanged) {
    // The frame carries the row content so clients patch one row instead of refetching the list.
    broadcastChatListChanged({
      reason: 'title',
      chatId: id,
      title: chats[idx].title,
      titleSource: /** @type {string} */ (chats[idx].titleSource),
    });
  } else if (Object.prototype.hasOwnProperty.call(updates, 'forkParentChatId')) {
    broadcastChatListChanged({ reason: 'nest', chatId: id });
  }
  return { ...chats[idx] };
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
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const chat = chats[idx];
  const finishedAt = typeof marks.finishedAt === 'string' ? marks.finishedAt.trim() : '';
  const seenAt = typeof marks.seenAt === 'string' ? marks.seenAt.trim() : '';
  let changed = false;
  if (finishedAt && chat.lastFinishedAt !== finishedAt) {
    chat.lastFinishedAt = finishedAt;
    changed = true;
  }
  if (seenAt && chat.lastSeenAt !== seenAt) {
    chat.lastSeenAt = seenAt;
    changed = true;
  }
  if (!changed) return null;
  commitChatUpdate(chats);
  const state = {
    lastFinishedAt: String(chat.lastFinishedAt || ''),
    lastSeenAt: String(chat.lastSeenAt || ''),
  };
  broadcastChatListChanged({ reason: 'read', chatId: id, ...state });
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
  const nextTitle = typeof title === 'string' ? title.trim() : '';
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return { applied: false, skipped: 'not_found', chat: null };
  const chat = chats[idx];
  if (!nextTitle) return { applied: false, skipped: 'empty', chat };
  if (chat.titleSource === 'manual' && options.force !== true) {
    return { applied: false, skipped: 'manual', chat };
  }
  if (
    Number.isFinite(options.expectedVersion) &&
    (Number(chat.titleRev) || 0) !== options.expectedVersion
  ) {
    return { applied: false, skipped: 'stale', chat };
  }
  if (nextTitle === chat.title) {
    if (chat.titleSource === 'auto') return { applied: false, skipped: 'unchanged', chat };
  }
  chat.title = nextTitle;
  chat.titleSource = 'auto';
  chat.titleRev = (Number(chat.titleRev) || 0) + 1;
  chat.updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  appendChatTitleHistory(id, {
    title: nextTitle,
    source: 'auto',
    reason: options.reason || 'auto',
  });
  annotateTitleHistorySeq(id, nextTitle);
  broadcastChatListChanged({ reason: 'title', chatId: id, title: chat.title, titleSource: /** @type {string} */ (chat.titleSource) });
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
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const chat = chats[idx];
  const next = locked === true
    ? 'manual'
    : (DEFAULT_CHAT_TITLE_RE.test(String(chat.title || '').trim()) ? 'default' : 'auto');
  if (chat.titleSource === next) return chat;
  chat.titleSource = next;
  chat.titleRev = (Number(chat.titleRev) || 0) + 1;
  chat.updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  broadcastChatListChanged({ reason: 'title', chatId: id, title: chat.title, titleSource: next });
  return { ...chat };
}

/**
 * Cloud @cursor/sdk agent id — set only by the server (SDK WebSocket), never through the public PATCH.
 * @param {string} id - chat id (uuid)
 * @param {string | null | undefined} sdkAgentId - e.g. bc-…; an empty value removes the field
 * @returns {Record<string, any> | null}
 */
export function setChatSdkAgentId(id, sdkAgentId) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = sdkAgentId == null ? '' : String(sdkAgentId).trim();
  if (!trimmed) {
    delete chats[idx].sdkAgentId;
  } else {
    chats[idx].sdkAgentId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * OpenCode session id — set by server when session.create succeeds.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} opencodeSessionId
 * @returns {Record<string, any> | null}
 */
export function setChatOpenCodeSessionId(id, opencodeSessionId) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = opencodeSessionId == null ? '' : String(opencodeSessionId).trim();
  if (!trimmed) {
    delete chats[idx].opencodeSessionId;
  } else {
    chats[idx].opencodeSessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * CodeBuddy session id — set by server from the SDK system/init message.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} codebuddySessionId
 * @returns {Record<string, any> | null}
 */
export function setChatCodeBuddySessionId(id, codebuddySessionId) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = codebuddySessionId == null ? '' : String(codebuddySessionId).trim();
  if (!trimmed) {
    delete chats[idx].codebuddySessionId;
  } else {
    chats[idx].codebuddySessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * DeepSeek Harness session id — set by the server from the first SDK run.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} deepseekSessionId
 * @returns {Record<string, any> | null}
 */
export function setChatDeepSeekSessionId(id, deepseekSessionId) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = deepseekSessionId == null ? '' : String(deepseekSessionId).trim();
  if (!trimmed) {
    delete chats[idx].deepseekSessionId;
  } else {
    chats[idx].deepseekSessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * Codex SDK thread id — set by the server from thread.started.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} codexThreadId
 * @returns {Record<string, any> | null}
 */
export function setChatCodexThreadId(id, codexThreadId) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = codexThreadId == null ? '' : String(codexThreadId).trim();
  if (!trimmed) {
    delete chats[idx].codexThreadId;
  } else {
    chats[idx].codexThreadId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * Qwen Code session id — set by the server after the first successful query().
 * @param {string} id - chat uuid
 * @param {string | null | undefined} qwenSessionId
 * @returns {Record<string, any> | null}
 */
export function setChatQwenSessionId(id, qwenSessionId) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = qwenSessionId == null ? '' : String(qwenSessionId).trim();
  if (!trimmed) {
    delete chats[idx].qwenSessionId;
  } else {
    chats[idx].qwenSessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * Claude Agent SDK session id — set by the server after the first query().
 * @param {string} id - chat uuid
 * @param {string | null | undefined} claudeSessionId
 * @returns {Record<string, any> | null}
 */
export function setChatClaudeSessionId(id, claudeSessionId) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = claudeSessionId == null ? '' : String(claudeSessionId).trim();
  if (String(chats[idx].claudeSessionId || '') === trimmed) return chats[idx];
  if (!trimmed) {
    delete chats[idx].claudeSessionId;
  } else {
    chats[idx].claudeSessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  commitChatUpdate(chats);
  return { ...chats[idx] };
}

/**
 * Detaches the chat from its old agent and local store by rotating the SDK session key.
 *
 * @param {string} id
 * @returns {Record<string, any> | null}
 */
export function rotateChatSdkSession(id) {
  const chats = loadChatsForUpdate(id);
  const idx = chats.findIndex((chat) => chat.id === id);
  if (idx === -1) return null;
  chats[idx] = createFreshSdkContextEntry(chats[idx], randomUUID());
  chats[idx].updatedAt = new Date().toISOString();
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
  const dryRun = options.dryRun !== false;
  const chats = loadChats();
  const report = { dryRun, total: chats.length, updated: 0, alreadySet: 0, noFolder: 0, unmatched: 0, ambiguous: 0, assignments: /** @type {Array<{ chatId: string, workspaceId: string }>} */ ([]) };
  for (const chat of chats) {
    if (String(chat.workspaceId || '').trim()) { report.alreadySet++; continue; }
    const folder = String(chat.workspaceFolder || '').trim();
    if (!folder) { report.noFolder++; continue; }
    const rows = listRegisteredWorkspacesForFolder(settings, folder);
    if (rows.length === 0) { report.unmatched++; continue; }
    if (rows.length > 1) { report.ambiguous++; continue; }
    report.assignments.push({ chatId: chat.id, workspaceId: rows[0].id });
    report.updated++;
    if (!dryRun) chat.workspaceId = rows[0].id;
  }
  if (!dryRun && report.updated > 0) saveChats(chats);
  return report;
}
