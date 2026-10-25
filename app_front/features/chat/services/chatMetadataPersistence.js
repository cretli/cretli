/**
 * Chat metadata persistence installation.
 */
import {
  getChatActivityStore,
  installChatActivityStore,
  setChatActivityPersistenceSink,
  subscribeChatActivity,
} from '../chatActivityStore.js';
import { getChatBootListHydrationController } from '../chatLocalBootAsyncHydrate.js';
import { migrateLegacyLocalBootCacheToIdb } from '../chatLocalBootLegacyMigration.js';
import { installChatMetadataCrossTabSync } from '../chatMetadataCrossTab.js';
import { getChatMetadataIdbOperationEpoch, setChatMetadataIdbSessionScope } from '../chatMetadataIdb.js';
import { createChatMetadataIdbPersistenceAdapter } from '../chatPersistenceIdbAdapter.js';
import {
  getChatPersistenceQueue,
  installChatPersistenceQueue,
  invalidateChatPersistenceQueue,
} from '../chatPersistenceQueue.js';
import { chatShell } from '../state/chatShellState.js';

/**
 * Install the chat metadata persistence (IDB adapter, queue, cross-tab sync).
 * @param {{ getChatController: () => any }} deps
 * @returns {any} the persistence adapter
 */
export function installChatMetadataPersistence({ getChatController }) {
  const chatMetadataPersistenceAdapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => getChatActivityStore().getSession(),
  });
  installChatActivityStore({ adapter: chatMetadataPersistenceAdapter });
  installChatPersistenceQueue({
    adapter: chatMetadataPersistenceAdapter,
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getSession: () => getChatActivityStore().getSession(),
    getBootCacheInput: () => getChatController().getBootCachePersistInput?.() || null,
    getActivitySnapshots: () => {
      const store = getChatActivityStore();
      return {
        activity: store.snapshotActivity(),
        lastUsed: store.snapshotLastUsed(),
      };
    },
    onDurableFlush: (detail) => {
      chatShell.chatMetadataCrossTabSync?.publishFlush(detail);
    },
  });
  chatShell.chatMetadataCrossTabSync = installChatMetadataCrossTabSync({
    getSession: () => getChatActivityStore().getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getAdapter: () => chatMetadataPersistenceAdapter,
    getActivityStore: () => getChatActivityStore(),
    getBootRevision: () => getChatPersistenceQueue()?.getBootRevision?.() || '',
    onBootRevision: () => {
      getChatController().applyPeerBootCacheRevision?.();
    },
  });
  chatShell.chatMetadataCrossTabSync.installStorageListener();
  setChatActivityPersistenceSink((detail) => {
    getChatPersistenceQueue()?.markActivityDirty(detail);
  });
  subscribeChatActivity((event) => {
    if (event?.type === 'reset') {
      getChatBootListHydrationController().cancel();
      invalidateChatPersistenceQueue({ clearBootRevision: true });
      if (event.sessionId) {
        setChatMetadataIdbSessionScope({
          sessionId: String(event.sessionId),
          generation: Number(event.generation) || 1,
        });
      }
    }
  });
  setChatMetadataIdbSessionScope(getChatActivityStore().peekSessionScope());
  void chatMetadataPersistenceAdapter.ensurePrime().then(async () => {
    const session = getChatActivityStore().getSession();
    setChatMetadataIdbSessionScope(session);
    getChatBootListHydrationController().setSessionScope(session);
    getChatBootListHydrationController().setIdbEpoch(getChatMetadataIdbOperationEpoch());
    await migrateLegacyLocalBootCacheToIdb({
      adapter: chatMetadataPersistenceAdapter,
      getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    });
    void chatMetadataPersistenceAdapter.persistPendingSessionMarker({
      epoch: getChatMetadataIdbOperationEpoch(),
    });
  }).catch(() => {});
  getChatPersistenceQueue()?.installLifecycleFlushHooks();
  return chatMetadataPersistenceAdapter;
}
