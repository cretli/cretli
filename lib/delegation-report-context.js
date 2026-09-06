/**
 * Pending delegated reports for the parent model's next turn.
 */

import { buildDelegationParentReportContext } from './delegation-prompt.js';
import { isPlanDelegationSource } from './delegation-request.js';
import {
  getDelegationById,
  listDelegationsForParent,
  updateDelegationRecord,
} from './persist/delegations-persist.js';

/**
 * @param {string} parentChatId
 * @returns {object[]}
 */
export function listUndeliveredDelegationReports(parentChatId) {
  return listDelegationsForParent(parentChatId).filter((row) => {
    if (!isPlanDelegationSource(row)) return false;
    if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cancelled' && row.status !== 'interrupted') {
      return false;
    }
    return !String(row.reportDeliveredAt || '').trim();
  });
}

/**
 * Snapshot of reports that will be placed in one outbound prompt.
 *
 * @param {string} chatId
 * @returns {{ ids: string[], text: string }}
 */
export function collectDelegationReportsForPrompt(chatId) {
  const pending = listUndeliveredDelegationReports(String(chatId || '').trim());
  if (pending.length === 0) return { ids: [], text: '' };
  return {
    ids: pending.map((row) => String(row.id || '').trim()).filter(Boolean),
    text: pending.map((row) => buildDelegationParentReportContext(row)).join('\n\n'),
  };
}

/**
 * @param {{ chatId?: string }} input
 * @returns {string}
 */
export function buildPendingDelegationReportsContext(input) {
  return collectDelegationReportsForPrompt(input?.chatId).text;
}

/**
 * Mark only the reports that were actually included in a sent prompt.
 *
 * @param {unknown} ids
 */
export function markDelegationReportsDeliveredByIds(ids) {
  const wanted = Array.isArray(ids)
    ? ids.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (wanted.length === 0) return;
  const now = new Date().toISOString();
  for (const id of wanted) {
    const row = getDelegationById(id);
    if (!row) continue;
    if (String(row.reportDeliveredAt || '').trim()) continue;
    updateDelegationRecord(row.id, {
      reportDeliveredAt: now,
      reportDeliveryId: row.reportDeliveryId || `turn:${now}`,
    });
  }
}

/**
 * Confirm the report ids captured on the room when the prompt was built.
 *
 * @param {any} room
 */
export function confirmDelegationReportsFromRoom(room) {
  const ids = Array.isArray(room?._delegationReportIdsInPrompt)
    ? room._delegationReportIdsInPrompt
    : [];
  markDelegationReportsDeliveredByIds(ids);
  if (room) room._delegationReportIdsInPrompt = [];
}

/**
 * @deprecated Use markDelegationReportsDeliveredByIds with the prompt snapshot.
 * @param {string} parentChatId
 */
export function markDelegationReportsDelivered(parentChatId) {
  const pending = listUndeliveredDelegationReports(parentChatId);
  markDelegationReportsDeliveredByIds(pending.map((row) => row.id));
}
