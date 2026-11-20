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
import { createStoragePersistenceAdapter } from './chatPersistenceAdapter.js';
import { writeChatLocalBootSync } from './chatLocalBootSync.js';
import { getUiFreezeCounters, measureFreezeSpan } from '../../lib/uiFreezeCounters.js';
import {
  comparePreparedRankingUpdatedAtMsDesc,
  prepareChatRankingUpdatedAtMs,
} from './chatListSort.js';
import {
  createSliceSession,
  forEachInTimeSlices,
} from '../../lib/schedulerYield.js';

/** localStorage key holding the boot snapshot. */
export const CHAT_LOCAL_BOOT_CACHE_KEY = 'cretli-chat-boot-cache-v1';

/** Snapshot schema version; a mismatch discards the old document. */
export const CHAT_LOCAL_BOOT_CACHE_VERSION = 1;

/** Upper bound on cached chat rows (the server list is normally far smaller). */
export const CHAT_LOCAL_BOOT_CACHE_MAX_CHATS = 300;

/** Sanitize/build with yields when the runtime list exceeds the boot cap (task 8.1). */
export const CHAT_BOOT_CACHE_BUILD_SLICE_THRESHOLD = CHAT_LOCAL_BOOT_CACHE_MAX_CHATS;

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
  if (/** @type {{ onWorktree?: unknown }} */ (chat).onWorktree === true) row.onWorktree = true;
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
  const rankedRest = prepareChatRankingUpdatedAtMs(rest).sort(comparePreparedRankingUpdatedAtMsDesc);
  const selected = required.slice();
  for (const { chat: row } of rankedRest) {
    if (selected.length >= CHAT_LOCAL_BOOT_CACHE_MAX_CHATS) break;
    if (kept.has(row.id)) continue;
    selected.push(row);
    kept.add(row.id);
  }
  return selected;
}

/**
 * @param {Parameters<typeof buildChatLocalBootCache>[0]} input
 * @param {{
 *   deps?: import('../../lib/schedulerYield.js').SchedulerYieldDeps,
 *   budgetMs?: number,
 *   session?: ReturnType<typeof createSliceSession>,
 * }} [options]
 * @returns {Promise<{ doc: ReturnType<typeof buildChatLocalBootCacheDoc>, cancelled: boolean }>}
 */
export async function buildChatLocalBootCacheDocAsync(input = {}, options = {}) {
  const rawChats = Array.isArray(input.chats) ? input.chats : [];
  if (rawChats.length <= CHAT_BOOT_CACHE_BUILD_SLICE_THRESHOLD) {
    return { doc: buildChatLocalBootCacheDoc(input), cancelled: false };
  }
  const isApplyFresh = typeof options.isApplyFresh === 'function' ? options.isApplyFresh : () => true;
  if (!isApplyFresh()) return { doc: buildChatLocalBootCacheDoc(input), cancelled: true };
  /** @type {object[]} */
  const sanitized = [];
  const result = await forEachInTimeSlices(rawChats, {
    session: options.session || createSliceSession(),
    deps: options.deps,
    budgetMs: options.budgetMs,
    onItem: (chat) => {
      if (!isApplyFresh()) return;
      const row = sanitizeChatRowForBootCache(chat);
      if (row) sanitized.push(row);
    },
  });
  if (result.cancelled || !isApplyFresh()) {
    return { doc: buildChatLocalBootCacheDoc(input), cancelled: true };
  }
  return { doc: buildChatLocalBootCacheDoc({ ...input, chats: sanitized }), cancelled: false };
}

function buildChatLocalBootCacheDoc(input = {}) {
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
 * Build the serializable boot document.
 *
 * Task 0.1 adds the `boot-cache.build` span around this call. The span covers
 * the whole build (sanitizing, the >300 sort and the activity-map reads it
 * triggers), so the baseline can separate it from the poll and the layout.
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
export function buildChatLocalBootCache(input = {}) {
  const counters = getUiFreezeCounters();
  if (!counters) return buildChatLocalBootCacheDoc(input);
  counters.bump('cache.builds');
  const sourceChats = Array.isArray(input?.chats) ? input.chats.length : 0;
  return measureFreezeSpan('boot-cache.build', { sourceChats }, () =>
    buildChatLocalBootCacheDoc(input)
  );
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
  const counters = getUiFreezeCounters();
  if (counters) {
    counters.bump('cache.reads');
    counters.bump('storage.reads');
  }
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
 * @param {ReturnType<typeof buildChatLocalBootCacheDoc>} doc
 * @returns {string}
 */
export function chatLocalBootCacheContentSignature(doc) {
  if (!doc || typeof doc !== 'object') return '';
  return chatBootCacheSignature(doc);
}

/**
 * True when `candidate` should replace `incumbent` in IDB (strictly newer snapshot).
 *
 * @param {ReturnType<typeof parseChatLocalBootCache>} incumbent
 * @param {ReturnType<typeof parseChatLocalBootCache>} candidate
 * @returns {boolean}
 */
export function shouldReplaceChatLocalBootCacheDoc(incumbent, candidate) {
  if (!candidate) return false;
  if (!incumbent) return true;
  const candidateAt = Number(candidate.savedAt) || 0;
  const incumbentAt = Number(incumbent.savedAt) || 0;
  if (candidateAt !== incumbentAt) return candidateAt > incumbentAt;
  return chatBootCacheSignature(candidate) !== chatBootCacheSignature(incumbent);
}

/**
 * True when `candidate` is a strict subset of `incumbent` chat ids (partial runtime list).
 *
 * This is deliberately only a *shape* test — it does NOT decide whether a write is skipped.
 * A server-confirmed list may legitimately be smaller than the durable snapshot (chat
 * deleted), so the caller must gate this on an explicit "this runtime list is an unconfirmed
 * boot-cache slice" signal (`input.source === 'boot-cache'`), never on a row-count threshold.
 * The old `incumbent > 40 && candidate <= 40` heuristic froze every server deletion that
 * crossed that boundary (41 -> 40) and left ghosts in IDB forever.
 *
 * @param {ReturnType<typeof parseChatLocalBootCache>} incumbent
 * @param {ReturnType<typeof parseChatLocalBootCache>} candidate
 * @returns {boolean}
 */
export function isPartialBootCacheSubsetShrink(incumbent, candidate) {
  if (!incumbent || !candidate) return false;
  const incumbentChats = Array.isArray(incumbent.chats) ? incumbent.chats : [];
  const candidateChats = Array.isArray(candidate.chats) ? candidate.chats : [];
  if (candidateChats.length === 0) return false;
  if (candidateChats.length >= incumbentChats.length) return false;
  const incumbentIds = new Set(
    incumbentChats.map((row) => (row && typeof row === 'object' ? row.id : '')).filter(Boolean),
  );
  for (const row of candidateChats) {
    const id = row && typeof row === 'object' ? row.id : '';
    if (id && !incumbentIds.has(id)) return false;
  }
  return true;
}

/**
 * Whether a persist input carries an *unconfirmed boot-cache slice* — a list hydrated from
 * the local snapshot that the server has not reconciled yet. Only that explicit source may
 * skip a subset-shrink write. A server-confirmed list (`source: 'server'` or absent) always
 * writes, even when it is smaller than the durable snapshot.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isUnconfirmedBootCacheSource(input) {
  return !!input && typeof input === 'object' && input.source === 'boot-cache';
}

/**
 * Make sure the adapter's in-memory mirror holds the durable boot snapshot before the
 * subset-shrink guard reads it. The IDB adapter's synchronous `read()` only serves its
 * in-memory cache, and on an offline cold start `ensurePrime()` is often never called
 * (the legacy localStorage snapshot short-circuits the IDB hydration), so without this the
 * incumbent reads as `null` and a 40-row boot slice would overwrite the full snapshot (F1).
 *
 * @param {{ refreshMetaKeyFromIdb?: (key: string) => Promise<boolean>, ensurePrime?: () => Promise<void> } | null | undefined} adapter
 * @returns {Promise<void>}
 */
async function primeIncumbentBootCacheDoc(adapter) {
  if (!adapter) return;
  if (typeof adapter.refreshMetaKeyFromIdb === 'function') {
    try {
      await adapter.refreshMetaKeyFromIdb(CHAT_LOCAL_BOOT_CACHE_KEY);
      return;
    } catch (_) {}
  }
  if (typeof adapter.ensurePrime === 'function') {
    try {
      await adapter.ensurePrime();
    } catch (_) {}
  }
}

/**
 * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter | null | undefined} adapter
 * @returns {ReturnType<typeof parseChatLocalBootCache> | null}
 */
function readIncumbentBootCacheDoc(adapter) {
  if (!adapter || typeof adapter.read !== 'function') return null;
  try {
    return parseChatLocalBootCache(adapter.read(CHAT_LOCAL_BOOT_CACHE_KEY));
  } catch (_) {
    return null;
  }
}

/**
 * Last written fingerprint per storage object. Only this module writes the key, so a match
 * means the stored document already holds exactly this content.
 * @type {WeakMap<object, { lastSignature: string }>}
 */
const lastWrittenRevisionStates = new WeakMap();

/**
 * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter | null | undefined} adapter
 * @param {Parameters<typeof buildChatLocalBootCache>[0]} input
 * @returns {ReturnType<typeof buildChatLocalBootCacheDoc> | null}
 */
/**
 * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter | null | undefined} adapter
 * @param {Parameters<typeof buildChatLocalBootCache>[0]} input
 * @param {Parameters<typeof buildChatLocalBootCacheDocAsync>[1]} [sliceOptions]
 * @returns {Promise<{ doc: ReturnType<typeof buildChatLocalBootCacheDoc> | null, cancelled: boolean }>}
 */
export async function resolveBootCacheDocForPersistAsync(adapter, input, sliceOptions = {}) {
  const built = await buildChatLocalBootCacheDocAsync(input, sliceOptions);
  if (built.cancelled) return { doc: null, cancelled: true };
  const doc = built.doc;
  if (!doc || doc.chats.length === 0) return { doc: null, cancelled: false };
  if (doc.workspaces.length === 0 && adapter && typeof adapter.read === 'function') {
    const previous = parseChatLocalBootCache(adapter.read(CHAT_LOCAL_BOOT_CACHE_KEY));
    if (previous && previous.workspaces.length > 0) {
      return { doc: { ...doc, workspaces: previous.workspaces }, cancelled: false };
    }
  }
  return { doc, cancelled: false };
}

function resolveBootCacheDocForPersist(adapter, input) {
  const doc = buildChatLocalBootCacheDoc(input);
  if (doc.chats.length === 0) return null;
  if (doc.workspaces.length === 0 && adapter && typeof adapter.read === 'function') {
    const previous = parseChatLocalBootCache(adapter.read(CHAT_LOCAL_BOOT_CACHE_KEY));
    if (previous && previous.workspaces.length > 0) {
      return { ...doc, workspaces: previous.workspaces };
    }
  }
  return doc;
}

/**
 * Content fingerprint for a boot-cache input without bumping freeze counters.
 *
 * @param {Parameters<typeof buildChatLocalBootCache>[0]} input
 * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter | null | undefined} [adapter]
 * @returns {string}
 */
export function computeChatLocalBootCacheSignature(input, adapter = null) {
  const doc = resolveBootCacheDocForPersist(adapter, input);
  if (!doc) return '';
  return chatBootCacheSignature(doc);
}

/**
 * @typedef {{ lastSignature?: string }} ChatBootCacheRevisionState
 * @typedef {{ written: boolean, built: boolean, signature: string, cancelled?: boolean, doc?: ReturnType<typeof buildChatLocalBootCacheDoc> | null }} ChatBootCacheWriteResult
 */

/**
 * Persist boot cache through the shared persistence adapter. Checks revision before building
 * the snapshot so repeated renders with unchanged data never bump `cache.builds`.
 *
 * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter} adapter
 * @param {Parameters<typeof buildChatLocalBootCache>[0]} input
 * @param {ChatBootCacheRevisionState} [revisionState]
 * @returns {ChatBootCacheWriteResult}
 */
export function writeChatLocalBootCacheToAdapter(adapter, input, revisionState = {}) {
  if (!adapter || typeof adapter.write !== 'function') {
    return { written: false, built: false, signature: '' };
  }
  const doc = resolveBootCacheDocForPersist(adapter, input);
  if (!doc) return { written: false, built: false, signature: '' };
  const signature = chatBootCacheSignature(doc);
  const lastSignature = typeof revisionState.lastSignature === 'string' ? revisionState.lastSignature : '';
  if (signature === lastSignature) {
    return { written: false, built: false, signature };
  }
  const incumbent = readIncumbentBootCacheDoc(adapter);
  if (isUnconfirmedBootCacheSource(input) && isPartialBootCacheSubsetShrink(incumbent, doc)) {
    return { written: false, built: false, signature, skippedSubsetShrink: true };
  }
  const counters = getUiFreezeCounters();
  if (counters) counters.bump('cache.builds');
  const sourceChats = Array.isArray(input?.chats) ? input.chats.length : 0;
  const writePayload = () => {
    try {
      if (!adapter.write(CHAT_LOCAL_BOOT_CACHE_KEY, JSON.stringify(doc))) {
        return false;
      }
      revisionState.lastSignature = signature;
      counters?.bump('cache.writes');
      return true;
    } catch (_) {
      return false;
    }
  };
  const written = counters
    ? measureFreezeSpan('boot-cache.build', { sourceChats }, writePayload)
    : writePayload();
  return { written, built: true, signature, doc };
}

/**
 * Async persist with time-sliced sanitization for large runtime lists (task 8.1).
 *
 * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter} adapter
 * @param {Parameters<typeof buildChatLocalBootCache>[0]} input
 * @param {ChatBootCacheRevisionState} [revisionState]
 * @param {Parameters<typeof buildChatLocalBootCacheDocAsync>[1]} [sliceOptions]
 * @returns {Promise<ChatBootCacheWriteResult>}
 */
export async function writeChatLocalBootCacheToAdapterAsync(
  adapter,
  input,
  revisionState = {},
  sliceOptions = {},
) {
  if (!adapter || typeof adapter.write !== 'function') {
    return { written: false, built: false, signature: '' };
  }
  const canPersist = typeof sliceOptions.canPersist === 'function' ? sliceOptions.canPersist : () => true;
  const rawCount = Array.isArray(input?.chats) ? input.chats.length : 0;
  let doc = null;
  if (rawCount > CHAT_BOOT_CACHE_BUILD_SLICE_THRESHOLD) {
    const resolved = await resolveBootCacheDocForPersistAsync(adapter, input, sliceOptions);
    if (resolved.cancelled) {
      return { written: false, built: false, signature: '', cancelled: true };
    }
    doc = resolved.doc;
  } else {
    doc = resolveBootCacheDocForPersist(adapter, input);
  }
  if (!doc) return { written: false, built: false, signature: '' };
  if (!canPersist()) {
    return { written: false, built: false, signature: '', cancelled: true };
  }
  const signature = chatBootCacheSignature(doc);
  const lastSignature = typeof revisionState.lastSignature === 'string' ? revisionState.lastSignature : '';
  if (signature === lastSignature) {
    return { written: false, built: false, signature };
  }
  // The unconfirmed-boot-cache guard compares against the durable snapshot, so make sure
  // the adapter mirror actually holds it before reading (see primeIncumbentBootCacheDoc).
  if (isUnconfirmedBootCacheSource(input)) {
    await primeIncumbentBootCacheDoc(adapter);
  }
  const incumbent = readIncumbentBootCacheDoc(adapter);
  if (isUnconfirmedBootCacheSource(input) && isPartialBootCacheSubsetShrink(incumbent, doc)) {
    return { written: false, built: false, signature, skippedSubsetShrink: true };
  }
  const counters = getUiFreezeCounters();
  if (counters) counters.bump('cache.builds');
  const sourceChats = rawCount;
  const writePayload = () => {
    if (!canPersist()) return false;
    try {
      if (!adapter.write(CHAT_LOCAL_BOOT_CACHE_KEY, JSON.stringify(doc))) {
        return false;
      }
      if (!canPersist()) return false;
      revisionState.lastSignature = signature;
      counters?.bump('cache.writes');
      return true;
    } catch (_) {
      return false;
    }
  };
  const written = counters
    ? measureFreezeSpan('boot-cache.build', { sourceChats }, writePayload)
    : writePayload();
  if (!written && !canPersist()) {
    return { written: false, built: true, signature: '', cancelled: true, doc: null };
  }
  return { written, built: true, signature, doc };
}

/**
 * Write the synchronous localStorage bootstrap for a built full snapshot.
 *
 * @param {Storage | null | undefined} storage
 * @param {ReturnType<typeof buildChatLocalBootCacheDoc>} doc
 * @param {string} [fullSignature]
 * @returns {boolean}
 */
export function writeChatLocalBootSyncFromFullDoc(storage, doc, fullSignature = '') {
  if (!doc) return false;
  return writeChatLocalBootSync(storage, {
    savedAt: doc.savedAt,
    activeChatId: doc.activeChatId,
    workspaceContext: doc.workspaceContext,
    workspaces: doc.workspaces,
    chats: doc.chats,
  }, { fullSignature: fullSignature || chatBootCacheSignature(doc) });
}

/**
 * @param {Storage | null | undefined} storage
 * @returns {ChatBootCacheRevisionState}
 */
function revisionStateForStorage(storage) {
  if (!storage) return { lastSignature: '' };
  let state = lastWrittenRevisionStates.get(storage);
  if (!state) {
    state = { lastSignature: '' };
    lastWrittenRevisionStates.set(storage, state);
  }
  return state;
}

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
  const adapter = createStoragePersistenceAdapter(() => storage);
  const revision = revisionStateForStorage(storage);
  const result = writeChatLocalBootCacheToAdapter(adapter, input, revision);
  if (result.doc) {
    writeChatLocalBootSyncFromFullDoc(storage, result.doc, result.signature);
  }
  return result.written || (!result.built && Boolean(result.signature));
}

/**
 * Drop the in-memory revision marker for a storage object (tests and session invalidation).
 *
 * @param {Storage | null | undefined} storage
 */
export function resetChatLocalBootCacheRevision(storage) {
  if (!storage) return;
  lastWrittenRevisionStates.delete(storage);
}

/**
 * Drop the boot snapshot (logout, 401, session expiry). Best effort.
 *
 * @param {Storage | null | undefined} storage
 */
export function clearChatLocalBootCache(storage) {
  if (!storage || typeof storage.removeItem !== 'function') return;
  lastWrittenRevisionStates.delete(storage);
  try {
    removeStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_CACHE_KEY);
  } catch (_) {}
}
