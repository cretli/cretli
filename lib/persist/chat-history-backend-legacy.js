/**
 * Legacy backend of the async history adapter: delegates every call to the
 * existing synchronous `chat-history-persist.js` code. It exists so callers can
 * be converted to the async contract (stage 2b) while the file store stays the
 * default; it adds no durability, notification or fencing semantics of its own.
 *
 * Notification note: the legacy functions bump the revision and notify inside
 * the synchronous call (before this Promise resolves). That ordering is the
 * pre-existing behaviour and is kept; only the SQLite backend moves
 * notifications after the durable receipt (`onCommitted`).
 *
 * The module is imported lazily by `createDefaultLegacyHistoryAdapter()` so the
 * neutral adapter module never depends on the legacy module (a later rename of
 * the latter cannot create a cycle).
 */
import * as persist from './chat-history-persist.js';
import { createChatHistoryAdapter } from './chat-history-adapter.js';

/**
 * Constant identity of the legacy file store. It carries no guarantee (the store ignores queue identity); it only
 * gives a browser queue a known identity to pin, so the SQLite backend (which refuses unpinned queue writes and
 * pins the real generation + epoch) rejects a queue built against the file store instead of adopting it.
 */
export const LEGACY_HISTORY_IDENTITY = Object.freeze({ datasetGeneration: 'legacy-file-store', chatEpoch: 'legacy-file-store', revision: 0 });

/** @param {any} page @returns {any} */
const withLegacyIdentity = (page) => (page && typeof page === 'object' && page.ok === true && !page.identity ? { ...page, identity: { ...LEGACY_HISTORY_IDENTITY } } : page);

/**
 * @param {typeof persist} [impl] injectable for tests
 * @returns {Record<string, Function>}
 */
export function createLegacyHistoryBackend(impl = persist) {
  return {
    loadChatHistory: async (chatId) => impl.loadChatHistory(chatId),
    appendChatHistoryEvents: async (chatId, cursorSessionId, items) => impl.appendChatHistoryEvents(chatId, cursorSessionId, items),
    appendChatNotice: async (chatId, text, meta) => impl.appendChatNotice(chatId, text, meta),
    getChatHistorySince: async (chatId, since, limit) => withLegacyIdentity(impl.getChatHistorySince(chatId, since, limit)),
    getChatHistoryEvent: async (chatId, seq) => impl.getChatHistoryEvent(chatId, seq),
    getChatHistoryPage: async (chatId, options) => withLegacyIdentity(impl.getChatHistoryPage(chatId, options)),
    copyChatHistory: async (source, target, cursor) => impl.copyChatHistory(source, target, cursor),
    copyChatHistoryUntil: async (source, target, cursor, upTo) => impl.copyChatHistoryUntil(source, target, cursor, upTo),
    deleteChatHistory: async (chatId) => impl.deleteChatHistory(chatId),
    listChatHistoryHeadSeqs: async () => impl.listChatHistoryHeadSeqs(),
    getChatHistoryUsage: async (chatId) => {
      const doc = impl.loadChatHistory(chatId);
      return doc ? { usageSummary: doc.usageSummary ?? impl.summarizeChatHistoryUsage(doc.events), headSeq: doc.headSeq, eventCount: doc.events.length, updatedAt: doc.updatedAt } : { usageSummary: impl.summarizeChatHistoryUsage([]), headSeq: 0 };
    },
  };
}

/** @returns {ReturnType<typeof createChatHistoryAdapter>} adapter over the legacy files */
export function createDefaultLegacyHistoryAdapter() {
  return createChatHistoryAdapter({ backend: createLegacyHistoryBackend(), kind: 'legacy' });
}
