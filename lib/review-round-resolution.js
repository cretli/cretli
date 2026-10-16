/**
 * Resolved review rounds: a pure helper that decides when a code-review round
 * ended, plus the server-side `onReviewRoundResolved` notification point.
 *
 * Rules follow `docs/delegation-workflow-per-leaf.md` ("Opt-in reviewer pool"):
 * - a single-reviewer round resolves on a credible terminal;
 * - a pool round resolves FAIL on any member FAIL and PASS on two distinct
 *   PASS; a lone member PASS stays pending until the parent records PASS;
 * - late sibling results of a resolved round are ignored.
 *
 * Round identity is (leafId, id of the latest credible code review on the leaf),
 * not the closure epoch: both resolution paths bump the epoch.
 */

import { normalizeCodeReviewPoolRound } from './delegation-pool-round.js';
import {
  isCredibleCodeReviewTerminal,
  normalizeDelegationCodeReviewMode,
  resolveEffectiveCodeReviewReportVerdict,
} from './delegation-code-review-phase.js';
import { REVIEWER_POOL_EXPECTED_MEMBERS } from './delegation-pool-round.js';
import { readDelegationWorkflowLeafIdFromRow } from './delegation-workflow-leaf.js';

/** Bound of the in-memory identity memory (oldest entries are dropped). */
const RESOLVED_MEMORY_MAX = 512;

/** @type {Set<(leaf: ReviewRoundLeaf, round: ReviewRound) => void>} */
const subscribers = new Set();
/** Identities already notified: `${leafId}:${latestCredibleCodeReviewId}`. */
const notifiedRounds = new Set();
/** Member delegation ids of rounds closed by a parent PASS (late members are ignored). */
const closedMembers = new Set();

/**
 * @typedef {{ leafId: string, parentChatId: string, workspaceFolder: string }} ReviewRoundLeaf
 * @typedef {{
 *   id: string, leafId: string, verdict: 'PASS'|'FAIL'|'BLOCKED', memberIds: string[],
 *   source: 'single'|'pool'|'parent', resolvedAt: string,
 * }} ReviewRound
 */

/**
 * @param {Set<string>} set
 * @param {string} value
 */
function rememberBounded(set, value) {
  set.add(value);
  while (set.size > RESOLVED_MEMORY_MAX) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

/** @returns {void} Test helper: forgets subscribers and identity memory. */
export function resetReviewRoundResolutionState() {
  subscribers.clear();
  notifiedRounds.clear();
  closedMembers.clear();
}

/**
 * @param {(leaf: ReviewRoundLeaf, round: ReviewRound) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeReviewRoundResolved(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/**
 * Server-side notification point. Fires every subscriber once per round
 * identity; a subscriber error never breaks the caller.
 *
 * @param {ReviewRoundLeaf} leaf
 * @param {ReviewRound} round
 * @returns {boolean} true when the round was newly announced
 */
export function onReviewRoundResolved(leaf, round) {
  const identity = `${round.leafId}:${round.id}`;
  if (notifiedRounds.has(identity)) return false;
  rememberBounded(notifiedRounds, identity);
  for (const id of round.memberIds) rememberBounded(closedMembers, id);
  for (const listener of subscribers) {
    try {
      listener(leaf, round);
    } catch {
      // Subscribers must not break delegation finalization or workflow writes.
    }
  }
  return true;
}

/**
 * @param {object | null | undefined} row
 * @returns {number}
 */
function readFinishedMs(row) {
  const at = Date.parse(String(row?.finishedAt || row?.updatedAt || row?.createdAt || ''));
  return Number.isFinite(at) ? at : 0;
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
function isReviewRow(row) {
  return String(row?.assignment || '').trim() === 'review';
}

/**
 * Credible terminal reviews (code and plan) of one leaf, oldest first.
 *
 * @param {object[]} delegations
 * @param {string} leafId
 * @returns {object[]}
 */
export function listCredibleReviewsForLeaf(delegations, leafId) {
  const wanted = String(leafId || '').trim().toLowerCase();
  if (!wanted) return [];
  return (Array.isArray(delegations) ? delegations : [])
    .filter((row) => isReviewRow(row)
      && readDelegationWorkflowLeafIdFromRow(row).toLowerCase() === wanted
      && isCredibleCodeReviewTerminal(row))
    .sort((a, b) => readFinishedMs(a) - readFinishedMs(b)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
function isCodeReviewRow(row) {
  return String(row?.reviewSubject || '').trim() === 'code';
}

/**
 * Pure: resolved code-review rounds of one leaf, oldest first.
 *
 * Pool members (from the workflow row's `codeReviewPoolRound`) are grouped into
 * one round; every other credible code review is its own single-reviewer
 * round. A pool group with one PASS and no FAIL is pending, not a round.
 *
 * @param {{ delegations: object[], leafId: string, workflow?: object | null }} input
 * @returns {{ rounds: ReviewRound[], pending: { memberIds: string[] } | null }}
 */
export function resolveReviewRounds(input) {
  const leafId = String(input?.leafId || '').trim().toLowerCase();
  const reviews = listCredibleReviewsForLeaf(input?.delegations, leafId).filter(isCodeReviewRow);
  const record = normalizeCodeReviewPoolRound(input?.workflow?.codeReviewPoolRound);
  const poolIds = new Set(record && record.pool !== false ? record.started : []);
  /** @type {ReviewRound[]} */
  const rounds = [];
  /** @type {{ id: string, verdict: string }[]} */
  let group = [];
  const flushPool = () => {
    if (!group.length) return;
    const failed = group.some((member) => member.verdict !== 'PASS');
    const passes = group.filter((member) => member.verdict === 'PASS').length;
    if (failed || passes >= REVIEWER_POOL_EXPECTED_MEMBERS) {
      const last = group[group.length - 1];
      const failVerdict = group.find((member) => member.verdict !== 'PASS')?.verdict;
      rounds.push({
        id: last.id,
        leafId,
        verdict: /** @type {ReviewRound['verdict']} */ (failed ? (failVerdict || 'FAIL') : 'PASS'),
        memberIds: group.map((member) => member.id),
        source: 'pool',
        resolvedAt: String(reviews.find((row) => row.id === last.id)?.finishedAt || ''),
      });
      group = [];
    }
  };
  for (const row of reviews) {
    const verdict = String(resolveEffectiveCodeReviewReportVerdict(row)).toUpperCase();
    if (poolIds.has(String(row.id))) {
      group.push({ id: String(row.id), verdict });
      flushPool();
      continue;
    }
    rounds.push({
      id: String(row.id),
      leafId,
      verdict: /** @type {ReviewRound['verdict']} */ (verdict === 'PASS' || verdict === 'BLOCKED' ? verdict : 'FAIL'),
      memberIds: [String(row.id)],
      source: 'single',
      resolvedAt: String(row.finishedAt || ''),
    });
  }
  return { rounds, pending: group.length ? { memberIds: group.map((member) => member.id) } : null };
}

/**
 * Finish-hook evaluation (path 1). Called with the workflow row and the patch
 * `buildCodeReviewWorkflowPatchOnFinish` produced from it (both pre-apply).
 *
 * @param {{
 *   delegation: object,
 *   workflow?: object | null,
 *   patch?: Record<string, unknown> | null,
 *   delegations: object[],
 * }} input
 * @returns {ReviewRound | null} the resolved round, or null (pending / ignored)
 */
export function evaluateReviewRoundOnFinish(input) {
  const delegation = input?.delegation;
  if (!delegation || !isCodeReviewRow(delegation) || !isReviewRow(delegation)) return null;
  if (!isCredibleCodeReviewTerminal(delegation)) return null;
  const leafId = readDelegationWorkflowLeafIdFromRow(delegation).toLowerCase();
  if (!leafId) return null;
  const id = String(delegation.id || '').trim();
  if (!id || closedMembers.has(id)) return null;
  const verdict = String(resolveEffectiveCodeReviewReportVerdict(delegation)).toUpperCase();
  const mode = normalizeDelegationCodeReviewMode(delegation.reviewMode);
  const patchPool = normalizeCodeReviewPoolRound(input.patch?.codeReviewPoolRound);
  const preRecord = normalizeCodeReviewPoolRound(input.workflow?.codeReviewPoolRound);
  const wasPoolMember = Boolean(preRecord && preRecord.started.includes(id));
  if (wasPoolMember) {
    // Late sibling of an already resolved round, or a still pending pool round.
    if (!patchPool || !patchPool.resolved || preRecord?.resolved) return null;
    return {
      id,
      leafId,
      verdict: /** @type {ReviewRound['verdict']} */ (patchPool.resolved === 'PASS' ? 'PASS' : 'FAIL'),
      memberIds: Object.keys(patchPool.results),
      source: 'pool',
      resolvedAt: String(delegation.finishedAt || ''),
    };
  }
  // Phase on: a null patch means a fan-out replay of an already counted round.
  if (mode && !input.patch) return null;
  return {
    id,
    leafId,
    verdict: /** @type {ReviewRound['verdict']} */ (verdict === 'PASS' || verdict === 'BLOCKED' ? verdict : 'FAIL'),
    memberIds: [id],
    source: 'single',
    resolvedAt: String(delegation.finishedAt || ''),
  };
}

/**
 * Parent `workflow_update` evaluation (path 2). Must be computed from state
 * read before the patch (PASS clears `codeReviewPoolRound`).
 *
 * @param {{
 *   workflowBefore?: object | null,
 *   delegations: object[],
 *   leafId: string,
 *   lastVerdict?: unknown,
 *   replayed?: boolean,
 * }} input
 * @returns {ReviewRound | null}
 */
export function evaluateReviewRoundOnParentUpdate(input) {
  if (input?.replayed === true) return null;
  if (String(input?.lastVerdict || '').trim().toUpperCase() !== 'PASS') return null;
  const leafId = String(input?.leafId || '').trim().toLowerCase();
  const reviews = listCredibleReviewsForLeaf(input?.delegations, leafId);
  const latest = reviews[reviews.length - 1];
  // A parent PASS closes the latest review round; a plan PASS is not a code round.
  if (!latest || !isCodeReviewRow(latest)) return null;
  const record = normalizeCodeReviewPoolRound(input?.workflowBefore?.codeReviewPoolRound);
  const memberIds = record ? [...new Set([...record.started, String(latest.id)])] : [String(latest.id)];
  return {
    id: String(latest.id),
    leafId,
    verdict: 'PASS',
    memberIds,
    source: 'parent',
    resolvedAt: new Date().toISOString(),
  };
}
