/**
 * Lightweight in-memory revision index for chat history files.
 * Used by cross-device pull sync (GET /api/chats/history-revisions).
 */

/** @type {Map<string, { headSeq: number, updatedAt: string, revision: number }>} */
const revisionsByChatId = new Map();
/** @type {Set<string>} */
const pendingDelegationChatIds = new Set();

/**
 * @param {string} chatId
 */
export function markChatHasPendingDelegation(chatId) {
  const id = String(chatId || '').trim();
  if (id) pendingDelegationChatIds.add(id);
}

/**
 * @param {string} chatId
 */
export function clearChatHasPendingDelegation(chatId) {
  const id = String(chatId || '').trim();
  if (id) pendingDelegationChatIds.delete(id);
}

/**
 * @param {string} chatId
 * @returns {boolean}
 */
export function chatHasPendingDelegation(chatId) {
  return pendingDelegationChatIds.has(String(chatId || '').trim());
}

/**
 * @param {string} chatId
 * @param {number} headSeq
 * @returns {{ headSeq: number, updatedAt: string, revision: number }}
 */
export function bumpChatHistoryRevision(chatId, headSeq) {
  const safeHeadSeq = Number.isFinite(headSeq) ? Math.max(0, Math.floor(headSeq)) : 0;
  const previous = revisionsByChatId.get(chatId);
  const revision = (previous?.revision || 0) + 1;
  const entry = {
    headSeq: safeHeadSeq,
    updatedAt: new Date().toISOString(),
    revision,
  };
  revisionsByChatId.set(chatId, entry);
  return entry;
}

/**
 * @param {string} chatId
 * @returns {{ headSeq: number, updatedAt: string, revision: number } | null}
 */
export function getChatHistoryRevision(chatId) {
  if (!chatId) return null;
  return revisionsByChatId.get(chatId) || null;
}

/**
 * @param {string[] | undefined} chatIds
 * @returns {Record<string, { headSeq: number, updatedAt: string, revision: number }>}
 */
export function getChatHistoryRevisions(chatIds) {
  if (!Array.isArray(chatIds) || chatIds.length === 0) {
    return Object.fromEntries(
      [...revisionsByChatId.entries()].map(([id, entry]) => [
        id,
        { ...entry, hasPendingDelegation: pendingDelegationChatIds.has(id) },
      ]),
    );
  }
  const out = {};
  for (const chatId of chatIds) {
    if (!chatId || typeof chatId !== 'string') continue;
    const entry = revisionsByChatId.get(chatId);
    if (entry) {
      out[chatId] = {
        ...entry,
        hasPendingDelegation: pendingDelegationChatIds.has(chatId),
      };
    }
  }
  return out;
}

/**
 * @param {string} chatId
 */
export function clearChatHistoryRevision(chatId) {
  if (!chatId) return;
  revisionsByChatId.delete(chatId);
}

/**
 * Seeds revision from disk without bumping revision counter when already up to date.
 *
 * @param {string} chatId
 * @param {number} headSeq
 * @param {string} [updatedAt]
 * @returns {{ headSeq: number, updatedAt: string, revision: number }}
 */
export function seedChatHistoryRevision(chatId, headSeq, updatedAt = '') {
  const safeHeadSeq = Number.isFinite(headSeq) ? Math.max(0, Math.floor(headSeq)) : 0;
  const existing = revisionsByChatId.get(chatId);
  if (existing && existing.headSeq >= safeHeadSeq) {
    return existing;
  }
  const entry = {
    headSeq: safeHeadSeq,
    updatedAt: updatedAt || new Date().toISOString(),
    revision: existing?.revision || 1,
  };
  revisionsByChatId.set(chatId, entry);
  return entry;
}

/**
 * @param {Record<string, { headSeq?: number, updatedAt?: string }>} index
 * @returns {number}
 */
export function seedChatHistoryRevisionsFromIndex(index) {
  if (!index || typeof index !== 'object') return 0;
  let seeded = 0;
  for (const [chatId, meta] of Object.entries(index)) {
    if (!chatId || !meta || typeof meta !== 'object') continue;
    const headSeq = Number(meta.headSeq);
    if (!Number.isFinite(headSeq)) continue;
    seedChatHistoryRevision(chatId, headSeq, typeof meta.updatedAt === 'string' ? meta.updatedAt : '');
    seeded += 1;
  }
  return seeded;
}
