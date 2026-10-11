/**
 * Delegation tree identity helpers shared by the width, write-lock and global
 * gates. Pure logic: a "tree" is every delegation row sharing one
 * `rootDelegationId`; legacy rows without tree fields are their own tree.
 */

import { resolveRecordTreeFields } from './delegation-tree.js';

/**
 * @param {object | null | undefined} row
 * @returns {string} Tree root delegation id, '' for a missing row.
 */
export function delegationTreeRootId(row) {
  if (!row || typeof row !== 'object') return '';
  return resolveRecordTreeFields(row).rootDelegationId;
}

/**
 * @param {object | null | undefined} row
 * @param {unknown} rootDelegationId
 * @returns {boolean}
 */
export function isRowInDelegationTree(row, rootDelegationId) {
  const root = String(rootDelegationId || '').trim();
  if (!root) return false;
  return delegationTreeRootId(row) === root;
}

/**
 * Root of the tree an incoming job joins. A job started by a root chat opens a
 * new tree (its own id, unknown yet), so there is nothing to share and '' is
 * returned; a job started by a delegation child chat joins that chat's tree.
 * A resumed/retried/queued row keeps the tree recorded on the row itself.
 *
 * @param {{ parent?: object | null, existing?: object | null }} input
 * @returns {string}
 */
export function resolveIncomingTreeRootId(input = {}) {
  if (input.existing) return delegationTreeRootId(input.existing);
  const parent = input.parent;
  if (!parent || !String(parent.delegationParentChatId || '').trim()) return '';
  return String(parent.delegationRootDelegationId || '').trim();
}
