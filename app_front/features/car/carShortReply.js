/**
 * Server-side read of the short spoken version (`voice_reply`) of a chat that is not open.
 * Socket frames carry `voiceReply` records only for the active chat, so car-mode announcements
 * read the history log instead: one marker is taken when a run starts (`readHeadSeq`) and the
 * reply is the newest `voiceReply` record written after it, never an older one.
 */

import { getChatHistory } from '../../core/api/index.js';
import { parseVoiceReplyPayload } from '../voice/voiceReplyMarker.js';

const REPLY_WINDOW = 60;

/**
 * @param {string} chatId
 * @param {typeof getChatHistory} [fetchHistory]
 * @returns {Promise<number|null>} newest history seq of the chat, null when unknown
 */
export async function readHeadSeq(chatId, fetchHistory = getChatHistory) {
  try {
    const res = await fetchHistory(chatId, { tail: 1 });
    return res && res.ok !== false && Number.isSafeInteger(res.headSeq) ? res.headSeq : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} chatId
 * @param {number|null} sinceSeq history seq taken before the run started
 * @param {typeof getChatHistory} [fetchHistory]
 * @returns {Promise<string>} short reply written after `sinceSeq`, '' when none (or unknown)
 */
export async function readShortReplySince(chatId, sinceSeq, fetchHistory = getChatHistory) {
  if (!Number.isSafeInteger(sinceSeq)) return '';
  try {
    const res = await fetchHistory(chatId, { tail: REPLY_WINDOW });
    const rows = res && res.ok !== false && Array.isArray(res.events) ? res.events : [];
    let best = { seq: -1, text: '' };
    for (const row of rows) {
      const seq = Number(row?.seq);
      const rec = row?.rec;
      if (!Number.isFinite(seq) || seq <= /** @type {number} */ (sinceSeq) || seq <= best.seq) continue;
      if (rec?.kind !== 'meta' || rec.variant !== 'voiceReply') continue;
      const parsed = parseVoiceReplyPayload(rec.payload);
      if (parsed) best = { seq, text: parsed.text };
    }
    return best.text;
  } catch {
    return '';
  }
}
