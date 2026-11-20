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

import {
  codeReviewPoolRoundSignature,
  normalizeCodeReviewPoolHistory,
  normalizeCodeReviewPoolRound,
} from './delegation-pool-round.js';
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
    set.delete(/** @type {any} */ (oldest));
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
 * @param {any | null | undefined} row
 * @returns {number}
 */
function readFinishedMs(row) {
  const at = Date.parse(String(row?.finishedAt || row?.updatedAt || row?.createdAt || ''));
  return Number.isFinite(at) ? at : 0;
}

/**
 * @param {any | null | undefined} row
 * @returns {boolean}
 */
function isReviewRow(row) {
  return String(row?.assignment || '').trim() === 'review';
}

/**
 * Credible terminal reviews (code and plan) of one leaf, oldest first.
 *
 * @param {any[]} delegations
 * @param {string} leafId
 * @returns {any[]}
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
 * Groups rows by lower-cased workflow leaf id in one pass (input order kept
 * inside each group), so per-leaf lookups stop rescanning every delegation.
 * Rows without a leaf id are dropped.
 *
 * @param {any[]} delegations
 * @returns {Map<string, any[]>}
 */
export function indexDelegationsByLeaf(delegations) {
  /** @type {Map<string, any[]>} */
  const byLeaf = new Map();
  for (const row of Array.isArray(delegations) ? delegations : []) {
    const leaf = readDelegationWorkflowLeafIdFromRow(row).toLowerCase();
    if (!leaf) continue;
    const list = byLeaf.get(leaf);
    if (list) list.push(row);
    else byLeaf.set(leaf, [row]);
  }
  return byLeaf;
}

/**
 * @param {any | null | undefined} row
 * @returns {boolean}
 */
function isCodeReviewRow(row) {
  return String(row?.reviewSubject || '').trim() === 'code';
}

/**
 * Oldest-first pool rounds of a workflow row: the archived history plus the
 * live current record. When a signature collides, the live record wins.
 *
 * @param {unknown} historyRaw
 * @param {ReturnType<typeof normalizeCodeReviewPoolRound>} currentRecord
 * @returns {NonNullable<ReturnType<typeof normalizeCodeReviewPoolRound>>[]}
 */
function orderedCodeReviewPoolRounds(historyRaw, currentRecord) {
  /** @type {NonNullable<ReturnType<typeof normalizeCodeReviewPoolRound>>[]} */
  const records = [];
  const seen = new Set();
  for (const record of normalizeCodeReviewPoolHistory(historyRaw)) {
    const signature = codeReviewPoolRoundSignature(record);
    if (seen.has(signature)) continue;
    seen.add(signature);
    records.push(record);
  }
  if (currentRecord) {
    const signature = codeReviewPoolRoundSignature(currentRecord);
    const index = records.findIndex((record) => codeReviewPoolRoundSignature(record) === signature);
    if (index >= 0) records[index] = currentRecord;
    else records.push(currentRecord);
  }
  return records;
}

/**
 * Verdict a pool group resolves to, or `null` while it is still pending. Any
 * member non-PASS fails the round; two PASS members (or a record the parent
 * already resolved PASS) approve it.
 *
 * @param {NonNullable<ReturnType<typeof normalizeCodeReviewPoolRound>>} record
 * @param {{ id: string, verdict: string }[]} members
 * @returns {ReviewRound['verdict'] | null}
 */
function resolvePoolGroupVerdict(record, members) {
  const failing = members.find((member) => member.verdict !== 'PASS');
  if (failing) return /** @type {ReviewRound['verdict']} */ (failing.verdict || 'FAIL');
  if (record.resolved === 'PASS') return 'PASS';
  const passes = members.filter((member) => member.verdict === 'PASS').length;
  if (passes >= REVIEWER_POOL_EXPECTED_MEMBERS) return 'PASS';
  return null;
}

/**
 * Pure: resolved code-review rounds of one leaf, oldest first.
 *
 * Reviews are grouped by the pool round they belong to, using the union of the
 * workflow row's durable `codeReviewPoolHistory` and its live
 * `codeReviewPoolRound`. A pool group with one PASS and no FAIL is pending, not
 * a round; only the live, unresolved round is reported as `pending`. Every other
 * credible code review is its own single-reviewer round.
 *
 * `leafDelegations` is an optional pre-indexed subset (rows of this leaf from
 * `indexDelegationsByLeaf`); the result is identical to scanning `delegations`.
 *
 * @param {{ delegations: any[], leafId: string, workflow?: any | null, leafDelegations?: any[] }} input
 * @returns {{ rounds: ReviewRound[], pending: { memberIds: string[] } | null }}
 */
export function resolveReviewRounds(input) {
  const leafId = String(input?.leafId || '').trim().toLowerCase();
  const reviews = listCredibleReviewsForLeaf(input?.leafDelegations || input?.delegations, leafId).filter(isCodeReviewRow);
  const currentRecord = normalizeCodeReviewPoolRound(input?.workflow?.codeReviewPoolRound);
  /** @type {Map<string, NonNullable<ReturnType<typeof normalizeCodeReviewPoolRound>>>} */
  const roundByMember = new Map();
  for (const record of orderedCodeReviewPoolRounds(input?.workflow?.codeReviewPoolHistory, currentRecord)) {
    for (const id of record.started) roundByMember.set(String(id), record);
  }
  /** @type {ReviewRound[]} */
  const rounds = [];
  /** @type {{ record: NonNullable<ReturnType<typeof normalizeCodeReviewPoolRound>>, members: { id: string, verdict: string }[] } | null} */
  let group = null;
  /** @type {{ memberIds: string[] } | null} */
  let pending = null;
  const closeGroup = () => {
    if (!group || !group.members.length) {
      group = null;
      return;
    }
    const verdict = resolvePoolGroupVerdict(group.record, group.members);
    if (verdict) {
      const last = group.members[group.members.length - 1];
      rounds.push({
        id: last.id,
        leafId,
        verdict,
        memberIds: group.members.map((member) => member.id),
        source: 'pool',
        resolvedAt: String(reviews.find((row) => String(row.id) === last.id)?.finishedAt || ''),
      });
    } else if (group.record === currentRecord) {
      // Only the live, unresolved round stays visible as pending.
      pending = { memberIds: group.members.map((member) => member.id) };
    }
    group = null;
  };
  for (const row of reviews) {
    const id = String(row.id);
    const verdict = String(resolveEffectiveCodeReviewReportVerdict(row)).toUpperCase();
    const record = roundByMember.get(id);
    if (!record) {
      closeGroup();
      rounds.push({
        id,
        leafId,
        verdict: /** @type {ReviewRound['verdict']} */ (verdict === 'PASS' || verdict === 'BLOCKED' ? verdict : 'FAIL'),
        memberIds: [id],
        source: 'single',
        resolvedAt: String(row.finishedAt || ''),
      });
      continue;
    }
    if (!group || group.record !== record) {
      closeGroup();
      group = { record, members: [] };
    }
    group.members.push({ id, verdict });
  }
  closeGroup();
  return { rounds, pending };
}

/**
 * Finish-hook evaluation (path 1). Called with the workflow row and the patch
 * `buildCodeReviewWorkflowPatchOnFinish` produced from it (both pre-apply).
 *
 * @param {{
 *   delegation: any,
 *   workflow?: any | null,
 *   patch?: Record<string, unknown> | null,
 *   delegations: any[],
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
 *   workflowBefore?: any | null,
 *   delegations: any[],
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
