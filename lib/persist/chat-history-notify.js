/**
 * Optional web push notifications when server-side chat history changes.
 * Enabled with CRETLI_PUSH_HISTORY=1 (pull-based sync remains primary).
 */

import { broadcastPush, isPushAvailable } from '../push.js';
import { readEnvAlias } from '../env-alias.js';

const PUSH_HISTORY_ENABLED = readEnvAlias({ current: 'CRETLI_PUSH_HISTORY', legacy: 'CURSOR_REMOTE_PUSH_HISTORY' }) === '1';

/**
 * @param {string} chatId
 * @param {number} headSeq
 */
export async function notifyChatHistoryUpdated(chatId, headSeq) {
  if (!PUSH_HISTORY_ENABLED || !chatId) return;
  if (!isPushAvailable()) return;
  // Imported lazily: chats-persist depends on chat-history-persist, which pulls
  // in this module — a static import would close that cycle.
  const { loadChats } = await import('./chats-persist.js');
  const chat = loadChats().find((entry) => entry?.id === chatId) || null;
  const title = chat?.title?.trim() || 'Cretli';
  const safeHeadSeq = Number.isFinite(headSeq) ? Math.max(0, Math.floor(headSeq)) : 0;
  await broadcastPush({
    title,
    body: 'New chat activity — open to sync.',
    tag: `chat-history-${chatId}`,
    data: {
      type: 'chat-history',
      chatId,
      headSeq: safeHeadSeq,
    },
  });
}
