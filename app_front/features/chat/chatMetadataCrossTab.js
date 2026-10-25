/**
 * Cross-tab metadata notifications (task 5.4).
 *
 * BroadcastChannel is preferred; when unavailable, a dedicated localStorage key
 * raises `storage` events in peer tabs. Messages carry session scope, IDB epoch,
 * boot revision, and dirty chat ids only — no runtime payloads.
 *
 * Receivers merge activity into RAM via the persistence adapter (max timestamp
 * per key) without re-enqueueing durable writes (no echo / ping-pong).
 */

import {
  readStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import {
  getChatMetadataIdbOperationEpoch,
  getChatMetadataKvBatch,
} from './chatMetadataIdb.js';
import { CHAT_LOCAL_BOOT_CACHE_KEY } from './chatLocalBootCache.js';
import {
  CHAT_ACTIVITY_STORAGE_KEY,
  CHAT_LAST_USED_STORAGE_KEY,
  parseTimestampMapPayload,
} from './chatPersistenceAdapter.js';
import {
  chatIdbActivityEntryKey,
  chatIdbLastUsedEntryKey,
  isChatMetadataIdbPersistenceAdapter,
} from './chatPersistenceIdbAdapter.js';

/** BroadcastChannel name shared by every tab of this origin. */
export const CHAT_METADATA_CROSS_TAB_CHANNEL = 'cretli-chat-metadata-cross-tab-v1';

/** localStorage fallback when BroadcastChannel is missing. */
export const CHAT_METADATA_CROSS_TAB_STORAGE_KEY = 'cretli-chat-metadata-cross-tab-v1';

/** Wire format version. */
export const CHAT_METADATA_CROSS_TAB_MESSAGE_VERSION = 1;

/**
 * @typedef {object} ChatMetadataCrossTabFlushMessage
 * @property {number} v
 * @property {'flush'} kind
 * @property {string} tabId
 * @property {number} seq
 * @property {string} sessionId
 * @property {number} generation
 * @property {number} idbEpoch
 * @property {string} revision
 * @property {string[]} activityIds
 * @property {string[]} lastUsedIds
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} raw
 * @returns {ChatMetadataCrossTabFlushMessage | null}
 */
export function parseChatMetadataCrossTabMessage(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (Number(parsed.v) !== CHAT_METADATA_CROSS_TAB_MESSAGE_VERSION) return null;
  if (parsed.kind !== 'flush') return null;
  const tabId = normalizeId(parsed.tabId);
  const sessionId = normalizeId(parsed.sessionId);
  if (!tabId || !sessionId) return null;
  const seq = Number(parsed.seq);
  if (!Number.isFinite(seq) || seq < 0) return null;
  const generation = Number(parsed.generation);
  const idbEpoch = Number(parsed.idbEpoch);
  const activityIds = Array.isArray(parsed.activityIds)
    ? parsed.activityIds.map(normalizeId).filter(Boolean)
    : [];
  const lastUsedIds = Array.isArray(parsed.lastUsedIds)
    ? parsed.lastUsedIds.map(normalizeId).filter(Boolean)
    : [];
  return {
    v: CHAT_METADATA_CROSS_TAB_MESSAGE_VERSION,
    kind: 'flush',
    tabId,
    seq,
    sessionId,
    generation: Number.isFinite(generation) ? generation : 0,
    idbEpoch: Number.isFinite(idbEpoch) ? idbEpoch : 0,
    revision: normalizeId(parsed.revision),
    activityIds,
    lastUsedIds,
  };
}

/**
 * @param {string} tabId
 * @returns {string}
 */
function createTabId(tabId) {
  if (tabId) return tabId;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {{
 *   tabId?: string,
 *   getSession: () => { sessionId: string, generation: number },
 *   getIdbEpoch?: () => number,
 *   getAdapter: () => import('./chatPersistenceAdapter.js').ChatPersistenceAdapter | null,
 *   getActivityStore: () => {
 *     mergeActivity: Function,
 *     mergeLastUsed: Function,
 *     getSession: () => { sessionId: string, generation: number },
 *   },
 *   getBootRevision?: () => string,
 *   onBootRevision?: (revision: string) => void,
 *   getIdb?: () => (IDBFactory | null),
 *   storage?: Storage | (() => (Storage | null)) | null,
 *   broadcastChannel?: typeof BroadcastChannel,
 *   now?: () => number,
 * }} options
 */
export function createChatMetadataCrossTabSync(options) {
  const tabId = createTabId(options.tabId);
  const getSession = options.getSession;
  const getIdbEpoch = typeof options.getIdbEpoch === 'function'
    ? options.getIdbEpoch
    : () => getChatMetadataIdbOperationEpoch();
  const getAdapter = options.getAdapter;
  const getActivityStore = options.getActivityStore;
  const getBootRevision = typeof options.getBootRevision === 'function' ? options.getBootRevision : () => '';
  const onBootRevision = typeof options.onBootRevision === 'function' ? options.onBootRevision : null;
  const getIdb = typeof options.getIdb === 'function'
    ? options.getIdb
    : () => (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** @type {Set<Promise<unknown>>} */
  const pendingIncoming = new Set();
  const resolveStorage = () => {
    if (typeof options.storage === 'function') return options.storage() || null;
    if (options.storage) return options.storage;
    return typeof localStorage !== 'undefined' ? localStorage : null;
  };
  const BroadcastChannelRef = options.broadcastChannel
    || (typeof globalThis !== 'undefined' ? globalThis.BroadcastChannel : undefined);
  /** @type {BroadcastChannel | null} */
  let channel = null;
  let channelBroken = false;
  if (BroadcastChannelRef && !channelBroken) {
    try {
      channel = new BroadcastChannelRef(CHAT_METADATA_CROSS_TAB_CHANNEL);
    } catch (_) {
      channelBroken = true;
    }
  }
  let seq = 0;
  /** @type {Map<string, number>} last seq applied per sender tab */
  const lastSeqByTab = new Map();
  /** @type {Set<string>} dedupe keys for BC + storage double delivery */
  const appliedKeys = new Set();
  let localBootRevision = '';

  /**
   * @param {ChatMetadataCrossTabFlushMessage} message
   * @returns {boolean}
   */
  function isScopeAccepted(message) {
    const current = getActivityStore().getSession();
    if (message.sessionId !== current.sessionId) return false;
    if (Number.isFinite(message.generation) && message.generation < current.generation) return false;
    if (message.idbEpoch !== getIdbEpoch()) return false;
    return true;
  }

  /**
   * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter} adapter
   * @param {string} chatId
   * @param {'activity' | 'lastUsed'} field
   * @returns {number}
   */
  function readTimestampFromAdapterCache(adapter, chatId, field) {
    const id = normalizeId(chatId);
    if (!id || !adapter || typeof adapter.read !== 'function') return 0;
    if (isChatMetadataIdbPersistenceAdapter(adapter)) {
      const key = field === 'lastUsed' ? chatIdbLastUsedEntryKey(id) : chatIdbActivityEntryKey(id);
      const raw = adapter.read(key);
      const ts = Number(raw);
      return Number.isFinite(ts) && ts > 0 ? ts : 0;
    }
    const storageKey = field === 'lastUsed' ? CHAT_LAST_USED_STORAGE_KEY : CHAT_ACTIVITY_STORAGE_KEY;
    const payload = parseTimestampMapPayload(adapter.read(storageKey));
    const ts = payload?.values?.[id];
    const num = Number(ts);
    return Number.isFinite(num) && num > 0 ? num : 0;
  }

  /**
   * @param {string} rawValue
   * @returns {number}
   */
  function parseTimestampValue(rawValue) {
    const ts = Number(rawValue);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  }

  /**
   * @param {ChatMetadataCrossTabFlushMessage} message
   * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter} adapter
   * @returns {Promise<{ activity: Record<string, number>, lastUsed: Record<string, number>, readFailed: boolean }>}
   */
  async function readTimestampDeltasFromIdb(message, adapter) {
    const activityIds = message.activityIds.map(normalizeId).filter(Boolean);
    const lastUsedIds = message.lastUsedIds.map(normalizeId).filter(Boolean);
    if (activityIds.length === 0 && lastUsedIds.length === 0) {
      return { activity: {}, lastUsed: {}, readFailed: false };
    }
    if (!isChatMetadataIdbPersistenceAdapter(adapter)) {
      /** @type {Record<string, number>} */
      const activity = {};
      /** @type {Record<string, number>} */
      const lastUsed = {};
      for (const id of activityIds) {
        const ts = readTimestampFromAdapterCache(adapter, id, 'activity');
        if (ts > 0) activity[id] = ts;
      }
      for (const id of lastUsedIds) {
        const ts = readTimestampFromAdapterCache(adapter, id, 'lastUsed');
        if (ts > 0) lastUsed[id] = ts;
      }
      const readFailed = (activityIds.length > 0 && Object.keys(activity).length === 0)
        || (lastUsedIds.length > 0 && Object.keys(lastUsed).length === 0);
      return { activity, lastUsed, readFailed };
    }
    /** @type {string[]} */
    const keys = [];
    /** @type {Map<string, { id: string, field: 'activity' | 'lastUsed' }>} */
    const keyMeta = new Map();
    for (const id of activityIds) {
      const key = chatIdbActivityEntryKey(id);
      keys.push(key);
      keyMeta.set(key, { id, field: 'activity' });
    }
    for (const id of lastUsedIds) {
      const key = chatIdbLastUsedEntryKey(id);
      keys.push(key);
      keyMeta.set(key, { id, field: 'lastUsed' });
    }
    const idbScope = { sessionId: message.sessionId, generation: message.generation };
    const batch = await getChatMetadataKvBatch(keys, idbScope, { idb: getIdb });
    if (batch === null) {
      return { activity: {}, lastUsed: {}, readFailed: true };
    }
    /** @type {Record<string, number>} */
    const activity = {};
    /** @type {Record<string, number>} */
    const lastUsed = {};
    for (const [key, rawValue] of Object.entries(batch)) {
      const meta = keyMeta.get(key);
      if (!meta) continue;
      const ts = parseTimestampValue(rawValue);
      if (ts <= 0) continue;
      if (meta.field === 'lastUsed') lastUsed[meta.id] = ts;
      else activity[meta.id] = ts;
    }
    const readFailed = (activityIds.length > 0 && Object.keys(activity).length === 0)
      || (lastUsedIds.length > 0 && Object.keys(lastUsed).length === 0);
    return { activity, lastUsed, readFailed };
  }

  /**
   * @param {ChatMetadataCrossTabFlushMessage} message
   * @param {import('./chatPersistenceAdapter.js').ChatPersistenceAdapter} adapter
   * @returns {Promise<boolean>}
   */
  async function refreshPeerBootSnapshot(message, adapter) {
    if (!message.revision) return true;
    if (message.revision === localBootRevision || message.revision === getBootRevision()) return true;
    if (isChatMetadataIdbPersistenceAdapter(adapter) && typeof adapter.refreshMetaKeyFromIdb === 'function') {
      const ok = await adapter.refreshMetaKeyFromIdb(CHAT_LOCAL_BOOT_CACHE_KEY);
      if (!ok) return false;
    }
    return true;
  }

  /**
   * @param {ChatMetadataCrossTabFlushMessage} message
   * @returns {Promise<{ applied: number, rejected: boolean, bootTriggered: boolean }>}
   */
  async function applyFlushMessage(message) {
    if (message.tabId === tabId) {
      return { applied: 0, rejected: false, bootTriggered: false };
    }
    const dedupeKey = `${message.tabId}:${message.seq}`;
    if (appliedKeys.has(dedupeKey)) {
      return { applied: 0, rejected: false, bootTriggered: false };
    }
    if (!isScopeAccepted(message)) {
      return { applied: 0, rejected: true, bootTriggered: false };
    }
    const adapter = getAdapter();
    if (!adapter) {
      return { applied: 0, rejected: true, bootTriggered: false };
    }
    const idbEpochBefore = getIdbEpoch();
    const deltas = await readTimestampDeltasFromIdb(message, adapter);
    if (!isScopeAccepted(message) || getIdbEpoch() !== idbEpochBefore) {
      return { applied: 0, rejected: true, bootTriggered: false };
    }
    const hasDirtyIds = message.activityIds.length > 0 || message.lastUsedIds.length > 0;
    if (hasDirtyIds && deltas.readFailed) {
      return { applied: 0, rejected: false, bootTriggered: false };
    }
    const store = getActivityStore();
    const scope = {
      sessionId: message.sessionId,
      generation: message.generation,
      source: 'cross-tab',
      persist: false,
      notify: true,
    };
    let applied = 0;
    if (Object.keys(deltas.activity).length > 0) {
      const result = store.mergeActivity(deltas.activity, scope);
      if (result.rejected) {
        return { applied: 0, rejected: true, bootTriggered: false };
      }
      applied += result.applied;
    }
    if (Object.keys(deltas.lastUsed).length > 0) {
      const result = store.mergeLastUsed(deltas.lastUsed, scope);
      if (result.rejected) {
        return { applied: 0, rejected: true, bootTriggered: false };
      }
      applied += result.applied;
    }
    let bootTriggered = false;
    if (message.revision && message.revision !== localBootRevision && message.revision !== getBootRevision()) {
      const bootOk = await refreshPeerBootSnapshot(message, adapter);
      if (!isScopeAccepted(message) || getIdbEpoch() !== idbEpochBefore) {
        return { applied: 0, rejected: true, bootTriggered: false };
      }
      if (!bootOk) {
        return { applied, rejected: false, bootTriggered: false };
      }
      localBootRevision = message.revision;
      if (onBootRevision) {
        onBootRevision(message.revision);
        bootTriggered = true;
      }
    }
    const prevSeq = lastSeqByTab.get(message.tabId) ?? -1;
    if (message.seq > prevSeq) lastSeqByTab.set(message.tabId, message.seq);
    appliedKeys.add(dedupeKey);
    void now;
    return { applied, rejected: false, bootTriggered };
  }

  /**
   * @param {unknown} raw
   * @returns {Promise<{ applied: number, rejected: boolean, bootTriggered: boolean }>}
   */
  function handleIncoming(raw) {
    const message = parseChatMetadataCrossTabMessage(raw);
    if (!message) return Promise.resolve({ applied: 0, rejected: true, bootTriggered: false });
    const work = applyFlushMessage(message);
    pendingIncoming.add(work);
    work.finally(() => pendingIncoming.delete(work));
    return work;
  }

  /** Await in-flight peer merges (tests). */
  function drainIncomingForTest() {
    if (pendingIncoming.size === 0) return Promise.resolve();
    return Promise.all([...pendingIncoming]);
  }

  /**
   * @param {{
   *   sessionId: string,
   *   generation: number,
   *   idbEpoch: number,
   *   revision?: string,
   *   activityIds?: string[],
   *   lastUsedIds?: string[],
   * }} detail
   */
  function publishFlush(detail) {
    const sessionId = normalizeId(detail.sessionId);
    if (!sessionId) return;
    seq += 1;
    /** @type {ChatMetadataCrossTabFlushMessage} */
    const message = {
      v: CHAT_METADATA_CROSS_TAB_MESSAGE_VERSION,
      kind: 'flush',
      tabId,
      seq,
      sessionId,
      generation: Number(detail.generation) || 0,
      idbEpoch: Number(detail.idbEpoch) || 0,
      revision: normalizeId(detail.revision),
      activityIds: Array.isArray(detail.activityIds) ? detail.activityIds.map(normalizeId).filter(Boolean) : [],
      lastUsedIds: Array.isArray(detail.lastUsedIds) ? detail.lastUsedIds.map(normalizeId).filter(Boolean) : [],
    };
    if (message.activityIds.length === 0 && message.lastUsedIds.length === 0 && !message.revision) {
      return;
    }
    const payload = JSON.stringify(message);
    let posted = false;
    if (channel && !channelBroken) {
      try {
        channel.postMessage(message);
        posted = true;
      } catch (_) {
        channelBroken = true;
        channel = null;
      }
    }
    if (!posted) {
      const storage = resolveStorage();
      if (!storage || typeof storage.setItem !== 'function') return;
      try {
        writeStorageValueWithAlias(storage, CHAT_METADATA_CROSS_TAB_STORAGE_KEY, payload);
      } catch (_) {
        /* best effort */
      }
    }
  }

  /** @param {MessageEvent} event */
  function onChannelMessage(event) {
    void handleIncoming(event?.data);
  }

  if (channel && typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', onChannelMessage);
  } else if (channel) {
    channel.onmessage = onChannelMessage;
  }

  /**
   * @param {{ key?: unknown, newValue?: unknown }} event
   * @returns {boolean}
   */
  function handleStorageEvent(event) {
    const key = event && typeof event.key === 'string' ? event.key : '';
    if (key !== CHAT_METADATA_CROSS_TAB_STORAGE_KEY) return false;
    if (event.newValue == null) return true;
    void handleIncoming(event.newValue);
    return true;
  }

  /**
   * @param {EventTarget | null | undefined} [target]
   * @returns {() => void}
   */
  function installStorageListener(target = typeof window !== 'undefined' ? window : null) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    const handler = (event) => {
      handleStorageEvent(event);
    };
    target.addEventListener('storage', handler);
    return () => {
      if (typeof target.removeEventListener === 'function') target.removeEventListener('storage', handler);
    };
  }

  function close() {
    if (channel) {
      try {
        if (typeof channel.removeEventListener === 'function') {
          channel.removeEventListener('message', onChannelMessage);
        }
        channel.close();
      } catch (_) {}
      channel = null;
    }
  }

  return {
    tabId,
    publishFlush,
    handleIncoming,
    handleStorageEvent,
    installStorageListener,
    close,
    drainIncomingForTest,
    /** Test seam */
    _readStorageFallback: () => {
      const storage = resolveStorage();
      if (!storage) return null;
      return readStorageValueWithAlias(storage, CHAT_METADATA_CROSS_TAB_STORAGE_KEY, '');
    },
  };
}

/** @type {ReturnType<typeof createChatMetadataCrossTabSync> | null} */
let sharedCrossTab = null;

/**
 * @param {Parameters<typeof createChatMetadataCrossTabSync>[0]} [options]
 * @returns {ReturnType<typeof createChatMetadataCrossTabSync>}
 */
export function installChatMetadataCrossTabSync(options = {}) {
  sharedCrossTab?.close();
  sharedCrossTab = createChatMetadataCrossTabSync(options);
  return sharedCrossTab;
}

/** @returns {ReturnType<typeof createChatMetadataCrossTabSync> | null} */
export function getChatMetadataCrossTabSync() {
  return sharedCrossTab;
}

/** @param {ReturnType<typeof createChatMetadataCrossTabSync> | null} [sync] */
export function __setChatMetadataCrossTabSyncForTest(sync) {
  sharedCrossTab?.close();
  sharedCrossTab = sync || null;
}

export function __resetChatMetadataCrossTabSyncForTest() {
  sharedCrossTab?.close();
  sharedCrossTab = null;
}
