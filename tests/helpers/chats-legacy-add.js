import { addChat as addLegacyChat } from '../../lib/persist/chats-legacy-store.js';
import { noteChatRowsForRunIndex } from '../../lib/chat-row-index.js';

/** Legacy synchronous `addChat` that also indexes the row, as the facade does for the sync run probes. */
export const addChat = (...args) => noteChatRowsForRunIndex(addLegacyChat(...args));
