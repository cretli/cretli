/**
 * Durable proof that a delegation chat still represents the same harness
 * session and has received no turns since the source delegation finished.
 */

import { randomUUID } from 'node:crypto';
import { getChatByIdAsync, updateChatAsync } from './persist/chats-persist.js';
import { runChatWrite, settleChatWrites } from './chat-write-async.js';
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
 * @param {{ headSeq?: unknown } | null | undefined} [knownRevision] history revision read earlier (default: read now)
 * @returns {{ identity: string, generation: number, historyHeadSeq: number | null } | null}
 */
export function readChatSessionContinuity(chat, knownRevision = undefined) {
  const identity = String(chat?.delegationSessionIdentity || '').trim();
  if (!identity) return null;
  const revision = knownRevision !== undefined ? knownRevision : getChatHistoryRevision(String(chat?.id || '').trim());
  if (!revision || !Number.isFinite(Number(revision.headSeq))) return null;
  return {
    identity,
    generation: Math.max(0, Math.floor(Number(chat?.delegationSessionGeneration) || 0)),
    historyHeadSeq: Math.max(0, Math.floor(Number(revision.headSeq) || 0)),
  };
}

/**
 * @param {string} chatId
 * @returns {Promise<{ identity: string, generation: number, historyHeadSeq: number | null } | null>}
 */
export async function readCurrentSessionContinuity(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  // The history head is sampled at call time (callers rely on "the state before this flush"); only the chat row is awaited.
  const revision = getChatHistoryRevision(id);
  // A generation bump from a context invalidation is queued per chat: let it land before reading the row.
  await settleChatWrites(id);
  return readChatSessionContinuity(await getChatByIdAsync(id), revision);
}

/**
 * @param {{ chatId?: unknown }} event
 * @returns {void}
 */
function advancePersistedSessionGeneration(event) {
  const chatId = String(event?.chatId || '').trim();
  if (!chatId || chatId === 'unknown') return;
  // Invalidation listeners are sync: the bump is a serialized fire-and-forget write (read + increment run inside
  // one per-chat write slot, so two bursts never lose an increment). Resume fails closed when it cannot land;
  // `readCurrentSessionContinuity` waits for the queued bump.
  runChatWrite('delegationSessionGeneration', async () => {
    const chat = await getChatByIdAsync(chatId);
    if (!chat || !String(chat.delegationSessionIdentity || '').trim()) return;
    await updateChatAsync(chatId, {
      delegationSessionGeneration: Math.max(
        0,
        Math.floor(Number(chat.delegationSessionGeneration) || 0),
      ) + 1,
    });
  }, chatId);
}

onContextInvalidation(advancePersistedSessionGeneration);
