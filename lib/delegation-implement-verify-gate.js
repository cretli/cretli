/**
 * Block code review starts while the latest implement/fix on a leaf still has a
 * failed host verify for the same material revision.
 */

import { readDelegationMaterialRevisionForRecord } from './delegation-material-revision.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { listDelegationsForController } from './persist/delegations-persist.js';

export const DELEGATION_VERIFY_FAILED_BEFORE_REVIEW = 'verify_failed_before_review';

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isImplementOrFixDelegationRow(row) {
  const pickRole = String(row?.pickRole || '').trim().toLowerCase();
  if (pickRole === 'fix') return true;
  const assignment = String(row?.assignment || '').trim().toLowerCase();
  return assignment === 'implement' || assignment === 'fix';
}

/**
 * @param {string} parentChatId
 * @param {string} leafId
 * @returns {object | null}
 */
export function findLatestTerminalImplementFixForLeaf(parentChatId, leafId) {
  const parent = String(parentChatId || '').trim();
  const leaf = String(leafId || '').trim();
  if (!parent) return null;
  /** @type {object[]} */
  const matches = listDelegationsForController(parent).filter((row) => {
    if (!isTerminalDelegationStatus(row.status)) return false;
    if (!isImplementOrFixDelegationRow(row)) return false;
    if (leaf && String(row.leafId || '').trim() !== leaf) return false;
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const aAt = Date.parse(String(a.finishedAt || a.lastTransitionAt || a.createdAt || ''));
    const bAt = Date.parse(String(b.finishedAt || b.lastTransitionAt || b.createdAt || ''));
    return (Number.isFinite(bAt) ? bAt : 0) - (Number.isFinite(aAt) ? aAt : 0);
  });
  return matches[0] || null;
}

/**
 * @param {{
 *   parentChatId?: unknown,
 *   assignment?: unknown,
 *   executionMode?: unknown,
 *   reviewSubject?: unknown,
 *   leafId?: unknown,
 *   allowVerifyFailedReview?: unknown,
 * }} input
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
 */
export function inspectImplementVerifyBeforeReview(input = {}) {
  if (input.allowVerifyFailedReview === true) return { ok: true };
  const assignment = String(input.assignment || '').trim().toLowerCase();
  if (assignment !== 'review') return { ok: true };
  const executionMode = String(input.executionMode || '').trim().toLowerCase();
  if (executionMode === 'plan') return { ok: true };
  const subject = String(input.reviewSubject || '').trim().toLowerCase();
  if (subject !== 'code') return { ok: true };
  const parentChatId = String(input.parentChatId || '').trim();
  const leafId = String(input.leafId || '').trim();
  if (!parentChatId || !leafId) return { ok: true };
  const latest = findLatestTerminalImplementFixForLeaf(parentChatId, leafId);
  if (!latest?.verifyResult) return { ok: true };
  const verifyStatus = String(latest.verifyResult.status || '').trim().toLowerCase();
  if (verifyStatus !== 'failed') return { ok: true };
  const currentMaterial = readDelegationMaterialRevisionForRecord(latest);
  const verifiedMaterial = String(latest.verifyResult.materialRevision || '').trim();
  if (verifiedMaterial && currentMaterial && verifiedMaterial !== currentMaterial) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 409,
    code: DELEGATION_VERIFY_FAILED_BEFORE_REVIEW,
    error: 'Latest implement/fix on this leaf has a failed host verify for the current material. Run delegation_verify after fixes pass, or pass allow_verify_failed_review=true to override.',
  };
}
