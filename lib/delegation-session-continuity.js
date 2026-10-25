/**
 * Durable proof that a delegation chat still represents the same harness
 * session and has received no turns since the source delegation finished.
 */

import { randomUUID } from 'node:crypto';
import { loadChats, updateChat } from './persist/chats-persist.js';
import { getChatHistoryRevision } from './persist/chat-history-revisions.js';
import { onContextInvalidation } from './usage/context-restarts.ts';
export { normalizeSessionContinuity } from './delegation-session-continuity-normalize.js';

/**
 * @returns {{ identity: string, generation: number, historyHeadSeq: number | null }}
 */
export function createSessionContinuity() {
  return { identity: randomUUID(), generation: 0, historyHeadSeq: 0 };
}

/**
 * Read the persisted session identity together with the live history head.
 * A missing revision is deliberately unknown: after startup the history
 * runtime seeds this index from durable storage before delegations may start.
 *
 * @param {Record<string, any> | null | undefined} chat
 * @returns {{ identity: string, generation: number, historyHeadSeq: number | null } | null}
 */
export function readChatSessionContinuity(chat) {
  const identity = String(chat?.delegationSessionIdentity || '').trim();
  if (!identity) return null;
  const revision = getChatHistoryRevision(String(chat?.id || '').trim());
  if (!revision || !Number.isFinite(Number(revision.headSeq))) return null;
  return {
    identity,
    generation: Math.max(0, Math.floor(Number(chat?.delegationSessionGeneration) || 0)),
    historyHeadSeq: Math.max(0, Math.floor(Number(revision.headSeq) || 0)),
  };
}

/**
 * @param {string} chatId
 * @returns {{ identity: string, generation: number, historyHeadSeq: number | null } | null}
 */
export function readCurrentSessionContinuity(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return readChatSessionContinuity(loadChats().find((chat) => chat.id === id));
}

/**
 * @param {{ chatId?: unknown }} event
 * @returns {void}
 */
function advancePersistedSessionGeneration(event) {
  const chatId = String(event?.chatId || '').trim();
  if (!chatId || chatId === 'unknown') return;
  try {
    const chat = loadChats().find((row) => row.id === chatId);
    if (!chat || !String(chat.delegationSessionIdentity || '').trim()) return;
    updateChat(chatId, {
      delegationSessionGeneration: Math.max(
        0,
        Math.floor(Number(chat.delegationSessionGeneration) || 0),
      ) + 1,
    });
  } catch {
    // Resume fails closed when the durable generation cannot be advanced.
  }
}

onContextInvalidation(advancePersistedSessionGeneration);
