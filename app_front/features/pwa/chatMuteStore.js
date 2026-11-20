/**
 * Browser persistence for the per-chat device mute (IndexedDB + in-memory cache).
 *
 * IndexedDB stays the source of truth so two cards on the same device cannot
 * erase each other's mutes: `setMuted` always re-reads the stored list before
 * writing and broadcasts the change to the other tabs. Throttle alerts are NOT
 * persisted — they are per-card best effort and would otherwise overwrite the
 * `muted` list.
 */
import {
  CHAT_MUTE_SCHEMA_VERSION,
  isChatMuted,
  normalizeChatMuteRecord,
  resolveChatAlertThrottle,
  setChatMuted,
} from '../../../lib/chat-mute.js';
import {
  createIndexedDbPersistence,
  PUSH_MUTED_CHATS_KEY,
} from './pushPreferencesStore.js';

/** Cross-tab channel carrying device mute changes. */
export const CHAT_MUTE_CHANNEL = 'cretli-chat-mute';

/** @type {{ cache: ReturnType<typeof normalizeChatMuteRecord> | null, persistence: ReturnType<typeof createIndexedDbPersistence> | null, loadPromise: Promise<void> | null, channel: BroadcastChannel | null, channelBound: boolean, subscribers: Set<(record: ReturnType<typeof normalizeChatMuteRecord>) => void> }} */
const singleton = {
  cache: null,
  persistence: null,
  loadPromise: null,
  channel: null,
  channelBound: false,
  subscribers: new Set(),
};

/**
 * @param {{ persistence?: ReturnType<typeof createIndexedDbPersistence> }} [options]
 */
function ensureStore(options = {}) {
  if (!singleton.persistence) {
    singleton.persistence = options.persistence || createIndexedDbPersistence();
  }
}

function ensureChannel() {
  if (singleton.channelBound) return;
  singleton.channelBound = true;
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    singleton.channel = new BroadcastChannel(CHAT_MUTE_CHANNEL);
    singleton.channel.addEventListener('message', (event) => {
      if (!event || !event.data || event.data.type !== 'changed') return;
      void refreshFromStorage().then(() => notifySubscribers()).catch(() => {});
    });
  } catch (_) {
    singleton.channel = null;
  }
}

function notifySubscribers() {
  const current = normalizeChatMuteRecord(singleton.cache);
  for (const listener of singleton.subscribers) {
    try {
      listener(current);
    } catch (_) {}
  }
}

/** @returns {Promise<ReturnType<typeof normalizeChatMuteRecord>>} */
async function refreshFromStorage() {
  ensureStore();
  try {
    const raw = await singleton.persistence.get(PUSH_MUTED_CHATS_KEY);
    singleton.cache = normalizeChatMuteRecord(raw);
  } catch (_) {
    if (!singleton.cache) singleton.cache = normalizeChatMuteRecord(null);
  }
  return singleton.cache;
}

/** @returns {Promise<void>} */
async function ensureLoaded() {
  ensureStore();
  ensureChannel();
  if (singleton.cache) return;
  if (singleton.loadPromise) {
    await singleton.loadPromise;
    return;
  }
  singleton.loadPromise = refreshFromStorage().then(() => undefined);
  await singleton.loadPromise;
}

/**
 * Persist only the device mute list; throttle alerts stay in memory.
 *
 * @param {string[]} muted
 * @returns {Promise<ReturnType<typeof normalizeChatMuteRecord>>}
 */
async function persistMutedList(muted) {
  const record = normalizeChatMuteRecord({
    schemaVersion: CHAT_MUTE_SCHEMA_VERSION,
    muted: Array.isArray(muted) ? muted : [],
  });
  singleton.cache = record;
  await singleton.persistence.set(PUSH_MUTED_CHATS_KEY, record);
  return record;
}

/**
 * @param {{ persistence?: ReturnType<typeof createIndexedDbPersistence> }} [options]
 */
export function createChatMuteStore(options = {}) {
  ensureStore(options);
  ensureChannel();
  return {
    async load() {
      await ensureLoaded();
      return normalizeChatMuteRecord(singleton.cache);
    },
    isMuted(chatId) {
      if (!singleton.cache) return false;
      return isChatMuted(singleton.cache, chatId);
    },
    async setMuted(chatId, muted) {
      ensureStore();
      ensureChannel();
      // Fresh read-modify-write: another tab may have muted a different chat
      // since this card loaded its copy.
      await refreshFromStorage();
      const next = setChatMuted(singleton.cache, chatId, !!muted);
      const persisted = await persistMutedList(next.muted);
      if (singleton.channel && typeof singleton.channel.postMessage === 'function') {
        try {
          singleton.channel.postMessage({ type: 'changed', chatId: String(chatId || '') });
        } catch (_) {}
      }
      notifySubscribers();
      return persisted;
    },
    listMuted() {
      if (!singleton.cache) return [];
      return singleton.cache.muted.slice();
    },
    async noteAlert(chatId, eventId, now = Date.now()) {
      await ensureLoaded();
      // Throttle state is intentionally in-memory only.
      const result = resolveChatAlertThrottle({
        record: singleton.cache,
        chatId,
        eventId,
        now,
      });
      singleton.cache = result.record;
      return result;
    },
    async saveRecord(record) {
      ensureStore();
      ensureChannel();
      const normalized = normalizeChatMuteRecord(record);
      return persistMutedList(normalized.muted);
    },
    /**
     * Subscribe to cache changes (this tab and other tabs).
     *
     * @param {(record: ReturnType<typeof normalizeChatMuteRecord>) => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      ensureChannel();
      if (typeof listener !== 'function') return () => {};
      singleton.subscribers.add(listener);
      return () => {
        singleton.subscribers.delete(listener);
      };
    },
  };
}

/** @type {ReturnType<typeof createChatMuteStore> | null} */
let defaultStore = null;

/**
 * @returns {ReturnType<typeof createChatMuteStore>}
 */
export function getChatMuteStore() {
  if (!defaultStore) defaultStore = createChatMuteStore();
  return defaultStore;
}

/** Test helper: reset singleton state. */
export function resetChatMuteStoreForTests() {
  if (singleton.channel && typeof singleton.channel.close === 'function') {
    try {
      singleton.channel.close();
    } catch (_) {}
  }
  singleton.cache = null;
  singleton.persistence = null;
  singleton.loadPromise = null;
  singleton.channel = null;
  singleton.channelBound = false;
  singleton.subscribers.clear();
  defaultStore = null;
}
