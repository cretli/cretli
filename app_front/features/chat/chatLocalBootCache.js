/**
 * Cold-start boot cache for the chat list.
 *
 * History documents already live in IndexedDB (see lib/sdk-chat-history-store.js) and are
 * rendered by `openTerminal` before the network answers. What was missing was the *list*:
 * the sidebar/chat bar stayed empty until `GET /api/chats` resolved, and only then could
 * `selectChat` open the active pane and replay its cached history. This module persists a
 * small, JSON-safe snapshot of the chat rows (metadata only — never message content), the
 * workspace list needed to group them, the last active chat id, and the header workspace
 * context, all in localStorage. It is deliberately pure: storage is injected for tests and
 * nothing here touches the DOM.
 *
 * The snapshot stays tiny (a few hundred short rows) so it can be read synchronously on
 * boot without blocking first paint. On every successful list load the controller writes a
 * fresh snapshot, and the next cold start renders it immediately while the server response
 * reconciles the rows in place (same object identity -> no flicker).
 */

import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import { getChatUpdatedAtMs } from './chatListSort.js';

/** localStorage key holding the boot snapshot. */
export const CHAT_LOCAL_BOOT_CACHE_KEY = 'cretli-chat-boot-cache-v1';

/** Snapshot schema version; a mismatch discards the old document. */
export const CHAT_LOCAL_BOOT_CACHE_VERSION = 1;

/** Upper bound on cached chat rows (the server list is normally far smaller). */
export const CHAT_LOCAL_BOOT_CACHE_MAX_CHATS = 300;

/** Upper bound on cached workspaces. */
export const CHAT_LOCAL_BOOT_CACHE_MAX_WORKSPACES = 50;

/** Upper bound on folders cached per workspace. */
export const CHAT_LOCAL_BOOT_CACHE_MAX_FOLDERS = 100;

/** String fields copied verbatim from a runtime chat row (trimmed, empty dropped). */
const CHAT_STRING_FIELDS = Object.freeze([
  'titleSource',
  'cursorSessionId',
  'model',
  'workspaceFile',
  'workspaceFolder',
  'agentTransport',
  'sdkMode',
  'sdkUiMode',
  'sdkAgentId',
  'todoId',
  'forkParentChatId',
  'forkKind',
  'archivedAt',
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function readTrimmed(value) {
  return readString(value).trim();
}

/**
 * @param {unknown} value
 * @returns {string | number | undefined}
 */
function readTimestamp(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function readOptionalBoolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function readOptionalFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Reduce one runtime/server chat row to the fields the sidebar, chat bar, `openTerminal`,
 * and the history hydration path read on a cold start. Runtime-only fields (`pane`, `ws`,
 * `_buffer`, `_*`, including the transient `_pushPreview`) are dropped so the snapshot
 * stays small and JSON-safe.
 *
 * @param {unknown} chat
 * @returns {object | null}
 */
export function sanitizeChatRowForBootCache(chat) {
  if (!chat || typeof chat !== 'object') return null;
  const id = readTrimmed(/** @type {{ id?: unknown }} */ (chat).id);
  if (!id) return null;
  const row = /** @type {Record<string, unknown>} */ ({
    id,
    title: readString(/** @type {{ title?: unknown }} */ (chat).title),
  });
  for (const field of CHAT_STRING_FIELDS) {
    const value = readTrimmed(/** @type {Record<string, unknown>} */ (chat)[field]);
    if (value) row[field] = value;
  }
  const createdAt = readTimestamp(/** @type {{ createdAt?: unknown }} */ (chat).createdAt);
  if (createdAt !== undefined) row.createdAt = createdAt;
  const updatedAt = readTimestamp(/** @type {{ updatedAt?: unknown }} */ (chat).updatedAt);
  if (updatedAt !== undefined) row.updatedAt = updatedAt;
  const compressionEnabled = readOptionalBoolean(
    /** @type {{ autoContextCompressionEnabled?: unknown }} */ (chat).autoContextCompressionEnabled
  );
  if (compressionEnabled !== undefined) row.autoContextCompressionEnabled = compressionEnabled;
  const compressionThreshold = readOptionalFiniteNumber(
    /** @type {{ autoContextCompressionThreshold?: unknown }} */ (chat).autoContextCompressionThreshold
  );
  if (compressionThreshold !== undefined) row.autoContextCompressionThreshold = compressionThreshold;
  const compressionReset = readOptionalBoolean(
    /** @type {{ autoContextCompressionReset?: unknown }} */ (chat).autoContextCompressionReset
  );
  if (compressionReset !== undefined) row.autoContextCompressionReset = compressionReset;
  if (/** @type {{ isTemporary?: unknown }} */ (chat).isTemporary === true) row.isTemporary = true;
  if (/** @type {{ watcherPinned?: unknown }} */ (chat).watcherPinned === true) row.watcherPinned = true;
  const harnessState = /** @type {{ harnessState?: unknown }} */ (chat).harnessState;
  if (harnessState && typeof harnessState === 'object') {
    const code = readTrimmed(/** @type {{ code?: unknown }} */ (harnessState).code);
    row.harnessState = code ? { code } : {};
  }
  return row;
}

/**
 * @param {unknown} folder
 * @returns {object | null}
 */
function sanitizeWorkspaceFolder(folder) {
  if (!folder || typeof folder !== 'object') return null;
  const out = /** @type {Record<string, unknown>} */ ({});
  const name = readString(/** @type {{ name?: unknown }} */ (folder).name);
  if (name) out.name = name;
  const resolvedPath = readString(/** @type {{ resolvedPath?: unknown }} */ (folder).resolvedPath);
  if (resolvedPath) out.resolvedPath = resolvedPath;
  const enabled = readOptionalBoolean(/** @type {{ enabled?: unknown }} */ (folder).enabled);
  if (enabled !== undefined) out.enabled = enabled;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Reduce one `/api/workspaces` row to the fields the sidebar/New-chat pickers read.
 *
 * @param {unknown} workspace
 * @returns {object | null}
 */
export function sanitizeWorkspaceForBootCache(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  const workspaceFile = readTrimmed(/** @type {{ workspaceFile?: unknown }} */ (workspace).workspaceFile);
  const id = readTrimmed(/** @type {{ id?: unknown }} */ (workspace).id) || workspaceFile;
  if (!id && !workspaceFile) return null;
  const out = /** @type {Record<string, unknown>} */ ({ id: id || workspaceFile });
  const kind = readTrimmed(/** @type {{ kind?: unknown }} */ (workspace).kind);
  if (kind) out.kind = kind;
  if (workspaceFile) out.workspaceFile = workspaceFile;
  const name = readString(/** @type {{ name?: unknown }} */ (workspace).name);
  if (name) out.name = name;
  const workspaceDir = readString(/** @type {{ workspaceDir?: unknown }} */ (workspace).workspaceDir);
  if (workspaceDir) out.workspaceDir = workspaceDir;
  const folders = /** @type {{ folders?: unknown }} */ (workspace).folders;
  if (Array.isArray(folders)) {
    const sanitizedFolders = folders
      .map(sanitizeWorkspaceFolder)
      .filter(Boolean)
      .slice(0, CHAT_LOCAL_BOOT_CACHE_MAX_FOLDERS);
    if (sanitizedFolders.length > 0) out.folders = sanitizedFolders;
  }
  return out;
}

/**
 * Build the serializable boot document.
 *
 * @param {{
 *   chats?: unknown[],
 *   workspaces?: unknown[],
 *   activeChatId?: unknown,
 *   workspaceContext?: { workspaceFile?: unknown, workspaceFolder?: unknown } | null,
 *   now?: number,
 * }} input
 * @returns {{ v: number, savedAt: number, activeChatId: string, workspaceContext: { workspaceFile: string, workspaceFolder: string }, workspaces: object[], chats: object[] }}
 */
/**
 * Newest rows first, always keeping the active chat and watcher-pinned rows
 * even when they fall outside the cap.
 *
 * @param {unknown[]} chats
 * @param {unknown} activeChatId
 * @returns {object[]}
 */
function selectChatsForBootCache(chats, activeChatId) {
  const rows = (Array.isArray(chats) ? chats : [])
    .map(sanitizeChatRowForBootCache)
    .filter(Boolean);
  const activeId = readTrimmed(activeChatId);
  const kept = new Set();
  const required = [];
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
  if (rows.length <= CHAT_LOCAL_BOOT_CACHE_MAX_CHATS) return rows;
  rest.sort((left, right) => {
    const delta = getChatUpdatedAtMs(right) - getChatUpdatedAtMs(left);
    if (delta !== 0) return delta;
    return String(left.id).localeCompare(String(right.id));
  });
  const selected = required.slice();
  for (const row of rest) {
    if (selected.length >= CHAT_LOCAL_BOOT_CACHE_MAX_CHATS) break;
    if (kept.has(row.id)) continue;
    selected.push(row);
    kept.add(row.id);
  }
  return selected;
}

export function buildChatLocalBootCache(input = {}) {
  const chats = selectChatsForBootCache(input.chats, input.activeChatId);
  const workspaces = (Array.isArray(input.workspaces) ? input.workspaces : [])
    .map(sanitizeWorkspaceForBootCache)
    .filter(Boolean)
    .slice(0, CHAT_LOCAL_BOOT_CACHE_MAX_WORKSPACES);
  const workspaceContext = input.workspaceContext && typeof input.workspaceContext === 'object'
    ? input.workspaceContext
    : {};
  return {
    v: CHAT_LOCAL_BOOT_CACHE_VERSION,
    savedAt: Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now(),
    activeChatId: readTrimmed(input.activeChatId),
    workspaceContext: {
      workspaceFile: readTrimmed(workspaceContext.workspaceFile),
      workspaceFolder: readTrimmed(workspaceContext.workspaceFolder),
    },
    workspaces,
    chats,
  };
}

/**
 * Parse a raw JSON string. Returns `null` when the document is absent, malformed, or from
 * an older version — the caller then ignores it and waits for the network as before.
 *
 * @param {unknown} raw
 * @returns {{ v: number, savedAt: number, activeChatId: string, workspaceContext: { workspaceFile: string, workspaceFolder: string }, workspaces: object[], chats: object[] } | null}
 */
export function parseChatLocalBootCache(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (Number(parsed.v) !== CHAT_LOCAL_BOOT_CACHE_VERSION) return null;
  const chats = Array.isArray(parsed.chats)
    ? parsed.chats.map(sanitizeChatRowForBootCache).filter(Boolean)
    : [];
  const workspaces = Array.isArray(parsed.workspaces)
    ? parsed.workspaces.map(sanitizeWorkspaceForBootCache).filter(Boolean)
    : [];
  if (chats.length === 0) return null;
  const workspaceContext = parsed.workspaceContext && typeof parsed.workspaceContext === 'object'
    ? parsed.workspaceContext
    : {};
  return {
    v: CHAT_LOCAL_BOOT_CACHE_VERSION,
    savedAt: Number(parsed.savedAt) || 0,
    activeChatId: readTrimmed(parsed.activeChatId),
    workspaceContext: {
      workspaceFile: readTrimmed(workspaceContext.workspaceFile),
      workspaceFolder: readTrimmed(workspaceContext.workspaceFolder),
    },
    workspaces,
    chats,
  };
}

/**
 * Pure "render from cache vs wait" decision for the cold-start path.
 *
 * @param {{
 *   runtimeChatCount?: number,
 *   cachedChatCount?: number,
 *   skipCache?: boolean,
 *   alreadyHydrated?: boolean,
 * }} input
 * @returns {boolean}
 */
export function shouldHydrateChatListFromBootCache(input = {}) {
  if (input.alreadyHydrated === true) return false;
  if (input.skipCache === true) return false;
  if (Number(input.runtimeChatCount) > 0) return false;
  return Number(input.cachedChatCount) > 0;
}

/**
 * @param {Storage | null | undefined} storage
 * @returns {ReturnType<typeof parseChatLocalBootCache>}
 */
export function readChatLocalBootCache(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    return parseChatLocalBootCache(readStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_CACHE_KEY, ''));
  } catch (_) {
    return null;
  }
}

/**
 * Content fingerprint of a snapshot, deliberately ignoring `savedAt`: the live sync writes
 * on every reload, and a reload that changed nothing must not hit localStorage again.
 *
 * @param {ReturnType<typeof buildChatLocalBootCache>} doc
 * @returns {string}
 */
function chatBootCacheSignature(doc) {
  return JSON.stringify([
    doc.v,
    doc.activeChatId,
    doc.workspaceContext,
    doc.workspaces,
    doc.chats,
  ]);
}

/**
 * Last written fingerprint per storage object. Only this module writes the key, so a match
 * means the stored document already holds exactly this content.
 * @type {WeakMap< object, string >}
 */
const lastWrittenSignatures = new WeakMap();

/**
 * Persist the snapshot, swallowing quota/private-mode errors. Returns whether the stored
 * snapshot is current afterwards (an identical document is not written again).
 *
 * @param {Storage | null | undefined} storage
 * @param {Parameters<typeof buildChatLocalBootCache>[0]} input
 * @returns {boolean}
 */
export function writeChatLocalBootCache(storage, input) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  const doc = buildChatLocalBootCache(input);
  if (doc.chats.length === 0) return false;
  // The workspace fetch can resolve after the first chat list; never replace a usable
  // cached workspace list with an empty one, or the next offline cold start loses grouping.
  if (doc.workspaces.length === 0) {
    const previous = readChatLocalBootCache(storage);
    if (previous && previous.workspaces.length > 0) doc.workspaces = previous.workspaces;
  }
  const signature = chatBootCacheSignature(doc);
  if (lastWrittenSignatures.get(storage) === signature) return true;
  try {
    writeStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_CACHE_KEY, JSON.stringify(doc));
    lastWrittenSignatures.set(storage, signature);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Drop the boot snapshot (logout, 401, session expiry). Best effort.
 *
 * @param {Storage | null | undefined} storage
 */
export function clearChatLocalBootCache(storage) {
  if (!storage || typeof storage.removeItem !== 'function') return;
  lastWrittenSignatures.delete(storage);
  try {
    removeStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_CACHE_KEY);
  } catch (_) {}
}
