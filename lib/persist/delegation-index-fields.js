/**
 * Lookup keys derived from a delegation row. The JSON store builds its
 * in-memory indexes from them and the SQLite store persists them as indexed
 * columns, so both backends answer the same accessor with the same rows.
 */

import { resolveRecordTreeFields } from '../delegation-tree.js';
import { isActiveDelegationStatus, isCancelUnconfirmedDelegationSlot } from '../delegation-status.js';
import { normalizeDelegationWorkspaceKey } from '../delegation-workspace-key.js';
import { delegationController } from '../delegation-control.js';
import { normalizeWorkspaceFolder } from './workspace-watchers-persist.js';

/**
 * Same key the watcher uses to match a delegation to a workspace folder. It
 * resolves symlinks, so it depends on the filesystem at read time and is never
 * stored; the SQLite reader computes it per distinct stored folder instead.
 *
 * @param {unknown} folder
 * @returns {string}
 */
export function workspaceIndexKey(folder) {
  const canonical = normalizeDelegationWorkspaceKey(folder);
  if (!canonical) return normalizeWorkspaceFolder(folder);
  return normalizeWorkspaceFolder(canonical);
}

/**
 * Rows the runtime tick still has to visit: an active status, a stop marker
 * that may still hold the parent slot, or an undelivered outbox item.
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isTickRelevantDelegation(row) {
  if (isActiveDelegationStatus(row?.status)) return true;
  if (isCancelUnconfirmedDelegationSlot(row)) return true;
  if (String(row?.runStoppingAt || '').trim()) return true;
  return Array.isArray(row?.outbox) && row.outbox.some((item) => !String(item?.deliveredAt || '').trim());
}

/**
 * Keys that depend only on the row, so they can be stored with it.
 *
 * @param {object} row
 * @returns {{ controllerChatId: string, rootChatId: string, rootDelegationId: string, tickRelevant: boolean }}
 */
export function computeDelegationIndexFields(row) {
  const tree = resolveRecordTreeFields(row);
  return {
    controllerChatId: delegationController(row),
    rootChatId: tree.rootChatId,
    rootDelegationId: tree.rootDelegationId,
    tickRelevant: isTickRelevantDelegation(row),
  };
}
