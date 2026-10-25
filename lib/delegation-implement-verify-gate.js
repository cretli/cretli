/**
 * Block code review starts while the latest implement/fix on a leaf still has a
 * failed host verify for the same material revision.
 */

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

import { readDelegationMaterialRevisionForRecord } from './delegation-material-revision.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { listDelegationsForController } from './persist/delegations-persist.js';

import { isAutoVerifyChainInFlight } from './auto-verify-inflight.js';
import { isReviewVerifyInFlight } from './sdk/sdk-review-verify.ts';
import { isImplementationWorkDelegationRow } from './delegation-work-role.js';

export const DELEGATION_VERIFY_FAILED_BEFORE_REVIEW = 'verify_failed_before_review';
export const DELEGATION_VERIFY_PENDING_BEFORE_REVIEW = 'verify_pending';

/** A marker older than this without a live run is treated as orphaned. */
export const VERIFY_PENDING_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * @param {Record<string, any>} latest implement/fix record
 * @returns {boolean}
 */
function isAutoVerifyStillPending(latest) {
  const pending = latest?.verifyPending;
  if (!pending?.since) return false;
  const root = String(latest.executionFolder || latest.workspaceFolder || '').trim();
  if (root && isAutoVerifyChainInFlight({ delegationId: latest.id, projectRoot: root, materialRevision: pending.revision })) return true;
  if (root && isReviewVerifyInFlight({ projectRoot: root, materialRevision: pending.revision })) return true;
  const since = Date.parse(pending.since);
  return Number.isFinite(since) && Date.now() - since < VERIFY_PENDING_MAX_AGE_MS;
}

/**
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
export function isImplementOrFixDelegationRow(row) {
  return isImplementationWorkDelegationRow(row);
}

/**
 * @param {string} parentChatId
 * @param {string} leafId
 * @returns {Record<string, any> | null}
 */
export function findLatestTerminalImplementFixForLeaf(parentChatId, leafId) {
  const parent = String(parentChatId || '').trim();
  const leaf = String(leafId || '').trim();
  if (!parent) return null;
  /** @type {object[]} */
  const matches = listDelegationsForController(parent).filter((/** @type {Record<string, any>} */ row) => {
    if (!isTerminalDelegationStatus(row.status)) return false;
    if (!isImplementOrFixDelegationRow(row)) return false;
    if (leaf && String(row.leafId || '').trim() !== leaf) return false;
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((/** @type {Record<string, any>} */ a, /** @type {Record<string, any>} */ b) => {
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
 *   [key: string]: any,
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
  if (latest && isAutoVerifyStillPending(latest)) {
    return {
      ok: false,
      status: 409,
      code: DELEGATION_VERIFY_PENDING_BEFORE_REVIEW,
      retryable: true,
      error: 'Automatic host verify after the latest implement/fix is still running. Poll delegation_show (verify_running) and retry the review start.',
    };
  }
  if (!latest?.verifyResult) return { ok: true };
  if (latest.verifyResult.stale === true) return { ok: true };
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

/** Longest a review start blocks on an in-flight host verify; stays under the ~30s MCP bridge HTTP timeout (override: CRETLI_REVIEW_VERIFY_WAIT_MS). */
export const VERIFY_WAIT_DEFAULT_MS = 25 * 1000;
const VERIFY_WAIT_POLL_MS = 1000;

/**
 * Like {@link inspectImplementVerifyBeforeReview}, but while the only blocker is
 * a host verify that is still running it waits for that verify to finish
 * (bounded) and re-inspects, instead of failing the review start with a 409
 * that makes the orchestrator report `blocked`. After the budget the original
 * retryable `verify_pending` result is returned.
 *
 * @param {Parameters<typeof inspectImplementVerifyBeforeReview>[0]} input
 * @param {{ maxWaitMs?: number, pollMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<ReturnType<typeof inspectImplementVerifyBeforeReview>>}
 */
export async function waitForImplementVerifyBeforeReview(input = {}, options = {}) {
  const envMs = Number.parseInt(String(process.env.CRETLI_REVIEW_VERIFY_WAIT_MS || ''), 10);
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? Number(options.maxWaitMs) : (Number.isFinite(envMs) && envMs >= 0 ? envMs : VERIFY_WAIT_DEFAULT_MS);
  const pollMs = Math.max(10, Number(options.pollMs) || VERIFY_WAIT_POLL_MS);
  const deadline = Date.now() + maxWaitMs;
  let gate = inspectImplementVerifyBeforeReview(input);
  while (!gate.ok && 'code' in gate && gate.code === DELEGATION_VERIFY_PENDING_BEFORE_REVIEW && Date.now() < deadline) {
    if (options.signal?.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    gate = inspectImplementVerifyBeforeReview(input);
  }
  return gate;
}
